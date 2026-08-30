/**
 * The reproducibility manifest.
 *
 * An eval score on its own is a number, not evidence. "The agent scored 0.82"
 * is unfalsifiable unless someone else can state exactly what was run: which
 * image, which task split, which model at which sampling settings, which
 * verifier revision. Without that, a regulator cannot distinguish a genuine
 * improvement from a changed prompt, a swapped model, or a task set that
 * quietly lost its hard cases.
 *
 * So the manifest is required, not optional, and it is validated on
 * construction. A run that cannot say what it ran should fail before it
 * starts, rather than produce a result that looks like the others.
 *
 * Everything here is pinned by digest where a digest exists. Tags move:
 * `my-env:latest` in March and in June are different software with the same
 * name, and an evidence bundle that cites a tag has recorded nothing.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.js';

/** A container image, pinned. */
export interface ImagePin {
  /** Human-readable reference, e.g. "ghcr.io/org/env:1.4.2". Informational. */
  reference: string;
  /** The sha256 digest. This is the identity; the reference is a label. */
  digest: string;
  /** Signature verification status at import time, if the registry had one. */
  signatureVerified?: boolean;
}

export interface ModelPin {
  /** Provider-qualified identifier, e.g. "anthropic/claude-sonnet-4-5". */
  identifier: string;
  /** Sampling parameters that affect output. Recorded verbatim. */
  sampling: Record<string, unknown>;
  /** Provider-reported version or snapshot, when one is exposed. */
  providerVersion?: string;
}

export interface TaskSetPin {
  id: string;
  version: string;
  /** Which split was used. Held-out splits are the ones worth protecting. */
  split: string;
  /** Hash over the task ids in the split, so a changed split is detectable. */
  splitHash: string;
  taskCount: number;
}

export interface VerifierPin {
  id: string;
  version: string;
  /** Whether verifier assurance checks had been run at the time of this run. */
  assurance?: {
    isomorphicPerturbationTested: boolean;
    fuzzed: boolean;
    canaryTasksIncluded: boolean;
  };
}

export interface ReproducibilityManifest {
  /** Manifest schema version, so a stored bundle stays readable. */
  manifestVersion: '1';
  runId: string;
  environment: ImagePin & { openEnvSpecVersion?: number };
  model: ModelPin;
  taskSet: TaskSetPin;
  verifier: VerifierPin;
  /** Seed, when the run was seeded. Null is recorded explicitly. */
  seed: number | null;
  /** Versions of everything in the loop: adapters, SDKs, this platform. */
  toolchain: Record<string, string>;
  /** Isolation backend, e.g. "firecracker". Affects what the result means. */
  isolationBackend: string;
  createdAt: string;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function requireDigest(value: string, field: string): void {
  if (!SHA256_DIGEST.test(value)) {
    throw new ManifestError(
      `${field} must be pinned as "sha256:<64 hex>", got "${value}". ` +
        'A tag is not a pin: it can point at different software later, which ' +
        'means the run cannot be reproduced from this record.',
    );
  }
}

function requireNonEmpty(value: string | undefined, field: string): void {
  if (!value || value.trim() === '') {
    throw new ManifestError(`${field} is required; an unattributed run is not evidence`);
  }
}

/**
 * Build and validate a manifest.
 *
 * Throws rather than filling in defaults. A default here would be a guess
 * recorded as a fact.
 */
export function createManifest(input: Omit<ReproducibilityManifest, 'manifestVersion' | 'createdAt'> & {
  createdAt?: Date;
}): ReproducibilityManifest {
  requireNonEmpty(input.runId, 'runId');
  requireDigest(input.environment.digest, 'environment.digest');
  requireNonEmpty(input.model.identifier, 'model.identifier');
  requireNonEmpty(input.taskSet.id, 'taskSet.id');
  requireNonEmpty(input.taskSet.version, 'taskSet.version');
  requireNonEmpty(input.taskSet.split, 'taskSet.split');
  requireNonEmpty(input.verifier.id, 'verifier.id');
  requireNonEmpty(input.verifier.version, 'verifier.version');
  requireNonEmpty(input.isolationBackend, 'isolationBackend');

  if (!HEX64.test(input.taskSet.splitHash)) {
    throw new ManifestError('taskSet.splitHash must be a 64-character hex sha256');
  }
  if (input.taskSet.taskCount <= 0) {
    throw new ManifestError('taskSet.taskCount must be positive');
  }
  if (Object.keys(input.toolchain).length === 0) {
    throw new ManifestError(
      'toolchain must record at least the platform version; ' +
        'a result cannot be reproduced without knowing what produced it',
    );
  }

  return {
    manifestVersion: '1',
    ...input,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

/**
 * Hash the ordered task ids of a split.
 *
 * Order is preserved deliberately: a reordered split can change results
 * through context effects, so it is a different split.
 */
export function hashSplit(taskIds: readonly string[]): string {
  return createHash('sha256').update(canonicalize(taskIds), 'utf8').digest('hex');
}

/** Stable digest of a manifest, for citing it from an evidence bundle. */
export function manifestDigest(manifest: ReproducibilityManifest): string {
  return createHash('sha256').update(canonicalize(manifest), 'utf8').digest('hex');
}

export interface ComparabilityResult {
  /** True when the two runs differ only in ways that cannot affect the result. */
  comparable: boolean;
  /** Fields that differ and would invalidate a direct comparison. */
  differences: string[];
}

/**
 * Whether two runs can be compared to each other.
 *
 * The question a model-risk reviewer actually asks: "is this quarter's score
 * better, or did something change underneath?" Anything that can move a score
 * counts as a difference -- including the isolation backend, since network and
 * filesystem behaviour differ between them.
 */
export function comparable(
  a: ReproducibilityManifest,
  b: ReproducibilityManifest,
): ComparabilityResult {
  const differences: string[] = [];
  const check = (field: string, x: unknown, y: unknown) => {
    if (canonicalize(x) !== canonicalize(y)) differences.push(field);
  };

  check('environment.digest', a.environment.digest, b.environment.digest);
  check('taskSet.splitHash', a.taskSet.splitHash, b.taskSet.splitHash);
  check('verifier.version', `${a.verifier.id}@${a.verifier.version}`, `${b.verifier.id}@${b.verifier.version}`);
  check('model.sampling', a.model.sampling, b.model.sampling);
  check('isolationBackend', a.isolationBackend, b.isolationBackend);
  check('seed', a.seed, b.seed);

  return { comparable: differences.length === 0, differences };
}
