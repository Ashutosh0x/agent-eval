/**
 * The Evaluation Passport.
 *
 * A single signed artifact answering, for one model on one benchmark:
 * what ran, on what hardware, how well it did, how uncertain that is, what it
 * cost, and whether any of it can be checked by someone who does not trust
 * this server.
 *
 * THE ONE RULE THAT SHAPES THE WHOLE FILE:
 *
 *   A passport may never claim to be verified unless the evidence to verify it
 *   is inside it.
 *
 * `provenanceClass` is therefore DERIVED, never assigned. There is no
 * constructor parameter, no field and no override that lets a caller declare
 * its own result independently verified. The class falls out of what evidence
 * is actually present, so the only way to obtain the strongest claim is to
 * have produced the evidence that backs it. A vendor importing their own
 * numbers gets SELF_REPORTED because that is what the artifact supports —
 * not because we chose to be sceptical about them.
 *
 * This matters most at the export boundary. A result published to a public
 * leaderboard carries its class with it, and a self-reported number marked as
 * verified would launder a claim through our signature.
 */

import { createHash } from 'node:crypto';
import type { SignedEnvelope, Signer } from '../evidence/signer.js';
import { verifySignature } from '../evidence/signer.js';
import {
  deploymentDigest,
  executionDigest,
  modelDigest,
  pinningStrength,
  type DeploymentIdentity,
  type ModelIdentity,
} from './identity.js';

/**
 * How much a reader should trust a number.
 *
 * Ordered weakest to strongest. The names mirror the distinction public model
 * hubs already draw between author-submitted, community-submitted and
 * independently verified results, so an exported passport lands in a category
 * consumers already understand.
 */
export type ProvenanceClass =
  /** The party being measured produced the number. No independent check. */
  | 'SELF_REPORTED'
  /** A third party produced it, but supplied no verifiable evidence. */
  | 'COMMUNITY_REPORTED'
  /** Produced here, with evidence anyone can verify offline. */
  | 'AGENT_EVAL_VERIFIED';

/** Digests binding a passport to the artifacts that produced it. */
export interface ArtifactDigests {
  /** The exact weights. See identity.ts. */
  model: string;
  /** The serving stack and hardware. */
  deployment: string;
  /** Benchmark definition at a specific revision. */
  benchmark: string;
  /** Environment image or definition. */
  environment?: string;
  /** The scoring implementation. */
  verifier?: string;
  scorer?: string;
  /** Judge configuration, where an LLM judge took part. */
  judge?: string;
  /** Root over the trajectories this result summarises. */
  trajectories?: string;
}

/** What was measured. Every field observed, never estimated. */
export interface PassportMetrics {
  /** Fraction in [0,1]. The headline number. */
  successRate: number;
  tasksAttempted: number;
  tasksSucceeded: number;
  /** Independent attempts per task. 1 means a single sample. */
  trials: number;
  meanScore?: number;
  medianScore?: number;
  /** pass@k, keyed by k. */
  passAtK?: Readonly<Record<string, number>>;
}

/**
 * How uncertain the headline number is.
 *
 * Mandatory rather than optional. A score without an interval invites a
 * comparison the sample size does not support, and the entire point of a
 * passport is to make that impossible to do accidentally.
 */
export interface PassportStatistics {
  /** Lower and upper bound of the confidence interval on `successRate`. */
  confidenceIntervalLow: number;
  confidenceIntervalHigh: number;
  /** Usually 0.95. Recorded because it is not always. */
  confidenceLevel: number;
  /** How the interval was computed, e.g. "wilson", "bootstrap". */
  method: string;
  standardDeviation?: number;
  /**
   * The smallest difference this sample size could actually resolve.
   *
   * Two models inside this distance are not distinguishable by this
   * evaluation, however different their point estimates look.
   */
  minimumReportableDifference?: number;
}

export interface PassportEconomics {
  inputTokens?: number;
  outputTokens?: number;
  /** Absent means unknown. Never zero-as-unknown — see models/cost.ts. */
  totalCostUsd?: number;
  costPerSuccessUsd?: number;
  /** Wall-clock seconds of accelerator occupancy, for self-hosted runs. */
  acceleratorSeconds?: number;
  /** Joules, where the platform could actually measure it. */
  energyJoules?: number;
  meanLatencyMs?: number;
}

/**
 * Evidence a third party can check without this server.
 *
 * Its presence is what promotes a passport to AGENT_EVAL_VERIFIED, which is
 * why the fields are not optional decoration: they are the claim.
 */
export interface PassportEvidence {
  /** RFC 6962 root over the audit entries covering this evaluation. */
  merkleRoot: string;
  /** Number of leaves, needed to verify an inclusion proof against the root. */
  treeSize: number;
  /** Identifier of the bundle holding the proofs and entries. */
  bundleId: string;
  /** Key that signed the audit log, distinct from the passport signature. */
  logSigningKeyId?: string;
}

/** The signed body. Everything a verifier needs, and nothing secret. */
export interface PassportPayload {
  /** Schema version. A verifier refuses a version it does not implement. */
  passportVersion: '1.0';
  passportId: string;
  issuedAt: string;
  /** The software that produced this. Part of provenance. */
  issuer: {
    name: string;
    version: string;
  };

  model: ModelIdentity;
  deployment: DeploymentIdentity;
  benchmarkId: string;
  benchmarkVersion: string;

  digests: ArtifactDigests;
  metrics: PassportMetrics;
  statistics: PassportStatistics;
  economics?: PassportEconomics;
  evidence?: PassportEvidence;

  /**
   * Derived, not supplied. See the file header.
   *
   * It is inside the signed payload so tampering with the class invalidates
   * the signature — otherwise a consumer could upgrade a self-reported result
   * to verified by editing one field.
   */
  provenanceClass: ProvenanceClass;

  /** How firmly the model was pinned, and what that means for reproduction. */
  reproducibility: {
    pinning: ReturnType<typeof pinningStrength>['strength'];
    detail: string;
  };

  /** Caveats a reader must see. Never empty when something is wrong. */
  caveats: string[];
}

export type Passport = SignedEnvelope<PassportPayload>;

export interface IssuePassportInput {
  passportId: string;
  issuerVersion: string;
  model: ModelIdentity;
  deployment: DeploymentIdentity;
  benchmarkId: string;
  benchmarkVersion: string;
  benchmarkDigest: string;
  environmentDigest?: string;
  verifierDigest?: string;
  scorerDigest?: string;
  judgeDigest?: string;
  trajectoriesDigest?: string;
  metrics: PassportMetrics;
  statistics: PassportStatistics;
  economics?: PassportEconomics;
  /** Supply only for a result this deployment actually produced. */
  evidence?: PassportEvidence;
  /**
   * True when the numbers came from the party being measured.
   *
   * This can only ever WEAKEN the class. It cannot promote anything, so a
   * dishonest caller passing `false` gains nothing: without evidence the
   * result is still not verified.
   */
  selfReported?: boolean;
}

/**
 * Decide the provenance class from what is actually present.
 *
 * Deliberately not exported as something a caller can override. The whole
 * value of the class is that it cannot be asserted.
 */
function deriveProvenanceClass(input: IssuePassportInput): {
  provenanceClass: ProvenanceClass;
  caveats: string[];
} {
  const caveats: string[] = [];

  const hasEvidence =
    input.evidence !== undefined &&
    input.evidence.merkleRoot.length > 0 &&
    input.evidence.treeSize > 0;

  if (input.selfReported) {
    caveats.push(
      'Reported by the party being measured. No independent execution took place, so the ' +
        'numbers cannot be checked against a trajectory.',
    );
    // Evidence supplied alongside a self-reported claim does not promote it:
    // the evidence would attest to an import, not to an execution.
    return { provenanceClass: 'SELF_REPORTED', caveats };
  }

  if (!hasEvidence) {
    caveats.push(
      'No evidence bundle is attached, so this result cannot be verified offline. It records ' +
        'what was claimed, not what was proven.',
    );
    return { provenanceClass: 'COMMUNITY_REPORTED', caveats };
  }

  return { provenanceClass: 'AGENT_EVAL_VERIFIED', caveats };
}

/** Caveats that depend on the measurement rather than its provenance. */
function measurementCaveats(input: IssuePassportInput): string[] {
  const out: string[] = [];
  const { metrics, statistics } = input;

  if (metrics.trials === 1) {
    out.push(
      'A single trial per task. Stochastic sampling means a repeat run may differ, and the ' +
        'interval below reflects task sampling only, not sampling variance.',
    );
  }
  if (metrics.tasksAttempted < 30) {
    out.push(
      `Only ${metrics.tasksAttempted} task(s) were attempted. The confidence interval is wide ` +
        'and small differences between models are not resolvable at this sample size.',
    );
  }
  const width = statistics.confidenceIntervalHigh - statistics.confidenceIntervalLow;
  if (width > 0.2) {
    out.push(
      `The ${(statistics.confidenceLevel * 100).toFixed(0)}% interval spans ` +
        `${(width * 100).toFixed(1)} ` +
        'percentage points. Treat the point estimate as indicative only.',
    );
  }
  const pin = pinningStrength(input.model);
  if (pin.strength === 'unpinned' || pin.strength === 'alias') {
    out.push(pin.reason);
  }
  if (!input.economics || input.economics.totalCostUsd === undefined) {
    out.push('Cost was not recorded or no pricing was configured, so it is reported as unknown.');
  }
  return out;
}

/**
 * Build and sign a passport.
 *
 * The signature covers the canonical JSON of the payload, so any edit — to a
 * score, a digest, or the provenance class — invalidates it.
 */
export async function issuePassport(
  signer: Signer,
  input: IssuePassportInput,
): Promise<Passport> {
  const { provenanceClass, caveats } = deriveProvenanceClass(input);
  const pin = pinningStrength(input.model);

  const payload: PassportPayload = {
    passportVersion: '1.0',
    passportId: input.passportId,
    issuedAt: new Date().toISOString(),
    issuer: { name: 'agent-eval', version: input.issuerVersion },

    model: input.model,
    deployment: input.deployment,
    benchmarkId: input.benchmarkId,
    benchmarkVersion: input.benchmarkVersion,

    digests: {
      model: modelDigest(input.model),
      deployment: deploymentDigest(input.deployment),
      benchmark: input.benchmarkDigest,
      ...(input.environmentDigest ? { environment: input.environmentDigest } : {}),
      ...(input.verifierDigest ? { verifier: input.verifierDigest } : {}),
      ...(input.scorerDigest ? { scorer: input.scorerDigest } : {}),
      ...(input.judgeDigest ? { judge: input.judgeDigest } : {}),
      ...(input.trajectoriesDigest ? { trajectories: input.trajectoriesDigest } : {}),
    },
    metrics: input.metrics,
    statistics: input.statistics,
    ...(input.economics ? { economics: input.economics } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),

    provenanceClass,
    reproducibility: { pinning: pin.strength, detail: pin.reason },
    caveats: [...caveats, ...measurementCaveats(input)],
  };

  return signer.sign(payload);
}

// ------------------------------------------------------------- verification

export interface PassportVerification {
  valid: boolean;
  /** Every check performed, so a failure names itself. */
  checks: { name: string; passed: boolean; detail: string }[];
  /** The class the evidence actually supports, recomputed independently. */
  supportedClass: ProvenanceClass;
  reason?: string;
}

/**
 * Verify a passport without this server.
 *
 * Checks the signature, that the digests inside match the identities they
 * claim to cover, and — importantly — that the provenance class is one the
 * attached evidence actually supports. A passport that says VERIFIED with no
 * evidence fails here even when its signature is valid, because a correctly
 * signed false claim is exactly the failure mode this guards.
 */
export function verifyPassport(passport: Passport, publicKeyPem: string): PassportVerification {
  const checks: PassportVerification['checks'] = [];
  const payload = passport.payload;

  const sig = verifySignature(passport, publicKeyPem);
  checks.push({
    name: 'signature',
    passed: sig.valid,
    detail: sig.valid
      ? `Ed25519 signature valid for key ${passport.signature.keyId}.`
      : `Signature invalid: ${sig.reason ?? 'unknown reason'}.`,
  });

  if (payload.passportVersion !== '1.0') {
    checks.push({
      name: 'version',
      passed: false,
      detail: `Unsupported passport version "${payload.passportVersion}".`,
    });
    return {
      valid: false,
      checks,
      supportedClass: 'COMMUNITY_REPORTED',
      reason: 'Unsupported passport version.',
    };
  }

  // Recomputed, not trusted. A digest that does not match its own identity
  // block means the two were assembled from different runs.
  const recomputedModel = modelDigest(payload.model);
  checks.push({
    name: 'model_digest',
    passed: recomputedModel === payload.digests.model,
    detail:
      recomputedModel === payload.digests.model
        ? 'Model digest matches the recorded model identity.'
        : `Model digest mismatch: payload says ${payload.digests.model}, identity hashes to ${recomputedModel}.`,
  });

  const recomputedDeployment = deploymentDigest(payload.deployment);
  checks.push({
    name: 'deployment_digest',
    passed: recomputedDeployment === payload.digests.deployment,
    detail:
      recomputedDeployment === payload.digests.deployment
        ? 'Deployment digest matches the recorded deployment identity.'
        : `Deployment digest mismatch: payload says ${payload.digests.deployment}, identity hashes to ${recomputedDeployment}.`,
  });

  // The claim check. Evidence present and non-empty is the only thing that
  // supports the strongest class.
  const hasEvidence =
    payload.evidence !== undefined &&
    payload.evidence.merkleRoot.length > 0 &&
    payload.evidence.treeSize > 0;
  const supportedClass: ProvenanceClass = hasEvidence
    ? 'AGENT_EVAL_VERIFIED'
    : 'COMMUNITY_REPORTED';

  const classHonest =
    payload.provenanceClass !== 'AGENT_EVAL_VERIFIED' || hasEvidence;
  checks.push({
    name: 'provenance_class',
    passed: classHonest,
    detail: classHonest
      ? `Class ${payload.provenanceClass} is supported by the attached evidence.`
      : 'Passport claims AGENT_EVAL_VERIFIED but carries no evidence bundle. ' +
        'A valid signature over a false claim is still a false claim.',
  });

  // Arithmetic the passport asserts about itself.
  const m = payload.metrics;
  const rateConsistent =
    m.tasksAttempted === 0 ||
    Math.abs(m.successRate - m.tasksSucceeded / m.tasksAttempted) < 1e-9;
  checks.push({
    name: 'metrics_consistency',
    passed: rateConsistent,
    detail: rateConsistent
      ? 'Success rate matches the recorded task counts.'
      : `Success rate ${m.successRate} does not match ${m.tasksSucceeded}/${m.tasksAttempted}.`,
  });

  const intervalSane =
    payload.statistics.confidenceIntervalLow <= payload.statistics.confidenceIntervalHigh &&
    payload.statistics.confidenceIntervalLow >= 0 &&
    payload.statistics.confidenceIntervalHigh <= 1;
  checks.push({
    name: 'interval_sanity',
    passed: intervalSane,
    detail: intervalSane
      ? 'Confidence interval is well-formed.'
      : 'Confidence interval is inverted or outside [0,1].',
  });

  const failed = checks.filter((c) => !c.passed);
  return {
    valid: failed.length === 0,
    checks,
    supportedClass,
    ...(failed.length > 0 ? { reason: failed.map((f) => f.name).join(', ') } : {}),
  };
}

/** Stable id for a passport, from what it measures. */
export function passportId(input: {
  execution: string;
  benchmarkDigest: string;
  issuedAt: string;
}): string {
  const h = createHash('sha256');
  h.update('passport-id:v1\n');
  h.update(`${input.execution}\n${input.benchmarkDigest}\n${input.issuedAt}\n`);
  return `psp_${h.digest('hex').slice(0, 32)}`;
}

export { executionDigest };
