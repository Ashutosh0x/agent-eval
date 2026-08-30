/**
 * Anthropic Messages API.
 *
 * Not OpenAI-compatible in three ways that matter, which is why this is its
 * own adapter rather than a base-URL swap:
 *
 *   the system prompt is a top-level field, not a message
 *   authentication is x-api-key plus an anthropic-version header, not a bearer
 *   content is always a block array, and tool use is a block type
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
  type ToolCall,
} from './types.js';

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
/** Pinned: the API is versioned by header, and drifting is a breaking change. */
const API_VERSION = '2023-06-01';

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface MessagesResponse {
  id?: string;
  model?: string;
  content?: Block[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function mapStopReason(raw: string | undefined): FinishReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return raw ? 'unknown' : 'stop';
  }
}

function toBlocks(m: Message): unknown {
  if (m.role === 'tool') {
    return [
      {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      },
    ];
  }
  const blocks: unknown[] = [];
  if (typeof m.content === 'string') {
    if (m.content) blocks.push({ type: 'text', text: m.content });
  } else {
    for (const p of m.content) {
      blocks.push(
        p.type === 'text'
          ? { type: 'text', text: p.text }
          : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } },
      );
    }
  }
  for (const t of m.toolCalls ?? []) {
    blocks.push({ type: 'tool_use', id: t.toolCallId, name: t.name, input: t.arguments });
  }
  return blocks;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';

  capabilities(): ProviderCapabilities {
    return {
      streaming: 'supported',
      tools: 'supported',
      vision: 'unknown',
      structuredOutput: 'unknown',
      modelListing: 'supported',
      requiresApiKey: true,
    };
  }

  private headers(config: ProviderConfig): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': requireApiKey(this.id, config.apiKey),
      'anthropic-version': API_VERSION,
      ...config.headers,
    };
  }

  private base(config: ProviderConfig): string {
    return (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  async testConnection(config: ProviderConfig): Promise<ConnectionStatus> {
    if (!config.apiKey) {
      return { status: 'not_configured', detail: 'No API key configured for Anthropic.' };
    }
    try {
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
    const { data } = await requestJson<{ data?: { id: string; display_name?: string }[] }>(
      `${this.base(config)}/models`,
      { method: 'GET', headers: this.headers(config) },
      { provider: this.id, timeoutMs: config.timeoutMs ?? 15_000, maxRetries: 1 },
    );
    return (data.data ?? []).map((m) => ({
      id: m.id,
      provider: this.id,
      ...(m.display_name ? { displayName: m.display_name } : {}),
      metadata: m,
    }));
  }

  async generate(request: ModelRequest, config: ProviderConfig): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      // Required by the API. A caller who omits it still gets a valid request
      // rather than a 400 they have to decode.
      max_tokens: request.maxTokens ?? 4096,
      messages: request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: toBlocks(m) })),
    };

    // System is top-level here, and a system message inside the array is
    // ignored by the API — so fold both sources into the field.
    const inlineSystem = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    const system = [request.system, inlineSystem].filter(Boolean).join('\n');
    if (system) body.system = system;

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stop?.length) body.stop_sequences = request.stop;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      if (request.toolChoice) {
        body.tool_choice =
          typeof request.toolChoice === 'object'
            ? { type: 'tool', name: request.toolChoice.name }
            : request.toolChoice === 'required'
              ? { type: 'any' }
              : { type: request.toolChoice };
      }
    }

    const { data, requestId, latencyMs } = await requestJson<MessagesResponse>(
      `${this.base(config)}/messages`,
      { method: 'POST', headers: this.headers(config), body: JSON.stringify(body) },
      {
        provider: this.id,
        model: request.model,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    const blocks = data.content ?? [];
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ toolCallId: b.id ?? '', name: b.name ?? '', arguments: b.input }));

    const inputTokens = data.usage?.input_tokens;
    const outputTokens = data.usage?.output_tokens;

    return {
      provider: this.id,
      model: data.model ?? request.model,
      ...(data.id ?? requestId ? { providerRequestId: data.id ?? requestId } : {}),
      text,
      toolCalls,
      finishReason: mapStopReason(data.stop_reason),
      usage: {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(inputTokens !== undefined && outputTokens !== undefined
          ? { totalTokens: inputTokens + outputTokens }
          : {}),
        ...(data.usage?.cache_read_input_tokens !== undefined
          ? { cachedInputTokens: data.usage.cache_read_input_tokens }
          : {}),
      },
      latencyMs,
      providerMetadata: { raw: data },
    };
  }
}

export const anthropicProvider = new AnthropicProvider();
