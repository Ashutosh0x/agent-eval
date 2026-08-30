/**
 * Google Gemini (generateLanguageModel v1beta).
 *
 * Its own adapter because almost nothing lines up: roles are `user` and
 * `model`, messages are `contents` with `parts`, the system prompt is
 * `systemInstruction`, sampling lives under `generationConfig`, the key goes
 * in a query parameter, and the model id is part of the path.
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

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface Part {
  text?: string;
  functionCall?: { name: string; args: unknown };
  inlineData?: { mimeType: string; data: string };
}

interface GenerateResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
}

function mapFinish(raw: string | undefined): FinishReason {
  switch (raw) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    default:
      return raw ? 'unknown' : 'stop';
  }
}

function toParts(m: Message): Part[] {
  const parts: Part[] = [];
  if (typeof m.content === 'string') {
    if (m.content) parts.push({ text: m.content });
  } else {
    for (const p of m.content) {
      parts.push(
        p.type === 'text'
          ? { text: p.text }
          : { inlineData: { mimeType: p.mediaType, data: p.data } },
      );
    }
  }
  for (const t of m.toolCalls ?? []) {
    parts.push({ functionCall: { name: t.name, args: t.arguments } });
  }
  return parts;
}

export class GoogleProvider implements ModelProvider {
  readonly id = 'google';
  readonly displayName = 'Google Gemini';

  capabilities(): ProviderCapabilities {
    return {
      streaming: 'supported',
      tools: 'supported',
      vision: 'unknown',
      structuredOutput: 'supported',
      modelListing: 'supported',
      requiresApiKey: true,
    };
  }

  private base(config: ProviderConfig): string {
    return (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  async testConnection(config: ProviderConfig): Promise<ConnectionStatus> {
    if (!config.apiKey) {
      return { status: 'not_configured', detail: 'No API key configured for Google Gemini.' };
    }
    try {
      const models = await this.listModels(config);
      return { status: 'connected', modelCount: models.length };
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.category === 'AUTHENTICATION_ERROR' || e.category === 'AUTHORIZATION_ERROR')
          return { status: 'authentication_failed', detail: e.message };
        if (e.category === 'NETWORK_ERROR' || e.category === 'TIMEOUT')
          return { status: 'unavailable', detail: e.message };
        return { status: 'error', detail: e.message };
      }
      return { status: 'error', detail: (e as Error).message };
    }
  }

  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const key = requireApiKey(this.id, config.apiKey);
    const { data } = await requestJson<{
      models?: { name: string; displayName?: string; inputTokenLimit?: number }[];
    }>(
      `${this.base(config)}/models?key=${encodeURIComponent(key)}`,
      { method: 'GET' },
      { provider: this.id, timeoutMs: config.timeoutMs ?? 15_000, maxRetries: 1 },
    );
    return (data.models ?? []).map((m) => ({
      // The API returns "models/<id>"; callers name the bare id.
      id: m.name.replace(/^models\//, ''),
      provider: this.id,
      ...(m.displayName ? { displayName: m.displayName } : {}),
      ...(m.inputTokenLimit !== undefined ? { contextLength: m.inputTokenLimit } : {}),
      metadata: m,
    }));
  }

  async generate(request: ModelRequest, config: ProviderConfig): Promise<ModelResponse> {
    const key = requireApiKey(this.id, config.apiKey);

    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        // Gemini calls the assistant "model", and has no distinct tool role.
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: toParts(m),
      }));

    const body: Record<string, unknown> = { contents };

    const inlineSystem = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    const system = [request.system, inlineSystem].filter(Boolean).join('\n');
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.topP !== undefined) generationConfig.topP = request.topP;
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    if (request.stop?.length) generationConfig.stopSequences = request.stop;
    if (request.responseFormat === 'json') generationConfig.responseMimeType = 'application/json';
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const model = request.model.replace(/^models\//, '');
    const { data, requestId, latencyMs } = await requestJson<GenerateResponse>(
      `${this.base(config)}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      {
        provider: this.id,
        model,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const text = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        // Gemini does not issue call ids either.
        toolCallId: `google-${i}`,
        name: p.functionCall!.name,
        arguments: p.functionCall!.args,
      }));

    return {
      provider: this.id,
      model: data.modelVersion ?? model,
      ...(data.responseId ?? requestId ? { providerRequestId: data.responseId ?? requestId } : {}),
      text,
      toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : mapFinish(candidate?.finishReason),
      usage: {
        ...(data.usageMetadata?.promptTokenCount !== undefined
          ? { inputTokens: data.usageMetadata.promptTokenCount }
          : {}),
        ...(data.usageMetadata?.candidatesTokenCount !== undefined
          ? { outputTokens: data.usageMetadata.candidatesTokenCount }
          : {}),
        ...(data.usageMetadata?.totalTokenCount !== undefined
          ? { totalTokens: data.usageMetadata.totalTokenCount }
          : {}),
        ...(data.usageMetadata?.cachedContentTokenCount !== undefined
          ? { cachedInputTokens: data.usageMetadata.cachedContentTokenCount }
          : {}),
      },
      latencyMs,
      providerMetadata: { toolCallIdsSynthesised: toolCalls.length > 0, raw: data },
    };
  }
}

export const googleProvider = new GoogleProvider();
