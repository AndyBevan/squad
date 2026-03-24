import type { SquadAgentSdk, SquadClientEvent, SquadClientEventHandler, SquadClientEventType, SquadGetAuthStatusResponse, SquadGetStatusResponse, SquadModelInfo, SquadSession, SquadSessionConfig } from './types.js';

export interface InternalSessionMetadata {
  sessionId: string;
  startTime: Date;
  modifiedTime: Date;
  summary?: string;
  isRemote: boolean;
  context?: Record<string, unknown>;
}

export interface AgentClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
  createSession(config: SquadSessionConfig): Promise<SquadSession>;
  resumeSession(sessionId: string, config: SquadSessionConfig): Promise<SquadSession>;
  listSessions(): Promise<InternalSessionMetadata[]>;
  deleteSession(sessionId: string): Promise<void>;
  getLastSessionId(): Promise<string | undefined>;
  ping(message?: string): Promise<{ message: string; timestamp: number; protocolVersion?: number }>;
  getStatus(): Promise<SquadGetStatusResponse>;
  getAuthStatus(): Promise<SquadGetAuthStatusResponse>;
  listModels(): Promise<SquadModelInfo[]>;
  on(
    eventTypeOrHandler: SquadClientEventType | SquadClientEventHandler,
    handler?: (event: SquadClientEvent) => void,
  ): () => void;
}

export interface AgentClientFactoryOptions {
  agentSdk: SquadAgentSdk;
  cliPath?: string;
  cliArgs: string[];
  cwd: string;
  port: number;
  useStdio: boolean;
  cliUrl?: string;
  logLevel: "error" | "warning" | "info" | "debug" | "all" | "none";
  env: Record<string, string>;
  githubToken?: string;
  useLoggedInUser?: boolean;
}
