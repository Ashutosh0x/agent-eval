/**
 * The evidence bundle: the artifact a compliance reviewer actually receives.
 *
 * A bundle is self-contained and independently checkable. Given only the
 * bundle and a public key, a reviewer can confirm the audit entries were not
 * altered, that they belong to the log whose root was published, and what
 * exactly was run -- without access to this system.
 *
 * ## On claiming regulatory coverage
 *
 * The tempting design is a green tick per article. That is wrong, and in a
 * compliance product it is the dangerous kind of wrong: it invites a provider
 * to treat a generated PDF as a conformity assessment.
 *
 * So each mapping carries an explicit strength, and the language is deliberate:
 *
 *   satisfies  the article states a technical requirement that this
 *              demonstrably meets -- e.g. Art. 12 asks for automatic logging,
 *              and here are the logs
 *   supports   this is evidence a reviewer needs but does not discharge the
 *              obligation on its own -- Art. 14 human oversight requires an
 *              organisation, not only an approval queue
 *   exceeds    beyond what the text requires. Art. 12 does not ask for
 *              tamper-evidence; a hash-chained log is a stronger claim than
 *              the article makes, and calling that "compliance" misstates the
 *              regulation
 *
 * Nothing in a generated bundle should read as a legal conclusion. A bundle is
 * input to an assessment, and it says so.
 */

import { createHash } from 'node:crypto';
import type { AuditEntry } from './audit-log.js';
import { verifyEntrySlice } from './audit-log.js';
import type { ExecutionEnvironmentRecord } from '../system/capabilities.js';
import { canonicalize } from './canonical.js';
import type { ConsistencyProof, InclusionProof } from './merkle-tree.js';
import { verifyInclusion } from './proof-verifier.js';
import type { ReproducibilityManifest } from './reproducibility.js';
import { manifestDigest } from './reproducibility.js';
import type { SignedEnvelope } from './signer.js';
import { Signer, verifySignature } from './signer.js';

export type MappingStrength = 'satisfies' | 'supports' | 'exceeds';

export interface ArticleMapping {
  /** e.g. "EU AI Act Art. 12" or "NIST AI RMF Measure 2.1". */
  provision: string;
  /** What the provision asks for, in its own terms. */
  requirement: string;
  strength: MappingStrength;
  /** What in this bundle is offered as evidence. */
  evidence: string;
  /** Stated limits. Read by a human; deliberately not omittable. */
  caveat?: string;
}

export interface BundleContents {
  bundleId: string;
  tenantId: string;
  runId: string;
  manifest: ReproducibilityManifest;
  manifestDigest: string;
  /** Audit entries for this run, in order. */
  entries: AuditEntry[];
  /** Merkle root of the whole log at the time the bundle was cut. */
  logRoot: string;
  logSize: number;
  /** Inclusion proof per entry, keyed by sequence number. */
  inclusionProofs: Record<number, InclusionProof>;
  /** Optional proof that the log extends a previously published root. */
  consistency?: { previousRoot: string; proof: ConsistencyProof };
  /**
   * The machine that executed the run.
   *
   * This is what lets a reviewer answer "what actually produced this result?"
   * months later — architecture, GPU, CUDA and driver, not just the model
   * name. Optional because a bundle cut before this existed is still valid,
   * and because a deployment that cannot probe its own hardware should record
   * nothing rather than guess.
   */
  executionEnvironment?: ExecutionEnvironmentRecord;
  mappings: ArticleMapping[];
  retention: {
    /** Earliest date this may be deleted. */
    retainUntil: string;
    policy: string;
    /** Whether it actually landed on write-once storage. */
    wormAnchored: boolean;
  };
  generatedAt: string;
}

export type EvidenceBundle = SignedEnvelope<BundleContents>;

/**
 * The mappings this system can support, with their honest strength.
 *
 * Kept as data rather than prose so the claims are reviewable in one place and
 * a change to them shows up in a diff.
 */
export const STANDARD_MAPPINGS: readonly ArticleMapping[] = [
  {
    provision: 'EU AI Act Art. 12',
    requirement:
      'High-risk systems shall technically allow for the automatic recording of events over the lifetime of the system.',
    strength: 'satisfies',
    evidence: 'Every tool call, approval and state change is recorded automatically, with actor and timestamp.',
  },
  {
    provision: 'EU AI Act Art. 12',
    requirement: 'Logs must enable identification of risk situations and post-market monitoring.',
    strength: 'exceeds',
    evidence:
      'Entries are hash-chained and committed to a Merkle root, so alteration after the fact is detectable by a third party.',
    caveat:
      'Article 12 does not require tamper-evidence. This is a stronger property than the text asks for and should not be presented as what makes the system compliant.',
  },
  {
    provision: 'EU AI Act Art. 19',
    requirement: 'Providers shall keep logs for a period of at least six months.',
    strength: 'satisfies',
    evidence: 'Retention is recorded per bundle and enforced by the storage layer.',
    caveat:
      'Six months is a floor, not a ceiling. Sectoral rules may require longer -- HIPAA documentation retention is six years -- and the configured period governs.',
  },
  {
    provision: 'EU AI Act Art. 14',
    requirement: 'High-risk systems shall be effectively overseen by natural persons, who can intervene or interrupt.',
    strength: 'supports',
    evidence: 'Approval decisions are recorded with the identity of the approver and the action they gated.',
    caveat:
      'Human oversight is an organisational obligation. An approval queue evidences that oversight occurred; it does not establish that the overseers were competent, independent, or able to act on what they saw.',
  },
  {
    provision: 'EU AI Act Art. 17',
    requirement: 'Providers shall put a quality management system in place, including procedures for testing and validation.',
    strength: 'supports',
    evidence: 'Runs are reproducible from a pinned manifest, so evaluations are repeatable rather than one-off.',
    caveat: 'One repeatable evaluation is not a quality management system.',
  },
  {
    provision: 'NIST AI RMF Measure 2.1',
    requirement: 'Test sets, metrics and details about the tools used during TEVV are documented.',
    strength: 'satisfies',
    evidence: 'The reproducibility manifest pins environment digest, task split hash, model, sampling and verifier version.',
  },
  {
    provision: 'SR 11-7',
    requirement:
      'Model development and validation should be documented in sufficient detail that parties unfamiliar with a model can understand it.',
    strength: 'supports',
    evidence: 'The manifest and audit trail give an independent validator the exact configuration and the observed behaviour.',
    caveat: 'SR 11-7 requires independent validation by people. This supplies their inputs.',
  },
];

export interface BundleInput {
  bundleId: string;
  tenantId: string;
  runId: string;
  manifest: ReproducibilityManifest;
  entries: AuditEntry[];
  logRoot: string;
  logSize: number;
  inclusionProofs: Record<number, InclusionProof>;
  consistency?: { previousRoot: string; proof: ConsistencyProof };
  mappings?: readonly ArticleMapping[];
  retention: { retainUntil: Date; policy: string; wormAnchored: boolean };
  generatedAt?: Date;
}

/** Minimum retention under EU AI Act Art. 19. */
export const MINIMUM_RETENTION_DAYS = 183;

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

/**
 * Assemble and sign a bundle.
 *
 * Refuses to produce one that would misstate its own coverage: a retention
 * period below the Article 19 floor, or an entry without an inclusion proof.
 * A bundle that quietly omits a proof still looks complete to a reader.
 */
export async function createBundle(input: BundleInput, signer: Signer): Promise<EvidenceBundle> {
  if (input.entries.length === 0) {
    throw new BundleError('a bundle needs at least one audit entry');
  }

  const chain = verifyEntrySlice(input.entries);
  if (!chain.valid) {
    throw new BundleError(
      `refusing to sign a bundle over a broken chain: ${chain.reason}. ` +
        'Signing this would attest to records that do not verify.',
    );
  }

  for (const entry of input.entries) {
    if (!input.inclusionProofs[entry.seq]) {
      throw new BundleError(`entry ${entry.seq} has no inclusion proof`);
    }
  }

  const generatedAt = input.generatedAt ?? new Date();
  const retentionDays =
    (input.retention.retainUntil.getTime() - generatedAt.getTime()) / 86_400_000;
  if (retentionDays < MINIMUM_RETENTION_DAYS) {
    throw new BundleError(
      `retention of ${Math.floor(retentionDays)} days is below the ${MINIMUM_RETENTION_DAYS}-day ` +
        'minimum in EU AI Act Art. 19',
    );
  }

  const contents: BundleContents = {
    bundleId: input.bundleId,
    tenantId: input.tenantId,
    runId: input.runId,
    manifest: input.manifest,
    manifestDigest: manifestDigest(input.manifest),
    entries: input.entries,
    logRoot: input.logRoot,
    logSize: input.logSize,
    inclusionProofs: input.inclusionProofs,
    ...(input.consistency ? { consistency: input.consistency } : {}),
    mappings: [...(input.mappings ?? STANDARD_MAPPINGS)],
    retention: {
      retainUntil: input.retention.retainUntil.toISOString(),
      policy: input.retention.policy,
      wormAnchored: input.retention.wormAnchored,
    },
    generatedAt: generatedAt.toISOString(),
  };

  return signer.sign(contents);
}

export interface BundleVerification {
  valid: boolean;
  checks: {
    signature: boolean;
    chain: boolean;
    inclusion: boolean;
    manifest: boolean;
    retention: boolean;
  };
  failures: string[];
}

/**
 * Verify a bundle using only the bundle and a public key.
 *
 * This is the function an auditor runs. It touches no database and no network:
 * if it needed either, the bundle would not be self-contained, and a reviewer
 * would be trusting the system rather than checking it.
 */
export function verifyBundle(bundle: EvidenceBundle, publicKeyPem: string): BundleVerification {
  const failures: string[] = [];
  const checks = {
    signature: false,
    chain: false,
    inclusion: false,
    manifest: false,
    retention: false,
  };

  const sig = verifySignature(bundle, publicKeyPem);
  checks.signature = sig.valid;
  if (!sig.valid) failures.push(`signature: ${sig.reason}`);

  const contents = bundle.payload;

  const chain = verifyEntrySlice(contents.entries);
  checks.chain = chain.valid;
  if (!chain.valid) failures.push(`audit chain: ${chain.reason}`);

  // Every entry must be provably in the log whose root is cited.
  let inclusionOk = true;
  for (const entry of contents.entries) {
    const proof = contents.inclusionProofs[entry.seq];
    if (!proof) {
      failures.push(`entry ${entry.seq}: no inclusion proof`);
      inclusionOk = false;
      continue;
    }
    const leaf = Buffer.from(entry.entryHash, 'hex');
    const result = verifyInclusion(proof, leaf, contents.logRoot);
    if (!result.valid) {
      failures.push(`entry ${entry.seq}: not in the log (${result.reason})`);
      inclusionOk = false;
    }
  }
  checks.inclusion = inclusionOk;

  const recomputed = manifestDigest(contents.manifest);
  checks.manifest = recomputed === contents.manifestDigest;
  if (!checks.manifest) {
    failures.push('manifest digest does not match the manifest');
  }

  const retainUntil = Date.parse(contents.retention.retainUntil);
  const generatedAt = Date.parse(contents.generatedAt);
  const days = (retainUntil - generatedAt) / 86_400_000;
  checks.retention = days >= MINIMUM_RETENTION_DAYS;
  if (!checks.retention) {
    failures.push(`retention of ${Math.floor(days)} days is below the Art. 19 minimum`);
  }

  return { valid: failures.length === 0, checks, failures };
}

/** Stable identifier for a bundle's contents, for citing it elsewhere. */
export function bundleDigest(bundle: EvidenceBundle): string {
  return createHash('sha256').update(canonicalize(bundle.payload), 'utf8').digest('hex');
}
