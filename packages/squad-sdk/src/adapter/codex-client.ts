import { randomUUID } from 'node:crypto';
import { Codex } from '@openai/codex-sdk';
import type { Input as CodexInput, Thread as CodexThread, ThreadEvent as CodexThreadEvent, ThreadOptions as CodexThreadOptions } from '@openai/codex-sdk';
import type { AgentClient, AgentClientFactoryOptions, InternalSessionMetadata } from './agent-client-types.js';
import type {
  SquadClientEvent,
  SquadClientEventHandler,
  SquadClientEventType,
  SquadGetAuthStatusResponse,
  SquadGetStatusResponse,
  SquadMessageOptions,
  SquadModelInfo,
  SquadSession,
  SquadSessionConfig,
  SquadSessionEvent,
  SquadSessionEventHandler,
  SquadSessionEventType,
} from './types.js';

class CodexSessionAdapter implements SquadSession {
  private readonly listeners = new Map<string, Set<SquadSessionEventHandler>>();
  private readonly history: Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }> = [];
  private readonly systemPrompt: string | undefined;
  private readonly itemSnapshots = new Map<string, string>();
  private currentAbortController: AbortController | null = null;
  private bootstrapPending = true;
  private closed = false;

  constructor(
    private readonly owner: CodexClientAdapter,
    private readonly thread: CodexThread,
    private readonly model: string | undefined,
    sessionId: string,
    systemPrompt?: string,
  ) {
    this.sessionId = sessionId;
    this.systemPrompt = systemPrompt?.trim() ? systemPrompt : undefined;
  }

  sessionId: string;

  async sendMessage(options: SquadMessageOptions): Promise<void> {
    await this.runTurn(options);
  }

  async sendAndWait(options: SquadMessageOptions): Promise<unknown> {
    return await this.runTurn(options);
  }

  async abort(): Promise<void> {
    this.currentAbortController?.abort();
  }

  async getMessages(): Promise<unknown[]> {
    return [...this.history];
  }

  on(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(handler);
  }

  off(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    this.listeners.get(eventType)?.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.currentAbortController?.abort();
    this.owner.unregisterSession(this.sessionId);
  }

  updateSessionId(nextSessionId: string): void {
    this.sessionId = nextSessionId;
  }

  private emit(event: SquadSessionEvent): void {
    for (const handler of this.listeners.get(event.type) ?? []) {
      handler(event);
    }
  }

  private buildInput(options: SquadMessageOptions): CodexInput {
    const attachmentLines = (options.attachments ?? []).map((attachment) => {
      if (attachment.type === 'selection') {
        const selection = attachment.selection
          ? ` lines ${attachment.selection.start.line + 1}-${attachment.selection.end.line + 1}`
          : '';
        return `Selection: ${attachment.displayName}${selection}\n${attachment.text ?? ''}`.trim();
      }
      if (attachment.type === 'file') {
        return `File attachment: ${attachment.displayName ?? attachment.path}\nPath: ${attachment.path}`;
      }
      return `Directory attachment: ${attachment.displayName ?? attachment.path}\nPath: ${attachment.path}`;
    });

    const promptSections: string[] = [];
    if (this.bootstrapPending && this.systemPrompt) {
      promptSections.push(`System instructions:\n${this.systemPrompt}`);
    }
    promptSections.push(options.prompt);
    if (attachmentLines.length > 0) {
      promptSections.push(`Attachments:\n${attachmentLines.join('\n\n')}`);
    }

    return promptSections.join('\n\n').trim();
  }

  private async runTurn(options: SquadMessageOptions): Promise<{ content: string }> {
    if (this.closed) {
      throw new Error('Session is closed');
    }

    const input = this.buildInput(options);
    const startedAt = new Date();
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    this.history.push({ role: 'user', content: options.prompt, timestamp: startedAt });

    let finalResponse = '';
    let failed: Error | null = null;

    this.emit({ type: 'turn_start' });

    try {
      const { events } = await this.thread.runStreamed(input, { signal: abortController.signal });

      for await (const event of events) {
        this.handleEvent(event, (nextId) => {
          this.owner.replaceSessionId(this.sessionId, nextId, this);
          this.sessionId = nextId;
        }, (message) => {
          finalResponse = message;
        });
      }

      this.bootstrapPending = false;
      this.owner.touchSession(this.sessionId, finalResponse || options.prompt);
      if (finalResponse) {
        this.history.push({ role: 'assistant', content: finalResponse, timestamp: new Date() });
      }

      this.emit({ type: 'turn_end' });
      this.emit({ type: 'idle' });
      return { content: finalResponse };
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error));
      this.emit({ type: 'error', message: failed.message });
      this.emit({ type: 'turn_end' });
      this.emit({ type: 'idle' });
      throw failed;
    } finally {
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
      if (failed) {
        this.owner.touchSession(this.sessionId, failed.message);
      }
    }
  }

  private handleEvent(
    event: CodexThreadEvent,
    onThreadStarted: (threadId: string) => void,
    onResponse: (message: string) => void,
  ): void {
    switch (event.type) {
      case 'thread.started':
        onThreadStarted(event.thread_id);
        break;
      case 'item.started':
      case 'item.updated':
        this.handleStreamedItemEvent(event.item);
        break;
      case 'item.completed':
        this.handleStreamedItemEvent(event.item);
        if (event.item.type === 'agent_message') {
          onResponse(event.item.text);
          this.emit({ type: 'message', content: event.item.text });
        } else if (event.item.type === 'reasoning') {
          this.emit({ type: 'reasoning', content: event.item.text });
        }
        break;
      case 'turn.completed':
        this.emit({
          type: 'usage',
          model: this.model ?? 'unknown',
          inputTokens: event.usage.input_tokens,
          outputTokens: event.usage.output_tokens,
          cachedInputTokens: event.usage.cached_input_tokens,
        });
        break;
      case 'turn.failed':
        throw new Error(event.error.message);
      case 'error':
        throw new Error(event.message);
      default:
        break;
    }
  }

  private handleStreamedItemEvent(item: Extract<CodexThreadEvent, { item: unknown }>['item']): void {
    if (item.type !== 'agent_message' && item.type !== 'reasoning') {
      return;
    }

    const previous = this.itemSnapshots.get(item.id) ?? '';
    const next = item.text;
    this.itemSnapshots.set(item.id, next);

    if (!next.startsWith(previous)) {
      if (item.type === 'agent_message') {
        this.emit({ type: 'message_delta', content: next, deltaContent: next });
      } else {
        this.emit({ type: 'reasoning_delta', content: next, deltaContent: next });
      }
      return;
    }

    const delta = next.slice(previous.length);
    if (!delta) {
      return;
    }

    if (item.type === 'agent_message') {
      this.emit({ type: 'message_delta', content: next, deltaContent: delta });
    } else {
      this.emit({ type: 'reasoning_delta', content: next, deltaContent: delta });
    }
  }
}

class CodexClientAdapter implements AgentClient {
  private readonly codex: Codex;
  private readonly sessions = new Map<string, { session: CodexSessionAdapter; metadata: InternalSessionMetadata }>();
  private readonly lifecycleHandlers = new Map<SquadClientEventHandler, SquadClientEventType | null>();
  private connected = false;
  private lastSessionId: string | undefined;

  constructor(
    private readonly options: {
      cliPath?: string;
      cwd: string;
      env: Record<string, string>;
    },
  ) {
    this.codex = options.cliPath
      ? new Codex({ codexPathOverride: options.cliPath, env: options.env })
      : new Codex({ env: options.env });
  }

  async start(): Promise<void> {
    this.connected = true;
  }

  async stop(): Promise<Error[]> {
    this.connected = false;
    return [];
  }

  async forceStop(): Promise<void> {
    this.connected = false;
  }

  async createSession(config: SquadSessionConfig): Promise<SquadSession> {
    this.ensureConnected();
    const sessionId = randomUUID();
    const thread = this.codex.startThread(this.toThreadOptions(config));
    const session = new CodexSessionAdapter(this, thread, config.model, sessionId, config.systemMessage?.content);
    this.registerSession(sessionId, session);
    return session;
  }

  async resumeSession(sessionId: string, config: SquadSessionConfig): Promise<SquadSession> {
    this.ensureConnected();
    const thread = this.codex.resumeThread(sessionId, this.toThreadOptions(config));
    const session = new CodexSessionAdapter(this, thread, config.model, sessionId, config.systemMessage?.content);
    this.registerSession(sessionId, session);
    return session;
  }

  async listSessions(): Promise<InternalSessionMetadata[]> {
    this.ensureConnected();
    return Array.from(this.sessions.values(), ({ metadata }) => ({ ...metadata }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.ensureConnected();
    this.unregisterSession(sessionId);
    this.emitLifecycle({ type: 'session.deleted', sessionId });
  }

  async getLastSessionId(): Promise<string | undefined> {
    this.ensureConnected();
    return this.lastSessionId;
  }

  async ping(message?: string): Promise<{ message: string; timestamp: number; protocolVersion?: number }> {
    this.ensureConnected();
    return { message: message ?? 'pong', timestamp: Date.now(), protocolVersion: 1 };
  }

  async getStatus(): Promise<SquadGetStatusResponse> {
    this.ensureConnected();
    return { version: 'codex-sdk', protocolVersion: 1 };
  }

  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    this.ensureConnected();
    return {
      isAuthenticated: false,
      authType: 'token',
      statusMessage: 'Codex SDK does not currently expose authentication state through Squad.',
    };
  }

  async listModels(): Promise<SquadModelInfo[]> {
    this.ensureConnected();
    return [];
  }

  on(
    eventTypeOrHandler: SquadClientEventType | SquadClientEventHandler,
    handler?: (event: SquadClientEvent) => void,
  ): () => void {
    const effectiveHandler = typeof eventTypeOrHandler === 'function' ? eventTypeOrHandler : handler;
    const filter = typeof eventTypeOrHandler === 'string' ? eventTypeOrHandler : null;
    if (!effectiveHandler) {
      return () => {};
    }
    this.lifecycleHandlers.set(effectiveHandler, filter);
    return () => {
      this.lifecycleHandlers.delete(effectiveHandler);
    };
  }

  replaceSessionId(previousId: string, nextId: string, session: CodexSessionAdapter): void {
    if (!nextId || previousId === nextId) return;
    const current = this.sessions.get(previousId);
    if (!current || current.session !== session) return;
    this.sessions.delete(previousId);
    current.metadata.sessionId = nextId;
    current.metadata.modifiedTime = new Date();
    this.sessions.set(nextId, current);
    session.updateSessionId(nextId);
    this.lastSessionId = nextId;
    this.emitLifecycle({ type: 'session.updated', sessionId: nextId, metadata: this.toClientMetadata(current.metadata) });
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  touchSession(sessionId: string, summary: string): void {
    const current = this.sessions.get(sessionId);
    if (!current) return;
    current.metadata.modifiedTime = new Date();
    current.metadata.summary = summary.slice(0, 200);
    this.lastSessionId = sessionId;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('Client not connected');
    }
  }

  private registerSession(sessionId: string, session: CodexSessionAdapter): void {
    const metadata: InternalSessionMetadata = {
      sessionId,
      startTime: new Date(),
      modifiedTime: new Date(),
      summary: undefined,
      isRemote: false,
      context: { agentSdk: 'codex' },
    };
    this.sessions.set(sessionId, { session, metadata });
    this.lastSessionId = sessionId;
    this.emitLifecycle({ type: 'session.created', sessionId, metadata: this.toClientMetadata(metadata) });
  }

  private emitLifecycle(event: SquadClientEvent): void {
    for (const [handler, filter] of this.lifecycleHandlers) {
      if (filter && filter !== event.type) continue;
      handler(event);
    }
  }

  private toClientMetadata(metadata: InternalSessionMetadata): SquadClientEvent['metadata'] {
    return {
      startTime: metadata.startTime.toISOString(),
      modifiedTime: metadata.modifiedTime.toISOString(),
      summary: metadata.summary,
    };
  }

  private toThreadOptions(config: SquadSessionConfig): CodexThreadOptions {
    return {
      model: config.model,
      workingDirectory: config.workingDirectory ?? this.options.cwd,
      sandboxMode: 'workspace-write',
      approvalPolicy: config.onPermissionRequest ? 'on-request' : 'never',
      skipGitRepoCheck: config.skipGitRepoCheck ?? true,
      modelReasoningEffort: config.reasoningEffort,
    };
  }
}

export function createCodexClient(options: AgentClientFactoryOptions): AgentClient {
  return new CodexClientAdapter({
    cliPath: options.cliPath,
    cwd: options.cwd,
    env: options.env,
  });
}
