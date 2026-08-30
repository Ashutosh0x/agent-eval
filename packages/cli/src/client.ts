/**
 * The CLI's connection to the control plane.
 *
 * Every command previously built its own client with
 * `new AgentEvalClient('http://localhost:3000', 'mock-api-key')` — the wrong
 * port, and a literal placeholder where the credential goes. Nothing worked,
 * and the failure looked like a network problem rather than a missing
 * configuration.
 *
 * Configuration is read from the environment, and its absence is an error with
 * instructions rather than a default that fails later and less clearly.
 */

import { AgentEvalClient } from '@agent-eval/sdk';

const DEFAULT_URL = 'http://127.0.0.1:8080';

export function createClient(): AgentEvalClient {
  const apiKey = process.env.AGENT_EVAL_API_KEY;
  if (!apiKey) {
    throw new CliError(
      'No credential configured.\n' +
        '  Set AGENT_EVAL_API_KEY to an API key (ae_live_…) created in the dashboard\n' +
        '  under Settings > API keys, or to a development token for local work.\n' +
        `  Set AGENT_EVAL_URL if the control plane is not at ${DEFAULT_URL}.`,
    );
  }
  return new AgentEvalClient({
    baseUrl: process.env.AGENT_EVAL_URL ?? DEFAULT_URL,
    apiKey,
  });
}

/** An error whose message is meant to be read, not stack-traced. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
