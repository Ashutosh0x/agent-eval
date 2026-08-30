/**
 * Provider-independent model interface.
 *
 * The architectural requirement this exists to satisfy: adding a provider must
 * not touch the run service, the audit service, or the evidence layer. Those
 * operate on the normalized shapes below and never learn a provider's name.
 *
 * And there is no model list anywhere in this file, or in any adapter. A model
 * identifier is a string the caller supplies. When a provider can enumerate
 * models it does so over its own API at call time; when it cannot, the caller
 * types an id and the provider is asked directly. A hardcoded list is wrong
 * within days of any provider shipping something new, and worse, it turns
 * "this model is not in our array" into an error that reads like the provider
 * rejected it.
 */

// ----------------------------------------------------------------- messages

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** Base64 data or a URL, depending on what the provider accepts. */
  data: string;
  mediaType: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  toolCallId: string;
  name: string;
  /** Parsed where the provider returns JSON, raw text where it does not. */
  arguments: unknown;
}

export interface Message {
  role: Role;
  content: string | ContentPart[];
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool messages, linking the result to its call. */
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema. Passed through; adapters reshape the envelope, not this. */
  parameters: Record<string, unknown>;
}

// ------------------------------------------------------------------ request

export interface ModelRequest {
  /** Any identifier the provider accepts. Never validated against a list. */
  model: string;
  messages: Message[];
  system?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  responseFormat?: 'text' | 'json';
  stream?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Carried through to the trajectory. Must never contain credentials. */
  metadata?: Record<string, unknown>;
}

// ----------------------------------------------------------------- response

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Providers that report cached or reasoning tokens separately. */
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'unknown';

export interface ModelResponse {
  provider: string;
  model: string;
  /** The provider's own request id, where it returns one. */
  providerRequestId?: string;
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  latencyMs: number;
  /**
   * Provider fields with no normalized home.
   *
   * Discarding them would lose exactly the detail a reviewer needs when a
   * result is disputed, so anything unrecognised is preserved rather than
   * dropped for tidiness.
   */
  providerMetadata?: Record<string, unknown>;
  warnings?: string[];
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; toolCallId: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; finishReason: FinishReason }
  | { type: 'error'; error: ProviderError };

// ------------------------------------------------------------------- errors

export type ErrorCategory =
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PROVIDER_ERROR'
  | 'CAPABILITY_UNSUPPORTED'
  | 'CONTEXT_LENGTH'
  | 'CONTENT_FILTER'
  | 'NOT_CONFIGURED'
  | 'UNKNOWN';

export class ProviderError extends Error {
  constructor(
    readonly category: ErrorCategory,
    message: string,
    readonly detail: {
      provider: string;
      model?: string;
      httpStatus?: number;
      providerCode?: string;
      providerRequestId?: string;
      /** Seconds, when the provider says how long to wait. */
      retryAfterSeconds?: number;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Safe for an audit entry or an API response. Carries no credentials. */
  toJSON() {
    return { category: this.category, message: this.message, ...this.detail };
  }
}

/**
 * Remove anything that looks like a credential from provider text.
 *
 * Provider errors quote the offending request often enough that echoing one
 * verbatim into a log is a real disclosure path.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|xai|gsk|key)-[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 6)}...redacted`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer ...redacted')
    .replace(/"api[_-]?key"\s*:\s*"[^"]*"/gi, '"api_key":"...redacted"');
}

// ------------------------------------------------------------- capabilities

/** Unknown is a real answer and better than a confident wrong one. */
export type Support = 'supported' | 'unsupported' | 'unknown';

export interface ProviderCapabilities {
  streaming: Support;
  tools: Support;
  vision: Support;
  structuredOutput: Support;
  modelListing: Support;
  /** Whether a credential is needed at all. Ollama does not use one. */
  requiresApiKey: boolean;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  provider: string;
  /** Only what the provider actually reported. */
  contextLength?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  /** Extra headers some deployments require, e.g. an org or project id. */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export type ConnectionStatus =
  | { status: 'connected'; detail?: string; modelCount?: number }
  | { status: 'not_configured'; detail: string }
  | { status: 'authentication_failed'; detail: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'error'; detail: string };

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  capabilities(): ProviderCapabilities;
  /** A real request against the provider. Never returns a canned answer. */
  testConnection(config: ProviderConfig): Promise<ConnectionStatus>;
  /** Only where the provider exposes an enumeration API. */
  listModels?(config: ProviderConfig): Promise<ModelInfo[]>;
  generate(request: ModelRequest, config: ProviderConfig): Promise<ModelResponse>;
  stream?(request: ModelRequest, config: ProviderConfig): AsyncIterable<StreamEvent>;
}

/** Safe configuration metadata for the run manifest. Never the key itself. */
export interface ModelConfigRecord {
  provider: string;
  model: string;
  /** Present for self-hosted or compatible endpoints; identifies the target. */
  baseUrl?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: 'text' | 'json';
  /** Names only. Schemas live with the task definition. */
  toolNames?: string[];
  /** Which stored credential was used, by id — never its value. */
  credentialId?: string;
}
