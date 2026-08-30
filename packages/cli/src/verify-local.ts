/**
 * Offline bundle verification.
 *
 * This file imports nothing from the server package, and that is the entire
 * design. An auditor verifying a bundle with code the vendor also wrote is
 * only checking that the vendor is self-consistent; the cryptography here is
 * reimplemented from the specifications so that agreeing with the server means
 * something.
 *
 *   RFC 8785  JSON Canonicalization Scheme — deterministic serialisation
 *   RFC 6962  Certificate Transparency — Merkle leaves and inclusion proofs
 *   Ed25519   signature over the canonical payload
 *
 * Note what the checks are and are not. Contiguous sequence numbers are *not*
 * required: a bundle holds one run's entries out of a shared log, so gaps are
 * the filter rather than evidence of removal. What binds each entry to the log
 * is its inclusion proof against the signed root, and what binds the set of
 * entries together is the signature over all of them.
 */

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface LocalVerification {
  valid: boolean;
  checks: {
    signature: boolean;
    entryDigests: boolean;
    ordering: boolean;
    inclusion: boolean;
    manifest: boolean;
  };
  failures: string[];
}

/** RFC 8785: object keys sorted, no insignificant whitespace. */
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(record[k])).join(',') + '}';
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();
/** RFC 6962 §2.1: leaves are prefixed 0x00, interior nodes 0x01. */
const hashLeaf = (data: Buffer) => sha256(Buffer.concat([Buffer.from([0x00]), data]));
const hashNode = (l: Buffer, r: Buffer) => sha256(Buffer.concat([Buffer.from([0x01]), l, r]));

function verifyInclusion(
  leaf: Buffer,
  leafIndex: number,
  treeSize: number,
  path: string[],
  root: string,
): boolean {
  if (treeSize <= 0 || leafIndex < 0 || leafIndex >= treeSize) return false;
  let fn = leafIndex;
  let sn = treeSize - 1;
  let hash = hashLeaf(leaf);

  for (const sibling of path) {
    if (sn === 0) return false;
    const node = Buffer.from(sibling, 'hex');
    if (fn % 2 === 1 || fn === sn) {
      hash = hashNode(node, hash);
      while (fn !== 0 && fn % 2 === 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      hash = hashNode(hash, node);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && hash.toString('hex') === root;
}

export function verifyLocalBundle(file: string): LocalVerification {
  const offline = JSON.parse(readFileSync(file, 'utf8'));
  const bundle = offline.bundle ?? offline;
  const publicKeyPem: string | undefined = offline.publicKeyPem;

  const failures: string[] = [];
  const checks = {
    signature: false,
    entryDigests: false,
    ordering: false,
    inclusion: false,
    manifest: false,
  };

  if (!publicKeyPem) {
    failures.push('no public key in the file; download it with `evidence download`');
  } else {
    try {
      checks.signature = edVerify(
        null,
        Buffer.from(canonical(bundle.payload), 'utf8'),
        createPublicKey(publicKeyPem),
        Buffer.from(bundle.signature.value, 'base64'),
      );
      if (!checks.signature) failures.push('signature does not verify against the public key');
    } catch (e) {
      failures.push(`signature check failed: ${(e as Error).message}`);
    }
  }

  const entries = bundle.payload.entries as Record<string, unknown>[];

  let digestsOk = true;
  for (const entry of entries) {
    const { entryHash, ...rest } = entry as { entryHash: string };
    const recomputed = createHash('sha256').update(canonical(rest), 'utf8').digest('hex');
    if (recomputed !== entryHash) {
      failures.push(`entry ${String(entry.seq)} was modified after it was written`);
      digestsOk = false;
    }
  }
  checks.entryDigests = digestsOk;

  let previous = -1;
  let ordered = true;
  for (const entry of entries) {
    const seq = entry.seq as number;
    if (seq <= previous) {
      failures.push(`entry ${seq} does not follow ${previous}; the slice is reordered`);
      ordered = false;
    }
    previous = seq;
  }
  checks.ordering = ordered;

  let inclusionOk = true;
  for (const entry of entries) {
    const seq = entry.seq as number;
    const proof = bundle.payload.inclusionProofs[seq];
    if (!proof) {
      failures.push(`entry ${seq}: no inclusion proof`);
      inclusionOk = false;
      continue;
    }
    const ok = verifyInclusion(
      Buffer.from(entry.entryHash as string, 'hex'),
      proof.leafIndex,
      proof.treeSize,
      proof.path,
      bundle.payload.logRoot,
    );
    if (!ok) {
      failures.push(`entry ${seq}: not provably in the log`);
      inclusionOk = false;
    }
  }
  checks.inclusion = inclusionOk;

  const manifestDigest = createHash('sha256')
    .update(canonical(bundle.payload.manifest), 'utf8')
    .digest('hex');
  checks.manifest = manifestDigest === bundle.payload.manifestDigest;
  if (!checks.manifest) failures.push('manifest digest does not match the manifest');

  return { valid: Object.values(checks).every(Boolean), checks, failures };
}
