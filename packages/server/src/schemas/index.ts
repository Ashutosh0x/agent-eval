/**
 * Request and response schemas, shared with the SDK.
 *
 * Validation here is not input hygiene. Most of these rules exist because
 * accepting the value would produce a record that cannot serve as evidence
 * later -- an image referenced by tag, an approval with no reason, a run whose
 * toolchain is unknown. Rejecting at the edge means the failure is a 422 a
 * client can fix, rather than a bundle that looks complete and is not.
 */

import { z } from 'zod';

/** sha256:<64 hex>. Tags move; digests do not. */
export const digestSchema = z
  .string()
  .regex(
    /^sha256:[0-9a-f]{64}$/,
    'must be pinned as "sha256:<64 hex>" — a tag can point at different software later',
  );

export const hexHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-character hex sha256');

export const cursorSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------- environments

export const importEnvironmentSchema = z.object({
  source: z.string().min(1).describe('Registry or Hub reference'),
  pin: digestSchema,
  displayName: z.string().min(1).max(200).optional(),
  openEnvSpecVersion: z.number().int().positive().optional(),
});

export type ImportEnvironmentInput = z.infer<typeof importEnvironmentSchema>;

// ----------------------------------------------------------------------- runs

export const samplingSchema = z
  .record(z.unknown())
  .refine((s) => Object.keys(s).length > 0, {
    message:
      'sampling parameters must be recorded; two runs at different temperatures are not comparable',
  });

export const startRunSchema = z.object({
  environmentId: z.string().min(1),
  environmentDigest: digestSchema,
  taskSetId: z.string().min(1),
  taskSetVersion: z.string().min(1),
  split: z.string().min(1),
  verifierId: z.string().min(1),
  verifierVersion: z.string().min(1),
  model: z.object({
    identifier: z.string().min(1),
    sampling: samplingSchema,
    providerVersion: z.string().optional(),
  }),
  // Explicitly nullable rather than optional: "this run was not seeded" is a
  // fact worth recording, and an absent field cannot say it.
  seed: z.number().int().nullable(),
  isolationBackend: z.enum(['firecracker', 'cloud-hypervisor', 'gvisor', 'kata', 'trusted-dev']),
  toolchain: z
    .record(z.string())
    .refine((t) => Object.keys(t).length > 0, {
      message: 'toolchain must record at least the platform version',
    }),
  retentionRules: z.array(z.string().min(1)).min(1, 'at least one retention basis is required'),
  budget: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
      maxWallClockSeconds: z.number().int().positive().optional(),
    })
    .optional(),
});

export type StartRunInput = z.infer<typeof startRunSchema>;

export const compareRunsSchema = z.object({
  runA: z.string().min(1),
  runB: z.string().min(1),
});

// ------------------------------------------------------------------ approvals

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'escalate']),
  /**
   * Required on every decision including approve. An approval with no recorded
   * reason evidences that a click happened, not that oversight occurred --
   * which is the distinction Art. 14 turns on.
   */
  rationale: z
    .string({
      // A separate message for the absent case: `.min()` only fires when the
      // field is present, so omitting it entirely would return a bare
      // "Required" that says nothing about why.
      required_error:
        'a rationale is required on every decision, including approve — an approval ' +
        'with no recorded reason evidences that a click happened, not that oversight occurred',
      invalid_type_error: 'rationale must be text',
    })
    .trim()
    .min(10, 'a rationale of at least 10 characters is required on every decision'),
  escalateTo: z.string().optional(),
});

export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

// ------------------------------------------------------------------- evidence

export const generateBundleSchema = z.object({
  runId: z.string().min(1),
  retentionRules: z.array(z.string().min(1)).min(1),
  includeConsistencyProofFrom: z.number().int().nonnegative().optional(),
});

export type GenerateBundleInput = z.infer<typeof generateBundleSchema>;

export const verifyBundleSchema = z.object({
  bundle: z.unknown(),
  publicKeyPem: z.string().min(1).optional(),
});

// ------------------------------------------------------------------ api keys

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'a key needs a name').max(80),
  description: z.string().trim().max(300).optional(),
  scopes: z
    .array(z.string().min(1))
    .min(1, 'a key with no scopes can do nothing; select at least one'),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

// ---------------------------------------------------------------------- audit

export const auditQuerySchema = cursorSchema.extend({
  actor: z.string().optional(),
  action: z.string().optional(),
  subject: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const consistencyQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative(),
});

// --------------------------------------------------------------------- errors

/** RFC 9457 problem detail. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  field?: string;
  instance?: string;
}

export const PROBLEM_BASE = 'https://agent-eval.dev/errors';

export function problem(
  slug: string,
  title: string,
  status: number,
  detail?: string,
  field?: string,
): Problem {
  return {
    type: `${PROBLEM_BASE}/${slug}`,
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(field ? { field } : {}),
  };
}

/** Turn a Zod failure into a problem document naming the offending field. */
export function problemFromZod(error: z.ZodError, title = 'Request is not valid'): Problem {
  const first = error.issues[0];
  return problem(
    'validation-failed',
    title,
    422,
    first?.message,
    first?.path.length ? first.path.join('.') : undefined,
  );
}
