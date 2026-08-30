/**
 * The evidence layer.
 *
 * Everything here is pure and dependency-free beyond node:crypto, so the parts
 * a regulator cares about can be reasoned about — and reimplemented — without
 * standing up the platform.
 */

export {
  MerkleTree,
  hashLeaf,
  hashNode,
  type ConsistencyProof,
  type InclusionProof,
} from './merkle-tree.js';

export {
  verifyConsistency,
  verifyInclusion,
  type VerificationResult,
} from './proof-verifier.js';

export {
  AuditLog,
  GENESIS_HASH,
  entryDigest,
  verifyChain,
  verifyEntrySlice,
  type AuditEntry,
  type AuditEventInput,
  type ChainVerification,
} from './audit-log.js';

export {
  InMemoryKeySource,
  Signer,
  verifySignature,
  type KeySource,
  type Signature,
  type SignedEnvelope,
} from './signer.js';

export {
  canonicalize,
  CanonicalizationError,
  type CanonicalValue,
} from './canonical.js';

export {
  comparable,
  createManifest,
  hashSplit,
  manifestDigest,
  ManifestError,
  type ReproducibilityManifest,
} from './reproducibility.js';

export {
  MINIMUM_RETENTION_DAYS,
  STANDARD_MAPPINGS,
  BundleError,
  bundleDigest,
  createBundle,
  verifyBundle,
  type ArticleMapping,
  type BundleContents,
  type BundleVerification,
  type EvidenceBundle,
  type MappingStrength,
} from './evidence-bundle.js';

export {
  ART_19_MINIMUM_DAYS,
  STANDARD_RULES,
  RetentionError,
  assessAnchor,
  planExpiry,
  resolveRetention,
  type AnchorAssessment,
  type ExpiryPlan,
  type LockMode,
  type ResolvedRetention,
  type RetentionRule,
  type WormAnchor,
} from './retention.js';
