/**
 * Provider contract suite.
 *
 * Every adapter is checked against the same expectations, so adding a
 * provider is a matter of passing this file rather than hoping the new
 * adapter behaves like the others.
 *
 * Fixtures live here and nowhere else. Production must never see a canned
 * model response, so `fetch` is stubbed inside these tests and the adapters
 * carry no test mode of their own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicProvider } from '../../providers/anthropic.js';
import { googleProvider } from '../../providers/google.js';
import { nimProvider, tensorRtLlmProvider, vllmProvider } from '../../providers/local-runtimes.js';
import { ollamaProvider } from '../../providers/ollama.js';
import {
  deepseekProvider,
  mistralProvider,
  openaiCompatibleProvider,
  openaiProvider,
  xaiProvider,
  minimaxProvider,
} from '../../providers/openai-compatible.js';
import { ProviderRegistry, providerRegistry, resolveConfig } from '../../providers/registry.js';
import { ProviderError, redact, type ModelProvider } from '../../providers/types.js';

const ALL: ModelProvider[] = [
  openaiProvider,
  anthropicProvider,
  xaiProvider,
  googleProvider,
  deepseekProvider,
  mistralProvider,
  minimaxProvider,
  ollamaProvider,
  // Local inference runtimes. They speak the OpenAI protocol, so they belong
  // in the same contract battery as everything else that does.
  vllmProvider,
  tensorRtLlmProvider,
  nimProvider,
  openaiCompatibleProvider,
];

/** Canned wire responses, shaped like each provider's real API. */
const WIRE = {
  openaiLike: {
    id: 'chatcmpl-x',
    model: 'some-model',
    choices: [
      {
        message: {
          content: 'hello',
          tool_calls: [
            { id: 'call_1', function: { name: 'lookup', arguments: '{"q":"a"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
  },
  anthropic: {
    id: 'msg_1',
    model: 'some-model',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'a' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 11, output_tokens: 5 },
  },
  google: {
    candidates: [
      {
        content: { parts: [{ text: 'hello' }, { functionCall: { name: 'lookup', args: { q: 'a' } } }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, totalTokenCount: 16 },
    modelVersion: 'some-model',
  },
  ollama: {
    model: 'some-model',
    message: { content: 'hello', tool_calls: [{ function: { name: 'lookup', arguments: { q: 'a' } } }] },
    done_reason: 'stop',
    prompt_eval_count: 11,
    eval_count: 5,
  },
};

function wireFor(id: string): unknown {
  if (id === 'anthropic') return WIRE.anthropic;
  if (id === 'google') return WIRE.google;
  if (id === 'ollama') return WIRE.ollama;
  return WIRE.openaiLike;
}

function ok(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fail(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const CONFIG = { apiKey: 'sk-test-not-a-real-key', baseUrl: 'https://example.test/v1' };
const REQUEST = { model: 'any-model-id', messages: [{ role: 'user' as const, content: 'hi' }] };

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe.each(ALL.map((p) => [p.id, p] as const))('contract: %s', (_id, provider) => {
  it('reports capabilities without claiming false certainty', () => {
    const caps = provider.capabilities();
    for (const v of [caps.streaming, caps.tools, caps.vision, caps.structuredOutput, caps.modelListing]) {
      expect(['supported', 'unsupported', 'unknown']).toContain(v);
    }
    expect(typeof caps.requiresApiKey).toBe('boolean');
  });

  it('normalizes a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(wireFor(provider.id))));
    const res = await provider.generate(REQUEST, CONFIG);

    expect(res.provider).toBe(provider.id);
    expect(res.text).toBe('hello');
    expect(res.usage.inputTokens).toBe(11);
    expect(res.usage.outputTokens).toBe(5);
    expect(res.usage.totalTokens).toBe(16);
    expect(typeof res.latencyMs).toBe('number');
    // Provider detail is preserved rather than discarded for tidiness.
    expect(res.providerMetadata).toBeDefined();
  });

  it('normalizes tool calls into a common shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(wireFor(provider.id))));
    const res = await provider.generate({ ...REQUEST, tools: [{ name: 'lookup', parameters: {} }] }, CONFIG);

    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]!.name).toBe('lookup');
    expect(res.toolCalls[0]!.toolCallId).toBeTruthy();
    expect(res.toolCalls[0]!.arguments).toEqual({ q: 'a' });
  });

  it('maps 401 to AUTHENTICATION_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(401, { error: { message: 'bad key' } })));
    await expect(provider.generate(REQUEST, CONFIG)).rejects.toMatchObject({
      category: 'AUTHENTICATION_ERROR',
    });
  });

  it('maps 404 to MODEL_NOT_FOUND', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(404, { error: { message: 'no such model' } })));
    await expect(provider.generate(REQUEST, CONFIG)).rejects.toMatchObject({
      category: 'MODEL_NOT_FOUND',
    });
  });

  it('maps 429 to RATE_LIMITED and keeps retry-after', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fail(429, { error: { message: 'slow down' } }, { 'retry-after': '3' })),
    );
    try {
      await provider.generate({ ...REQUEST, timeoutMs: 500 }, { ...CONFIG });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ProviderError;
      expect(err.category).toBe('RATE_LIMITED');
      expect(err.detail.retryAfterSeconds).toBe(3);
      expect(err.detail.retryable).toBe(true);
    }
  }, 20_000);

  it('surfaces a context-length rejection distinctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fail(400, { error: { message: 'maximum context length exceeded' } })),
    );
    await expect(provider.generate(REQUEST, CONFIG)).rejects.toMatchObject({
      category: 'CONTEXT_LENGTH',
    });
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_u: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      ),
    );
    const promise = provider.generate({ ...REQUEST, signal: controller.signal }, CONFIG);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ category: 'TIMEOUT' });
  });

  it('never carries a credential in its error output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fail(400, { error: { message: 'bad request with sk-abcdef1234567890 inside' } })),
    );
    try {
      await provider.generate(REQUEST, CONFIG);
    } catch (e) {
      const serialised = JSON.stringify((e as ProviderError).toJSON());
      expect(serialised).not.toContain('sk-abcdef1234567890');
      expect(serialised).toContain('redacted');
    }
  });
});

describe('credential requirements', () => {
  it('refuses a keyed provider with no credential', async () => {
    for (const p of ALL.filter((x) => x.capabilities().requiresApiKey)) {
      await expect(p.generate(REQUEST, { baseUrl: 'https://example.test/v1' })).rejects.toMatchObject({
        category: 'NOT_CONFIGURED',
      });
    }
  });

  it('runs Ollama without any credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(WIRE.ollama)));
    const res = await ollamaProvider.generate(REQUEST, {});
    expect(res.provider).toBe('ollama');
  });
});

describe('connection tests are real requests', () => {
  it('reports not_configured without a key rather than probing', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const status = await openaiProvider.testConnection({});
    expect(status.status).toBe('not_configured');
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports authentication_failed from a real 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(401, { error: { message: 'nope' } })));
    const status = await openaiProvider.testConnection(CONFIG);
    expect(status.status).toBe('authentication_failed');
  });

  it('tells you Ollama is not running rather than a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const status = await ollamaProvider.testConnection({});
    expect(status.status).toBe('unavailable');
    expect(status.detail).toMatch(/ollama serve/);
  });

  it('never reports connected without a successful request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    // Concurrently, because each adapter retries a network failure once with a
    // 500ms backoff. Sequentially this cost 500ms per provider and sat just
    // under the default timeout at nine of them; the three local runtimes
    // pushed it over. The providers are independent, so there was never a
    // reason to serialise them.
    const statuses = await Promise.all(ALL.map((p) => p.testConnection(CONFIG)));
    for (const status of statuses) {
      expect(status.status).not.toBe('connected');
    }
  });
});

describe('model listing', () => {
  it('returns what the provider reported, with no local list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok({ data: [{ id: 'a-model-nobody-hardcoded' }, { id: 'another' }] })),
    );
    const models = await openaiProvider.listModels(CONFIG);
    expect(models.map((m) => m.id)).toEqual(['a-model-nobody-hardcoded', 'another']);
  });

  it('reads installed models from Ollama', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ models: [{ name: 'whatever:latest' }] })));
    const models = await ollamaProvider.listModels({});
    expect(models[0]!.id).toBe('whatever:latest');
  });
});

describe('registry', () => {
  it('registers every adapter', () => {
    expect(providerRegistry.list()).toHaveLength(ALL.length);
  });

  it('resolves a provider by id', () => {
    expect(providerRegistry.get('anthropic').displayName).toBe('Anthropic');
  });

  it('names the registered providers when asked for an unknown one', () => {
    try {
      providerRegistry.get('not-a-provider');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ProviderError).category).toBe('NOT_CONFIGURED');
      expect((e as ProviderError).message).toContain('openai');
    }
  });

  it('accepts a new provider without touching any service', () => {
    // The architectural claim: registration is the whole integration.
    const registry = new ProviderRegistry();
    registry.register({
      id: 'future-provider',
      displayName: 'Something Not Yet Invented',
      capabilities: () => ({
        streaming: 'unknown',
        tools: 'unknown',
        vision: 'unknown',
        structuredOutput: 'unknown',
        modelListing: 'unsupported',
        requiresApiKey: true,
      }),
      testConnection: async () => ({ status: 'not_configured', detail: 'x' }),
      generate: async () => {
        throw new Error('unused');
      },
    });
    expect(registry.get('future-provider').displayName).toBe('Something Not Yet Invented');
  });

  it('describes providers without embedding any model list', () => {
    const described = JSON.stringify(providerRegistry.describe());
    // Model identifiers carry a version: gpt-4, claude-sonnet-4-5, gemini-1.5.
    // Provider display names ("Google Gemini", "Mistral") do not, which is what
    // separates the two — an earlier version of this pattern flagged the
    // display names and was measuring the wrong thing.
    expect(described).not.toMatch(/(gpt|claude|gemini|grok|llama|qwen|mistral|deepseek)[-.]?\d/i);
  });

  it('does not leak a key into the description', () => {
    process.env.OPENAI_API_KEY = 'sk-should-never-appear';
    try {
      const described = JSON.stringify(providerRegistry.describe());
      expect(described).not.toContain('sk-should-never-appear');
      expect(described).toContain('"credentialConfigured":true');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('reads credentials from the environment only', () => {
    expect(resolveConfig('openai').apiKey).toBeUndefined();
    process.env.OPENAI_API_KEY = 'sk-from-env';
    try {
      expect(resolveConfig('openai').apiKey).toBe('sk-from-env');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe('redaction', () => {
  it('strips credentials from text', () => {
    expect(redact('failed with sk-abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toContain('redacted');
    expect(redact('{"api_key":"secret-value-here"}')).not.toContain('secret-value-here');
  });
});
