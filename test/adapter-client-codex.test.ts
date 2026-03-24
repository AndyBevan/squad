import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SquadClient } from '../packages/squad-sdk/src/client/index.js';

const codexConstructor = vi.fn();
const runStreamed = vi.fn();
const startThread = vi.fn();
const resumeThread = vi.fn();

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn().mockImplementation((options) => {
    codexConstructor(options);
    return {
      startThread,
      resumeThread,
    };
  }),
}));

describe('SquadClient — Codex agent SDK', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    runStreamed.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-123' };
        yield { type: 'item.started', item: { id: 'item-1', type: 'agent_message', text: '' } };
        yield { type: 'item.updated', item: { id: 'item-1', type: 'agent_message', text: 'hello ' } };
        yield { type: 'item.updated', item: { id: 'item-1', type: 'agent_message', text: 'hello from codex' } };
        yield { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'hello from codex' } };
        yield { type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 2, output_tokens: 7 } };
      })(),
    });

    startThread.mockReturnValue({
      id: null,
      runStreamed,
    });

    resumeThread.mockReturnValue({
      id: 'thread-123',
      runStreamed,
    });
  });

  it('creates Codex-backed sessions and streams a response', async () => {
    const client = new SquadClient({
      agentSdk: 'codex',
      env: process.env as Record<string, string>,
    });

    await client.connect();
    const session = await client.createSession({
      model: 'gpt-5.4-mini',
      workingDirectory: process.cwd(),
      systemMessage: { mode: 'append', content: 'Be terse.' },
    });

    const messages: string[] = [];
    const usage: Array<{ inputTokens: number; outputTokens: number; model: string }> = [];

    session.on('message_delta', (event) => {
      if (typeof event['content'] === 'string') {
        messages.push(event['content']);
      }
    });
    session.on('usage', (event) => {
      usage.push({
        inputTokens: event['inputTokens'] as number,
        outputTokens: event['outputTokens'] as number,
        model: event['model'] as string,
      });
    });

    const result = await session.sendAndWait?.({ prompt: 'Say hello' });

    expect(startThread).toHaveBeenCalledTimes(1);
    expect(runStreamed).toHaveBeenCalledTimes(1);
    expect(codexConstructor).toHaveBeenCalledWith(expect.objectContaining({
      env: process.env,
    }));
    expect(codexConstructor).not.toHaveBeenCalledWith(expect.objectContaining({
      codexPathOverride: expect.anything(),
    }));
    expect(messages).toEqual(['hello ', 'hello from codex']);
    expect(usage).toEqual([{ inputTokens: 11, outputTokens: 7, model: 'gpt-5.4-mini' }]);
    expect(result).toEqual({ content: 'hello from codex' });
    expect(session.sessionId).toBe('thread-123');
    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({
      skipGitRepoCheck: true,
    }));
  });

  it('resumes an existing Codex thread', async () => {
    const client = new SquadClient({
      agentSdk: 'codex',
      cliPath: 'codex',
      env: process.env as Record<string, string>,
    });

    await client.connect();
    const session = await client.resumeSession('thread-123', {
      model: 'gpt-5.4-mini',
      workingDirectory: process.cwd(),
      skipGitRepoCheck: false,
    });

    await session.sendMessage({ prompt: 'Continue' });

    expect(resumeThread).toHaveBeenCalledWith('thread-123', expect.objectContaining({
      model: 'gpt-5.4-mini',
      workingDirectory: process.cwd(),
      skipGitRepoCheck: false,
    }));
  });
});
