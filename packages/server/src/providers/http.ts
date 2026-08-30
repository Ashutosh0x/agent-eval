/**
 * Shared HTTP for provider adapters: timeouts, abort, retries, and the error
 * normalization every adapter needs.
 *
 * Retry policy is deliberately narrow. Only 429 and 5xx are retried, and only
 * with the provider's own `Retry-After` when it supplies one. A model
 * completion is not idempotent — retrying a request the provider may already
 * have billed and executed is a real cost and a duplicated side effect — so
 * nothing else is retried, and the ceiling is low.
 */

import { ProviderError, redact, type ErrorCategory } from './types.js';

export interface HttpOptions {
  provider: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

function categorize(status: number, body: string): ErrorCategory {
  if (status === 401) return 'AUTHENTICATION_ERROR';
  if (status === 403) return 'AUTHORIZATION_ERROR';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status >= 500) return 'PROVIDER_ERROR';
  if (status === 400) {
    // 400 covers several distinct failures worth telling apart, because the
    // fix differs: shorten the prompt, change the model, or rephrase.
    const lower = body.toLowerCase();
    if (lower.includes('context length') || lower.includes('too many tokens') || lower.includes('maximum context'))
      return 'CONTEXT_LENGTH';
    if (lower.includes('content filter') || lower.includes('safety') || lower.includes('blocked'))
      return 'CONTENT_FILTER';
    if (lower.includes('model') && (lower.includes('not found') || lower.includes('does not exist')))
      return 'MODEL_NOT_FOUND';
    return 'INVALID_REQUEST';
  }
  return 'PROVIDER_ERROR';
}

/** Pull a human-usable message out of whatever shape the provider returned. */
function extractMessage(body: string): string {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const err = json.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === 'string') return m;
    }
    if (typeof json.message === 'string') return json.message;
    if (typeof json.detail === 'string') return json.detail;
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return body.slice(0, 400);
}

function providerCode(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const err = json.error as Record<string, unknown> | undefined;
    const code = err?.code ?? err?.type ?? json.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

export async function requestJson<T>(
  url: string,
  init: RequestInit,
  options: HttpOptions,
): Promise<{ data: T; requestId?: string; latencyMs: number }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  let attempt = 0;
  let lastError: ProviderError | undefined;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const latencyMs = Date.now() - startedAt;
      const requestId =
        res.headers.get('x-request-id') ??
        res.headers.get('request-id') ??
        res.headers.get('x-amzn-requestid') ??
        undefined;

      if (res.ok) {
        return { data: (await res.json()) as T, requestId: requestId ?? undefined, latencyMs };
      }

      const body = await res.text();
      const category = categorize(res.status, body);
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      const retryable = category === 'RATE_LIMITED' || category === 'PROVIDER_ERROR';

      lastError = new ProviderError(category, redact(extractMessage(body)), {
        provider: options.provider,
        ...(options.model ? { model: options.model } : {}),
        httpStatus: res.status,
        ...(providerCode(body) ? { providerCode: providerCode(body) } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
        ...(Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}),
        retryable,
      });

      if (!retryable || attempt === maxRetries) throw lastError;

      // Honour the provider's own backoff when it gives one.
      const waitMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds! * 1000
        : Math.min(2 ** attempt * 500, 8000);
      await new Promise((r) => setTimeout(r, waitMs));
      attempt++;
      continue;
    } catch (e) {
      if (e instanceof ProviderError) throw e;

      const aborted = (e as Error).name === 'AbortError';
      if (aborted && options.signal?.aborted) {
        throw new ProviderError('TIMEOUT', 'Request was aborted by the caller.', {
          provider: options.provider,
          ...(options.model ? { model: options.model } : {}),
          retryable: false,
        });
      }
      if (aborted) {
        throw new ProviderError('TIMEOUT', `Request exceeded ${timeoutMs}ms.`, {
          provider: options.provider,
          ...(options.model ? { model: options.model } : {}),
          retryable: true,
        });
      }

      const err = new ProviderError('NETWORK_ERROR', redact((e as Error).message), {
        provider: options.provider,
        ...(options.model ? { model: options.model } : {}),
        retryable: true,
      });
      if (attempt === maxRetries) throw err;
      lastError = err;
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 500, 8000)));
      attempt++;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError ?? new ProviderError('UNKNOWN', 'Request failed.', { provider: options.provider });
}

export function requireApiKey(provider: string, apiKey: string | undefined): string {
  if (!apiKey || !apiKey.trim()) {
    throw new ProviderError(
      'NOT_CONFIGURED',
      `No credential is configured for ${provider}.`,
      { provider, retryable: false },
    );
  }
  return apiKey;
}
