/**
 * Ed25519 signing over canonical JSON.
 *
 * The hash chain proves internal consistency: nobody edited entry 4 without
 * rewriting 5 onward. It says nothing about who produced the log, and an
 * operator who can rewrite the whole thing leaves a perfectly consistent
 * chain. A signature over the Merkle root fixes that, but only if the key
 * lives somewhere the signing process cannot be talked into misusing.
 *
 * Hence the KeySource seam. In development the key sits in memory; in a real
 * deployment it belongs in an HSM or KMS, where the control plane can request
 * a signature but never read the private key. Both satisfy this interface, so
 * the calling code does not change and the difference is a deployment
 * decision rather than a rewrite.
 *
 * Ed25519 rather than ECDSA: deterministic (no per-signature nonce to leak a
 * key through), small keys and signatures, and no curve/parameter choices to
 * get wrong. Node has it natively, so there is no third-party crypto here.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto';
import { canonicalize } from './canonical.js';

export interface Signature {
  algorithm: 'ed25519';
  /** Identifies which key signed, so keys can rotate without invalidating history. */
  keyId: string;
  /** Base64 signature over the canonical JSON of the signed value. */
  value: string;
  signedAt: string;
}

export interface SignedEnvelope<T> {
  payload: T;
  signature: Signature;
}

/**
 * Where a private key lives.
 *
 * Implement this against a KMS to keep the key outside the process. The
 * control plane only ever needs `sign` and `publicKeyPem`.
 */
export interface KeySource {
  readonly keyId: string;
  sign(data: Buffer): Promise<Buffer> | Buffer;
  publicKeyPem(): string;
}

/**
 * A key held in this process.
 *
 * Correct for development and tests. In production the private key should not
 * be reachable from the process that runs agent code -- that is the whole
 * point of signing.
 */
export class InMemoryKeySource implements KeySource {
  private constructor(
    readonly keyId: string,
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
  ) {}

  static generate(keyId = 'dev-key-1'): InMemoryKeySource {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return new InMemoryKeySource(keyId, privateKey, publicKey);
  }

  static fromPem(keyId: string, privateKeyPem: string): InMemoryKeySource {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`expected an ed25519 key, got ${privateKey.asymmetricKeyType}`);
    }
    return new InMemoryKeySource(keyId, privateKey, createPublicKey(privateKey));
  }

  sign(data: Buffer): Buffer {
    // Ed25519 hashes internally; the algorithm argument must be null.
    return nodeSign(null, data, this.privateKey);
  }

  publicKeyPem(): string {
    return this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }
}

export class Signer {
  constructor(private readonly keySource: KeySource) {}

  get keyId(): string {
    return this.keySource.keyId;
  }

  publicKeyPem(): string {
    return this.keySource.publicKeyPem();
  }

  /**
   * Sign a value, returning it alongside its signature.
   *
   * The signature covers the canonical JSON of `payload` only. `signedAt` is
   * metadata about the act of signing and is deliberately outside the signed
   * bytes -- including it would mean re-signing to correct a clock, and the
   * timestamp that carries weight is a timestamp authority's, not ours.
   */
  async sign<T>(payload: T): Promise<SignedEnvelope<T>> {
    const bytes = Buffer.from(canonicalize(payload), 'utf8');
    const value = await this.keySource.sign(bytes);
    return {
      payload,
      signature: {
        algorithm: 'ed25519',
        keyId: this.keySource.keyId,
        value: value.toString('base64'),
        signedAt: new Date().toISOString(),
      },
    };
  }
}

export interface SignatureVerification {
  valid: boolean;
  reason?: string;
}

/**
 * Verify an envelope against a public key.
 *
 * A free function, not a Signer method: verification must be possible with
 * nothing but the public key and the envelope. Anyone given an evidence bundle
 * can run this without access to the system that produced it.
 */
export function verifySignature<T>(
  envelope: SignedEnvelope<T>,
  publicKeyPem: string,
): SignatureVerification {
  const { payload, signature } = envelope;

  if (signature.algorithm !== 'ed25519') {
    return { valid: false, reason: `unsupported algorithm ${signature.algorithm}` };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(canonicalize(payload), 'utf8');
  } catch (e) {
    return { valid: false, reason: `payload cannot be canonicalized: ${(e as Error).message}` };
  }

  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (e) {
    return { valid: false, reason: `unusable public key: ${(e as Error).message}` };
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    return { valid: false, reason: `public key is ${key.asymmetricKeyType}, expected ed25519` };
  }

  let sig: Buffer;
  try {
    sig = Buffer.from(signature.value, 'base64');
  } catch {
    return { valid: false, reason: 'signature is not valid base64' };
  }

  const ok = nodeVerify(null, bytes, key, sig);
  return ok ? { valid: true } : { valid: false, reason: 'signature does not match the payload' };
}
