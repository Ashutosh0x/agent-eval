/**
 * OpenAI-compatible chat completions.
 *
 * Several providers expose this wire format, so one transport serves them all
 * while each keeps a distinct provider identity — the identity matters for
 * credentials, capabilities, error attribution and the audit record, even
 * where the request body is identical.
 *
 * The `custom` instance is the point of the whole exercise: a base URL, a key
 * and a model id are enough to use a provider this codebase has never heard
 * of, with no code change and no release.
 */

import { requestJson, requireApiKey } from './http.js';
import {
  ProviderError,
  type ConnectionStatus,
  type FinishReason,
  type Message,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderCapabilities,
  type ProviderConfig,
  type Support,
  type ToolCall,
} from './types.js';

interface ChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  };
  finish_reason?: string;
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function mapFinishReason(raw: string | undefined): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return raw ? 'unknown' : 'stop';
  }
}

function toWireMessages(request: ModelRequest): unknown[] {
  const out: unknown[] = [];
  if (request.system) out.push({ role: 'system', content: request.system });

  for (const m of request.messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: contentToText(m) });
      continue;
    }
    if (m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: contentToText(m) || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.toolCallId,
          type: 'function',
          function: {
            name: t.name,
            arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments),
          },
        })),
      });
      continue;
    }
    if (Array.isArray(m.content)) {
      out.push({
        role: m.role,
        content: m.content.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } },
        ),
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function contentToText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function parseToolCalls(choice: ChatChoice | undefined): ToolCall[] {
  return (choice?.message?.tool_calls ?? []).map((t) => {
    let args: unknown = t.function.arguments;
    try {
      args = JSON.parse(t.function.arguments);
    } catch {
      // Providers occasionally emit malformed JSON. Keeping the raw string is
      // more useful than throwing away what the model actually produced.
    }
    return { toolCallId: t.id, name: t.function.name, arguments: args };
  });
}

export interface OpenAICompatibleOptions {
  id: string;
  displayName: string;
  defaultBaseUrl?: string;
  capabilities?: Partial<ProviderCapabilities>;
  /** Extra headers a provider needs beyond the bearer token. */
  extraHeaders?: (config: ProviderConfig) => Record<string, string>;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: 'supported',
      tools: 'supported',
      // Vision varies per model, and the provider does not say which. Claiming
      // support for every model would be false; claiming none would block a
      // legitimate request. Unknown is the accurate answer.
      vision: 'unknown',
      structuredOutput: 'unknown',
      modelListing: 'supported',
      requiresApiKey: true,
      ...this.options.capabilities,
    };
  }

  private baseUrl(config: ProviderConfig): string {
    const url = config.baseUrl ?? this.options.defaultBaseUrl;
    if (!url) {
      throw new ProviderError('NOT_CONFIGURED', `${this.displayName} needs a base URL.`, {
        provider: this.id,
        retryable: false,
      });
    }
    return url.replace(/\/+$/, '');
  }

  private headers(config: ProviderConfig): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${requireApiKey(this.id, config.apiKey)}`,
      ...this.options.extraHeaders?.(config),
      ...config.headers,
    };
  }

  async testConnection(config: ProviderConfig): Promise<ConnectionStatus> {
    if (!config.apiKey) {
      return { status: 'not_configured', detail: `No API key configured for ${this.displayName}.` };
    }
    try {
      // Model listing is the cheap credential check: it authenticates without
      // running a completion the caller would be billed for.
      const models = await this.listModels(config);
      return { status: 'connected', modelCount: models.length };
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.category === 'AUTHENTICATION_ERROR')
          return { status: 'authentication_failed', detail: e.message };
        if (e.category === 'NETWORK_ERROR' || e.category === 'TIMEOUT')
          return { status: 'unavailable', detail: e.message };
        return { status: 'error', detail: e.message };
      }
      return { status: 'error', detail: (e as Error).message };
    }
  }

  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const { data } = await requestJson<{ data?: { id: string; [k: string]: unknown }[] }>(
      `${this.baseUrl(config)}/models`,
      { method: 'GET', headers: this.headers(config) },
      { provider: this.id, timeoutMs: config.timeoutMs ?? 15_000, maxRetries: 1 },
    );
    return (data.data ?? []).map((m) => ({
      id: m.id,
      provider: this.id,
      metadata: m,
    }));
  }

  async generate(request: ModelRequest, config: ProviderConfig): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toWireMessages(request),
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.stop?.length) body.stop = request.stop;
    if (request.responseFormat === 'json') body.response_format = { type: 'json_object' };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (request.toolChoice) {
        body.tool_choice =
          typeof request.toolChoice === 'object'
            ? { type: 'function', function: { name: request.toolChoice.name } }
            : request.toolChoice;
      }
    }

    const { data, requestId, latencyMs } = await requestJson<ChatResponse>(
      `${this.baseUrl(config)}/chat/completions`,
      { method: 'POST', headers: this.headers(config), body: JSON.stringify(body) },
      {
        provider: this.id,
        model: request.model,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    const choice = data.choices?.[0];
    return {
      provider: this.id,
      model: data.model ?? request.model,
      ...(data.id ?? requestId ? { providerRequestId: data.id ?? requestId } : {}),
      text: choice?.message?.content ?? '',
      toolCalls: parseToolCalls(choice),
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: {
        ...(data.usage?.prompt_tokens !== undefined ? { inputTokens: data.usage.prompt_tokens } : {}),
        ...(data.usage?.completion_tokens !== undefined
          ? { outputTokens: data.usage.completion_tokens }
          : {}),
        ...(data.usage?.total_tokens !== undefined ? { totalTokens: data.usage.total_tokens } : {}),
        ...(data.usage?.prompt_tokens_details?.cached_tokens !== undefined
          ? { cachedInputTokens: data.usage.prompt_tokens_details.cached_tokens }
          : {}),
        ...(data.usage?.completion_tokens_details?.reasoning_tokens !== undefined
          ? { reasoningTokens: data.usage.completion_tokens_details.reasoning_tokens }
          : {}),
      },
      latencyMs,
      providerMetadata: { raw: data },
    };
  }
}

const unknownVision: Partial<ProviderCapabilities> = { vision: 'unknown' as Support };

/**
 * Providers that speak this dialect.
 *
 * Each keeps its own id and default endpoint. None carries a model list — the
 * `/models` call above answers that at runtime, and a caller may always name a
 * model the provider has not enumerated.
 */
export const openaiProvider = new OpenAICompatibleProvider({
  id: 'openai',
  displayName: 'OpenAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  capabilities: { vision: 'unknown', structuredOutput: 'supported' },
});

export const xaiProvider = new OpenAICompatibleProvider({
  id: 'xai',
  displayName: 'xAI',
  defaultBaseUrl: 'https://api.x.ai/v1',
  capabilities: unknownVision,
});

export const deepseekProvider = new OpenAICompatibleProvider({
  id: 'deepseek',
  displayName: 'DeepSeek',
  defaultBaseUrl: 'https://api.deepseek.com/v1',
  capabilities: { vision: 'unsupported' },
});

export const mistralProvider = new OpenAICompatibleProvider({
  id: 'mistral',
  displayName: 'Mistral',
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  capabilities: unknownVision,
});

export const minimaxProvider = new OpenAICompatibleProvider({
  id: 'minimax',
  displayName: 'MiniMax',
  defaultBaseUrl: 'https://api.minimax.chat/v1',
  capabilities: { modelListing: 'unknown', vision: 'unknown' },
});

/** Any endpoint speaking this dialect. Base URL is supplied by the caller. */
export const openaiCompatibleProvider = new OpenAICompatibleProvider({
  id: 'openai-compatible',
  displayName: 'OpenAI-compatible',
  capabilities: { modelListing: 'unknown', vision: 'unknown', structuredOutput: 'unknown' },
});
