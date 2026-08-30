/**
 * Provider registry.
 *
 * The reason this exists rather than a switch in the run service: adding a
 * provider must not touch the evaluator, the audit service, or the evidence
 * layer. Those resolve a provider by id and then work in normalized shapes,
 * so a new adapter is a registration, not a set of edits fanning out across
 * services that have no business knowing provider names.
 *
 * Credentials are resolved here too, from server-side configuration only. A
 * key never travels through a request body and never reaches the browser.
 */

import { anthropicProvider } from './anthropic.js';
import { googleProvider } from './google.js';
import {
  deepseekProvider,
  minimaxProvider,
  mistralProvider,
  openaiCompatibleProvider,
  openaiProvider,
  xaiProvider,
} from './openai-compatible.js';
import { ollamaProvider } from './ollama.js';
import { ProviderError, type ModelProvider, type ProviderConfig, type Support } from './types.js';

export class ProviderRegistry {
  private providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): ModelProvider {
    const p = this.providers.get(id);
    if (!p) {
      throw new ProviderError(
        'NOT_CONFIGURED',
        `Unknown provider "${id}". Registered: ${[...this.providers.keys()].join(', ')}.`,
        { provider: id, retryable: false },
      );
    }
    return p;
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Declarative metadata for the UI.
   *
   * Note the absence of models: the settings screen asks the provider at
   * runtime, or accepts a typed id. Anything cached here would be stale the
   * next time a provider ships something.
   */
  describe(): {
    id: string;
    displayName: string;
    requiresApiKey: boolean;
    supportsModelListing: boolean;
    /** 'unknown' is distinct from 'unsupported' and is preserved here. */
    modelListing: Support;
    capabilities: ReturnType<ModelProvider['capabilities']>;
    credentialConfigured: boolean;
  }[] {
    return this.list().map((p) => {
      const caps = p.capabilities();
      return {
        id: p.id,
        displayName: p.displayName,
        requiresApiKey: caps.requiresApiKey,
        // 'unknown' means the provider might list models and we have not
        // established it either way, so the honest answer is to let a caller
        // try -- a failed probe is itself information. Collapsing unknown into
        // false made the catalogue say "no listing API" while the endpoint
        // went ahead and called one, and the two disagreed in the UI.
        supportsModelListing: caps.modelListing !== 'unsupported' && typeof p.listModels === 'function',
        modelListing: caps.modelListing,
        capabilities: caps,
        credentialConfigured: !caps.requiresApiKey || Boolean(resolveConfig(p.id).apiKey),
      };
    });
  }
}

/**
 * Where a provider's credential comes from.
 *
 * Environment only, and only the providers actually in use need one. Ollama
 * needs none at all, which is why `requiresApiKey` is part of the capability
 * report rather than assumed.
 */
const ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
};

const ENV_BASE_URLS: Record<string, string> = {
  ollama: 'OLLAMA_BASE_URL',
  'openai-compatible': 'OPENAI_COMPATIBLE_BASE_URL',
};

export function resolveConfig(providerId: string, overrides: ProviderConfig = {}): ProviderConfig {
  const envKey = ENV_KEYS[providerId];
  const envBase = ENV_BASE_URLS[providerId];
  return {
    ...(envKey && process.env[envKey] ? { apiKey: process.env[envKey] } : {}),
    ...(envBase && process.env[envBase] ? { baseUrl: process.env[envBase] } : {}),
    ...overrides,
  };
}

/**
 * The default registry.
 *
 * Every provider here has a working adapter. Registration order is display
 * order; it carries no other meaning.
 */
export const providerRegistry = new ProviderRegistry()
  .register(openaiProvider)
  .register(anthropicProvider)
  .register(xaiProvider)
  .register(googleProvider)
  .register(deepseekProvider)
  .register(mistralProvider)
  .register(minimaxProvider)
  .register(ollamaProvider)
  .register(openaiCompatibleProvider);

export * from './types.js';
export { OpenAICompatibleProvider } from './openai-compatible.js';
