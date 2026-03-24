import type { AgentClient, AgentClientFactoryOptions } from './agent-client-types.js';

export class SquadAgentClientFactory {
  static create(
    options: AgentClientFactoryOptions,
    creators: {
      createCopilotClient: (options: AgentClientFactoryOptions) => AgentClient;
      createCodexClient: (options: AgentClientFactoryOptions) => AgentClient;
    },
  ): AgentClient {
    switch (options.agentSdk) {
      case 'codex':
        return creators.createCodexClient(options);
      case 'copilot':
      default:
        return creators.createCopilotClient(options);
    }
  }
}
