/**
 * Authenticated encryption for provider credentials.
 *
 * Provider credentials differ from agent-eval API keys in a way that decides
 * the mechanism. An agent-eval key is verified — the server only needs to know
 * whether a presented secret matches, so it stores a one-way hash and can
 * never recover the original. A provider credential must be *replayed*: the
 * server has to send the real OpenAI key to OpenAI. So it must be recoverable,
 * which means encryption rather than hashing.
 *
 * AES-256-GCM, because it authenticates as well as encrypts. Without the tag,
 * ciphertext in a compromised database can be altered without detection, and a
 * credential that decrypts to attacker-chosen bytes is worse than one that
 * simply leaks: it redirects requests.
 *
 * The master key comes from the environment and nowhere else. Deriving it from
 * a tenant id or a user id would mean anyone who can read the database can
 * also reconstruct the key, which is the same as not encrypting.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.
const TAG_BYTES = 16;

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/**
 * The master key, from `AGENT_EVAL_ENCRYPTION_KEY` as 64 hex characters.
 *
 * Generate one with:
 *   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
 *
 * There is deliberately no default. A hardcoded fallback would ship a key that
 * is identical in every deployment and published in this repository, which
 * offers the appearance of encryption and none of the protection.
 */
export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.AGENT_EVAL_ENCRYPTION_KEY;
  if (!raw) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new EncryptionError(
      'AGENT_EVAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
        'Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(raw, 'hex');
}

export interface SealedSecret {
  /** Versioned so the scheme can change without orphaning stored data. */
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox | null {
    const key = loadMasterKey(env);
    return key ? new SecretBox(key) : null;
  }

  static fromKey(key: Buffer): SecretBox {
    if (key.length !== KEY_BYTES) {
      throw new EncryptionError(`master key must be ${KEY_BYTES} bytes, got ${key.length}`);
    }
    return new SecretBox(key);
  }

  /**
   * `aad` binds the ciphertext to its context — the tenant and credential id.
   * Without it, a row moved between tenants still decrypts, so a database-level
   * attacker could hand one tenant another's credential without breaking any
   * cryptography.
   */
  seal(plaintext: string, aad: string): SealedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  open(sealed: SealedSecret, aad: string): string {
    if (sealed.v !== 1) {
      throw new EncryptionError(`unsupported sealed secret version ${sealed.v}`);
    }
    const tag = Buffer.from(sealed.tag, 'base64');
    if (tag.length !== TAG_BYTES) {
      throw new EncryptionError('authentication tag has the wrong length');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Deliberately uniform: distinguishing "wrong key" from "tampered
      // ciphertext" from "wrong tenant" tells an attacker which one they got
      // right.
      throw new EncryptionError(
        'Could not decrypt the credential. The master key may have changed, or the record may have been altered.',
      );
    }
  }
}

/** Never the secret itself — only enough to recognise which one it is. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '•'.repeat(8);
  return `${secret.slice(0, 3)}${'•'.repeat(10)}${secret.slice(-4)}`;
}

/**
 * Centralised redaction for logs and error paths.
 *
 * Applied at the boundary rather than trusted to call sites: provider errors
 * quote the offending request often enough that echoing one verbatim is a real
 * disclosure path, and every future call site would have to remember.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|xai|gsk|ae_live|ae_test)[-_][A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /"(api[_-]?key|apiKey|secret|password|token|authorization)"\s*:\s*"[^"]*"/gi,
  /\b(x-api-key|authorization)\s*:\s*\S+/gi,
];

export function redactSecrets(input: unknown): string {
  let text = typeof input === 'string' ? input : safeStringify(input);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => {
      const colon = match.indexOf(':');
      if (colon > 0 && colon < 24) return `${match.slice(0, colon + 1)}"[redacted]"`;
      return `${match.slice(0, 6)}[redacted]`;
    });
  }
  return text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Recursively strip secret-bearing keys from an object before it is logged or
 * written to the audit chain.
 */
const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'secret',
  'secrethash',
  'password',
  'token',
  'authorization',
  'x-api-key',
  'ciphertext',
  'privatekey',
]);

export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSecrets) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[redacted]' : stripSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Constant-time string comparison, for anything credential-shaped. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
