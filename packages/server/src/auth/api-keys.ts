/**
 * API keys.
 *
 * The security shape here is the standard one for high-entropy credentials,
 * and the reasoning is worth stating because it differs from passwords.
 *
 * A secret is 256 bits from `randomBytes`, so there is nothing to brute-force
 * offline: SHA-256 is the right store, not scrypt or bcrypt. Those exist to
 * slow attacks on *low*-entropy human-chosen secrets, and using them here
 * would buy nothing while making every request slower. This is what Stripe
 * and GitHub do with their tokens.
 *
 * The plaintext exists in exactly one place for exactly one moment: the return
 * value of `create`. It is never written to the store, never logged, and never
 * returned by any read path. If someone loses it, they rotate — that is the
 * whole point of a credential the issuer cannot recover.
 *
 * Comparison is constant-time. A timing oracle on a lookup that happens on
 * every request is a real leak, not a theoretical one.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Distinguishes environments at a glance in logs and dashboards. */
export const KEY_PREFIX = 'ae_live_';

/** Every scope the control plane recognises. */
export const ALL_SCOPES = [
  'runs:read',
  'runs:write',
  'evidence:read',
  'evidence:generate',
  'approvals:decide',
  'audit:read',
  'splits:held-out',
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

/** Human descriptions, shown next to each checkbox at creation time. */
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'runs:read': 'View evaluation runs, their manifests and comparisons.',
  'runs:write': 'Start and cancel evaluation runs.',
  'evidence:read': 'Read evidence bundles and verify them.',
  'evidence:generate': 'Generate and sign new evidence bundles.',
  'approvals:decide': 'Approve, reject or escalate gated actions.',
  'audit:read': 'Query the audit log and request inclusion proofs.',
  'splits:held-out': 'Read held-out task splits.',
};

/**
 * Scopes that change state or grant sensitive reach. Surfaced in the UI so a
 * person choosing them does so deliberately, without painting every scope red.
 */
export const CONSEQUENTIAL_SCOPES: readonly Scope[] = [
  'runs:write',
  'evidence:generate',
  'approvals:decide',
  'splits:held-out',
];

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  /** Who created it. Attribution survives the key being revoked. */
  createdBy: string;
  name: string;
  description?: string;
  /** Identifies the key without revealing it, e.g. "ae_live_...9x4k". */
  masked: string;
  /** The last four characters, for matching against a secret someone holds. */
  last4: string;
  scopes: Scope[];
  hashedSecret: string;
  createdAt: Date;
  /** Optional. Null means the key does not expire on its own. */
  expiresAt?: Date;
  revokedAt?: Date;
  revokedBy?: string;
  lastUsedAt?: Date;
}

/** Why a presented key was refused. The caller sees a reason, not just a no. */
export type AuthFailure = 'unknown' | 'revoked' | 'expired';

/** What a read path is allowed to return. Note the absence of hashedSecret. */
export type ApiKeyPublic = Omit<ApiKeyRecord, 'hashedSecret'>;

export function toPublic(record: ApiKeyRecord): ApiKeyPublic {
  const { hashedSecret: _omitted, ...rest } = record;
  return rest;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison, so a lookup cannot be timed. */
export function secretMatches(secret: string, hashed: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(hashed, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function generateSecret(): { secret: string; last4: string; masked: string } {
  const secret = KEY_PREFIX + randomBytes(32).toString('base64url');
  const last4 = secret.slice(-4);
  return { secret, last4, masked: `${KEY_PREFIX}${'•'.repeat(10)}${last4}` };
}

export interface CreateApiKeyInput {
  name: string;
  description?: string;
  scopes: Scope[];
  /** Days until expiry. Omitted means no expiry. */
  expiresInDays?: number;
}

export class ApiKeyError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

export interface ApiKeyStore {
  create(
    tenantId: string,
    createdBy: string,
    input: CreateApiKeyInput,
    grantableScopes: readonly string[],
  ): Promise<{ key: ApiKeyPublic; secret: string }>;
  list(tenantId: string): Promise<ApiKeyPublic[]>;
  get(tenantId: string, id: string): Promise<ApiKeyPublic | null>;
  revoke(tenantId: string, id: string, revokedBy: string): Promise<ApiKeyPublic | null>;
  /**
   * Resolve a presented secret.
   *
   * Returns a reason on failure rather than a bare null: "expired" and
   * "revoked" need different responses from the caller, and an operator
   * debugging a broken integration needs to know which happened.
   */
  authenticate(
    secret: string,
  ): Promise<{ ok: true; key: ApiKeyRecord } | { ok: false; reason: AuthFailure }>;
}

let counter = 0;
const newId = () => `key_${Date.now().toString(36)}${(counter++).toString(36)}`;

export class InMemoryApiKeyStore implements ApiKeyStore {
  private keys = new Map<string, ApiKeyRecord>();

  async create(
    tenantId: string,
    createdBy: string,
    input: CreateApiKeyInput,
    grantableScopes: readonly string[],
  ): Promise<{ key: ApiKeyPublic; secret: string }> {
    if (!input.name.trim()) {
      throw new ApiKeyError('a key needs a name; an unnamed credential cannot be audited');
    }
    if (input.scopes.length === 0) {
      throw new ApiKeyError('a key with no scopes can do nothing; select at least one');
    }

    // Privilege escalation guard: a caller cannot mint a key more capable than
    // the token they are holding. Without this, any actor with a single scope
    // could issue themselves an all-scope credential.
    const escalating = input.scopes.filter((s) => !grantableScopes.includes(s));
    if (escalating.length > 0) {
      throw new ApiKeyError(
        `cannot grant scopes you do not hold: ${escalating.join(', ')}`,
        403,
      );
    }

    if (input.expiresInDays !== undefined && input.expiresInDays <= 0) {
      throw new ApiKeyError('expiresInDays must be positive');
    }

    const { secret, last4, masked } = generateSecret();
    const record: ApiKeyRecord = {
      id: newId(),
      tenantId,
      createdBy,
      name: input.name.trim(),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      masked,
      last4,
      scopes: [...input.scopes],
      hashedSecret: hashSecret(secret),
      createdAt: new Date(),
      ...(input.expiresInDays !== undefined
        ? { expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000) }
        : {}),
    };
    this.keys.set(record.id, record);

    // The only moment the plaintext leaves this function.
    return { key: toPublic(record), secret };
  }

  async list(tenantId: string): Promise<ApiKeyPublic[]> {
    return [...this.keys.values()]
      .filter((k) => k.tenantId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(toPublic);
  }

  async get(tenantId: string, id: string): Promise<ApiKeyPublic | null> {
    const k = this.keys.get(id);
    return k && k.tenantId === tenantId ? toPublic(k) : null;
  }

  async revoke(tenantId: string, id: string, revokedBy: string): Promise<ApiKeyPublic | null> {
    const k = this.keys.get(id);
    if (!k || k.tenantId !== tenantId) return null;
    // Revocation is a state change, not a delete: the record is evidence that
    // the credential existed and who ended it.
    const updated: ApiKeyRecord = { ...k, revokedAt: new Date(), revokedBy };
    this.keys.set(id, updated);
    return toPublic(updated);
  }

  async authenticate(
    secret: string,
  ): Promise<{ ok: true; key: ApiKeyRecord } | { ok: false; reason: AuthFailure }> {
    if (!secret.startsWith(KEY_PREFIX)) return { ok: false, reason: 'unknown' };

    for (const record of this.keys.values()) {
      // Compare against every key including revoked ones, so a revoked key
      // gets "revoked" rather than "unknown" — and so the loop takes the same
      // shape either way.
      if (!secretMatches(secret, record.hashedSecret)) continue;

      if (record.revokedAt) return { ok: false, reason: 'revoked' };
      if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
        return { ok: false, reason: 'expired' };
      }

      // Only a successful authentication updates lastUsedAt. Failed attempts
      // must not, or the field records attacks as activity.
      const touched = { ...record, lastUsedAt: new Date() };
      this.keys.set(record.id, touched);
      return { ok: true, key: touched };
    }
    return { ok: false, reason: 'unknown' };
  }
}
