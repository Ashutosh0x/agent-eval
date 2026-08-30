/**
 * Ollama, running locally.
 *
 * The odd one out, and usefully so: no credential, a real model-listing API
 * that reports what is actually installed on this machine, and an endpoint
 * that is frequently just not running.
 *
 * That last point is the reason this adapter exists rather than pointing the
 * OpenAI-compatible provider at Ollama's compatibility shim. "Ollama is not
 * running" is the single most common state, and it deserves a specific,
 * actionable message rather than a generic connection error.
 */

import { requestJson } from './http.js';
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

const DEFAULT_BASE = 'http://localhost:11434';

interface ChatResponse {
  model?: string;
  message?: {
    content?: string;
    tool_calls?: { function: { name: string; arguments: unknown } }[];
  };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

function contentText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function images(m: Message): string[] {
  if (typeof m.content === 'string') return [];
  return m.content.filter((p) => p.type === 'image').map((p) => (p as { data: string }).data);
}

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama';

  capabilities(): ProviderCapabilities {
    return {
      streaming: 'supported',
      // Both depend entirely on which model is pulled, and Ollama does not say
      // in /api/tags. Claiming either way would be a guess.
      tools: 'unknown',
      vision: 'unknown',
      structuredOutput: 'supported',
      modelListing: 'supported',
      requiresApiKey: false,
    };
  }

  private base(config: ProviderConfig): string {
    return (config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  async testConnection(config: ProviderConfig): Promise<ConnectionStatus> {
    const base = this.base(config);
    try {
      const models = await this.listModels(config);
      return {
        status: 'connected',
        modelCount: models.length,
        detail:
          models.length === 0
            ? `Connected to ${base}, but no models are installed. Pull one with: ollama pull <model>`
            : `Connected to ${base}.`,
      };
    } catch (e) {
      if (e instanceof ProviderError && (e.category === 'NETWORK_ERROR' || e.category === 'TIMEOUT')) {
        return {
          status: 'unavailable',
          detail: `Could not connect to ${base}. Is Ollama running? Start it with: ollama serve`,
        };
      }
      return { status: 'error', detail: e instanceof ProviderError ? e.message : (e as Error).message };
    }
  }

  /** What is actually installed here — never a curated list. */
  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const { data } = await requestJson<{
      models?: { name: string; size?: number; details?: Record<string, unknown> }[];
    }>(
      `${this.base(config)}/api/tags`,
      { method: 'GET' },
      { provider: this.id, timeoutMs: config.timeoutMs ?? 10_000, maxRetries: 0 },
    );
    return (data.models ?? []).map((m) => ({
      id: m.name,
      provider: this.id,
      metadata: m,
    }));
  }

  async generate(request: ModelRequest, config: ProviderConfig): Promise<ModelResponse> {
    const messages: unknown[] = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    for (const m of request.messages) {
      const imgs = images(m);
      messages.push({
        role: m.role === 'tool' ? 'tool' : m.role,
        content: contentText(m),
        ...(imgs.length ? { images: imgs } : {}),
      });
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      // The normalized interface returns a whole response; streaming is a
      // separate method, so this endpoint must not stream.
      stream: false,
      options: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
        ...(request.stop?.length ? { stop: request.stop } : {}),
      },
    };
    if (request.responseFormat === 'json') body.format = 'json';
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const { data, latencyMs } = await requestJson<ChatResponse>(
      `${this.base(config)}/api/chat`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      {
        provider: this.id,
        model: request.model,
        // Local models on CPU are slow; a cloud-sized timeout would kill
        // legitimate work partway through.
        timeoutMs: request.timeoutMs ?? 300_000,
        ...(request.signal ? { signal: request.signal } : {}),
        maxRetries: 0,
      },
    );

    const toolCalls: ToolCall[] = (data.message?.tool_calls ?? []).map((t, i) => ({
      // Ollama does not issue call ids, so one is synthesised for correlation
      // and marked as such rather than passed off as the model's own.
      toolCallId: `ollama-${i}`,
      name: t.function.name,
      arguments: t.function.arguments,
    }));

    const finishReason: FinishReason =
      toolCalls.length > 0
        ? 'tool_calls'
        : data.done_reason === 'length'
          ? 'length'
          : data.done_reason === 'stop' || !data.done_reason
            ? 'stop'
            : 'unknown';

    const inputTokens = data.prompt_eval_count;
    const outputTokens = data.eval_count;

    return {
      provider: this.id,
      model: data.model ?? request.model,
      text: data.message?.content ?? '',
      toolCalls,
      finishReason,
      usage: {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(inputTokens !== undefined && outputTokens !== undefined
          ? { totalTokens: inputTokens + outputTokens }
          : {}),
      },
      latencyMs,
      providerMetadata: {
        ...(data.total_duration !== undefined ? { totalDurationNs: data.total_duration } : {}),
        toolCallIdsSynthesised: toolCalls.length > 0,
        raw: data,
      },
    };
  }
}

export const ollamaProvider = new OllamaProvider();
