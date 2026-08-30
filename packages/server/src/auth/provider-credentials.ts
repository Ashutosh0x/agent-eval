/**
 * Provider credentials.
 *
 * A different thing from an agent-eval API key, and kept separate in both the
 * store and the UI because conflating them causes real mistakes:
 *
 *   agent-eval API key   a caller proves identity *to* this control plane.
 *                        Hashed; never recoverable.
 *   provider credential  this control plane proves identity *to* OpenAI.
 *                        Encrypted; recoverable by the server, never by a
 *                        browser.
 *
 * The secret leaves this module in exactly one direction: into a provider
 * adapter, server-side. No read path returns it, and the type of what reads
 * return makes that structural rather than a convention.
 */

import { randomBytes } from 'node:crypto';
import {
  EncryptionError,
  SecretBox,
  maskSecret,
  type SealedSecret,
} from './encryption.js';

export interface ProviderCredentialRecord {
  id: string;
  tenantId: string;
  providerId: string;
  /** e.g. "Production". Multiple credentials per provider are expected. */
  name: string;
  /** Enough to recognise which key this is, never enough to use it. */
  masked: string;
  /** Present for self-hosted and OpenAI-compatible endpoints. */
  baseUrl?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
  sealed?: SealedSecret;
}

/** What a read path may return. Note the absence of `sealed`. */
export type ProviderCredentialPublic = Omit<ProviderCredentialRecord, 'sealed'>;

export function toPublic(record: ProviderCredentialRecord): ProviderCredentialPublic {
  const { sealed: _omitted, ...rest } = record;
  return rest;
}

export class CredentialError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = 'CredentialError';
  }
}

export interface CreateCredentialInput {
  providerId: string;
  name: string;
  /** Absent for providers that need none, such as Ollama. */
  apiKey?: string;
  baseUrl?: string;
}

let counter = 0;
const newId = () => `cred_${Date.now().toString(36)}${(counter++).toString(36)}${randomBytes(2).toString('hex')}`;

export class ProviderCredentialStore {
  private credentials = new Map<string, ProviderCredentialRecord>();

  constructor(private readonly box: SecretBox | null) {}

  get encryptionAvailable(): boolean {
    return this.box !== null;
  }

  /** Binds ciphertext to its tenant and record, so a moved row will not open. */
  private aad(tenantId: string, id: string): string {
    return `agent-eval:provider-credential:${tenantId}:${id}`;
  }

  async create(
    tenantId: string,
    createdBy: string,
    input: CreateCredentialInput,
  ): Promise<ProviderCredentialPublic> {
    if (!input.name.trim()) {
      throw new CredentialError('a credential needs a name so it can be told apart from the others');
    }

    const id = newId();
    const now = new Date();
    const record: ProviderCredentialRecord = {
      id,
      tenantId,
      providerId: input.providerId,
      name: input.name.trim(),
      masked: input.apiKey ? maskSecret(input.apiKey) : 'no credential required',
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      createdBy,
      createdAt: now,
      updatedAt: now,
    };

    if (input.apiKey) {
      if (!this.box) {
        // Refuse rather than store plaintext. A credential written unencrypted
        // because configuration was missing is the failure this store exists
        // to prevent, and it would be invisible afterwards.
        throw new CredentialError(
          'Cannot store a provider credential: encryption is not configured. ' +
            'Set AGENT_EVAL_ENCRYPTION_KEY to 64 hex characters. Credentials are never stored in plaintext.',
          503,
        );
      }
      record.sealed = this.box.seal(input.apiKey, this.aad(tenantId, id));
    }

    this.credentials.set(id, record);
    return toPublic(record);
  }

  async list(tenantId: string, providerId?: string): Promise<ProviderCredentialPublic[]> {
    return [...this.credentials.values()]
      .filter((c) => c.tenantId === tenantId)
      .filter((c) => (providerId ? c.providerId === providerId : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(toPublic);
  }

  async get(tenantId: string, id: string): Promise<ProviderCredentialPublic | null> {
    const c = this.credentials.get(id);
    // Tenant check on every lookup. A findUnique by id alone is how one tenant
    // ends up using another's credential.
    return c && c.tenantId === tenantId ? toPublic(c) : null;
  }

  /**
   * Decrypt for a provider call. Server-side only.
   *
   * The one function that returns plaintext, deliberately named so a reviewer
   * can grep for its call sites and check every one.
   */
  async revealForProviderCall(
    tenantId: string,
    id: string,
  ): Promise<{ apiKey?: string; baseUrl?: string; providerId: string } | null> {
    const c = this.credentials.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    if (c.revokedAt) {
      throw new CredentialError('This provider credential has been revoked.', 409);
    }

    let apiKey: string | undefined;
    if (c.sealed) {
      if (!this.box) {
        throw new CredentialError(
          'Encryption is not configured, so this credential cannot be decrypted.',
          503,
        );
      }
      try {
        apiKey = this.box.open(c.sealed, this.aad(tenantId, id));
      } catch (e) {
        throw new CredentialError((e as EncryptionError).message, 500);
      }
    }

    c.lastUsedAt = new Date();
    this.credentials.set(id, c);

    return {
      ...(apiKey ? { apiKey } : {}),
      ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
      providerId: c.providerId,
    };
  }

  async revoke(tenantId: string, id: string, _by: string): Promise<ProviderCredentialPublic | null> {
    const c = this.credentials.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    const updated: ProviderCredentialRecord = {
      ...c,
      revokedAt: new Date(),
      updatedAt: new Date(),
      // The ciphertext is dropped on revocation: a revoked credential should
      // not remain decryptable, and nothing needs it again.
      sealed: undefined,
    };
    this.credentials.set(id, updated);
    return toPublic(updated);
  }
}
