/**
 * ATIF v1.7 — Agent Trajectory Interchange Format.
 *
 * A trajectory is the evidentiary record of what an agent actually did: every
 * step, the reasoning that produced it, the tool it called, what came back, and
 * what it cost. For an audit under EU AI Act Art. 12 the trajectory is the
 * thing being audited, so the schema is deliberately strict about the
 * properties that make a record admissible rather than merely well-formed.
 *
 * THREE INVARIANTS ARE LOAD-BEARING, and each is enforced rather than
 * documented:
 *
 * 1. STEP IDS ARE 1-INDEXED AND GAPLESS. `steps[i].step_id === i + 1`, always.
 *    A gap means a step was dropped or withheld, and a trajectory missing a
 *    step is not evidence of what the agent did — it is evidence of what
 *    somebody was willing to show. A 0-indexed document is rejected outright
 *    rather than silently renumbered, because renumbering would destroy the
 *    distinction between "step 1 is missing" and "steps start at 0".
 *
 * 2. TOKEN COUNTS AND COSTS ARE OBSERVED, NEVER ESTIMATED. Every metrics field
 *    is optional; a step that did not report usage records nothing rather than
 *    a plausible guess. An estimated cost that reads like a measured one is
 *    the single easiest way to make a compliance record lie.
 *
 * 3. SCREENSHOTS ARE REFERENCED BY CONTENT HASH, NEVER EMBEDDED. The document
 *    holds `sha256:<hex>` and the bytes live in the blob store. This keeps a
 *    computer-use trajectory (one screenshot per turn, hundreds of turns) from
 *    inflating the JSON that has to be canonicalized and signed, and it means
 *    the same screenshot appearing twice is stored once and is provably the
 *    same image.
 */

import { z } from 'zod';

/** The only version this build reads or writes. */
export const ATIF_VERSION = '1.7' as const;

/** `sha256:<64 lowercase hex>` — the blob store's address for a screenshot. */
export const contentRefSchema = z
  .string()
  .regex(
    /^sha256:[0-9a-f]{64}$/,
    'must be a content address "sha256:<64 hex>" — screenshots are referenced by hash, never embedded',
  );

// ------------------------------------------------------------------- agent

/**
 * Who acted.
 *
 * `system_prompt_sha256` rather than the prompt text: the prompt is often the
 * most commercially sensitive part of a deployment, and an auditor needs to
 * prove that two runs used the SAME prompt far more often than they need to
 * read it. Storing the hash makes that provable without disclosing it.
 * `system_prompt` is available for deployments that do want the text.
 */
export const agentDescriptorSchema = z
  .object({
    /** Routable identifier, "<provider>/<model-id>". */
    model_identifier: z.string().min(1),
    /** The provider's own build string, when it reports one. */
    model_version: z.string().min(1).optional(),
    provider: z.string().min(1),
    system_prompt: z.string().optional(),
    system_prompt_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * Recorded as given. Absent means the caller did not set one and the
     * provider default applied — which is not the same as 0, and must not be
     * collapsed into it.
     */
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_output_tokens: z.number().int().positive().optional(),
    /** Extended-deliberation setting, where the provider exposes one. */
    reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  })
  .strict()
  .refine((a) => a.system_prompt !== undefined || a.system_prompt_sha256 !== undefined, {
    message:
      'record either system_prompt or system_prompt_sha256 — a trajectory that cannot identify its system prompt cannot show two runs were configured alike',
  });

export type AgentDescriptor = z.infer<typeof agentDescriptorSchema>;

// ----------------------------------------------------------------- metrics

/**
 * What the step consumed.
 *
 * Every field optional and none defaulted: see invariant 2. `cost_usd` is the
 * provider's own figure where it reports one, and is otherwise absent — this
 * schema never multiplies tokens by a price table, because a computed cost
 * that later turns out to have used the wrong rate is indistinguishable in the
 * record from a reported one.
 */
export const stepMetricsSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    /** Provider-reported thinking tokens, billed separately by some APIs. */
    reasoning_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(),
    latency_ms: z.number().nonnegative().optional(),
  })
  .strict()
  .refine(
    (m) =>
      m.total_tokens === undefined ||
      m.prompt_tokens === undefined ||
      m.completion_tokens === undefined ||
      m.total_tokens >= m.prompt_tokens + m.completion_tokens,
    {
      message:
        'total_tokens is smaller than prompt_tokens + completion_tokens — the parts cannot exceed the whole',
    },
  );

export type StepMetrics = z.infer<typeof stepMetricsSchema>;

// -------------------------------------------------------------- reasoning

/**
 * Chain-of-thought.
 *
 * Mandatory to CAPTURE where the provider emits it, which is why `redacted` is
 * an explicit state rather than simply omitting the field. "The model did not
 * emit reasoning" and "the operator chose not to retain it" are different
 * facts about an audit, and a schema that cannot distinguish them lets the
 * second hide inside the first.
 */
export const reasoningTraceSchema = z
  .object({
    /** The trace itself. Absent when `redacted` is true. */
    content: z.string().optional(),
    redacted: z.boolean().default(false),
    /** Why it was withheld. Required when redacted, so somebody owns it. */
    redaction_reason: z.string().min(1).optional(),
    /** Hash of the unredacted trace, so redaction is provable, not deniable. */
    content_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /** Provider-opaque handle for a server-side reasoning item. */
    provider_trace_id: z.string().optional(),
  })
  .strict()
  .refine((r) => (r.redacted ? r.redaction_reason !== undefined : r.content !== undefined), {
    message:
      'reasoning must carry content, or be marked redacted with a reason — silence is not a third option',
  });

export type ReasoningTrace = z.infer<typeof reasoningTraceSchema>;

// ------------------------------------------------------------- tool calls

/**
 * A tool invocation and its result.
 *
 * `exit_code` is deliberately nullable rather than defaulted to 0: a tool that
 * was killed, timed out, or never completed has no exit code, and defaulting
 * it to 0 would record a successful execution that never happened.
 */
export const toolCallSchema = z
  .object({
    tool_call_id: z.string().min(1),
    name: z.string().min(1),
    /** Arguments as sent. An object, so a reviewer can diff two invocations. */
    arguments: z.record(z.unknown()),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exit_code: z.number().int().nullable().optional(),
    duration_ms: z.number().nonnegative().optional(),
    /**
     * Set when a policy stopped this call. The call is still recorded — a tool
     * call that was blocked is exactly the thing an auditor is looking for, so
     * it must survive in the trajectory rather than being dropped.
     */
    blocked_by_policy: z.string().optional(),
    /** Truncation is stated, so a short stdout is not read as a complete one. */
    output_truncated: z.boolean().default(false),
  })
  .strict();

export type ToolCall = z.infer<typeof toolCallSchema>;

// ----------------------------------------------------------- observations

/**
 * What the environment showed the agent after the action.
 *
 * `screenshot` is a content reference; the bytes live in the blob store. For a
 * computer-use agent this is the primary evidence of what the model could
 * actually see when it decided the next action.
 */
export const observationSchema = z
  .object({
    text: z.string().optional(),
    screenshot: contentRefSchema.optional(),
    /** Pixel dimensions, so a reviewer knows what was cropped or scaled. */
    screenshot_width: z.number().int().positive().optional(),
    screenshot_height: z.number().int().positive().optional(),
    /** Stored encoding. WebP and AVIF only — both lossless-capable and small. */
    screenshot_format: z.enum(['webp', 'avif', 'png']).optional(),
    /** Structured environment state, for non-visual environments. */
    state: z.record(z.unknown()).optional(),
    /** Reward or score emitted by the environment at this step, if any. */
    reward: z.number().optional(),
    terminated: z.boolean().default(false),
    truncated: z.boolean().default(false),
  })
  .strict()
  .refine((o) => o.screenshot !== undefined || o.screenshot_format === undefined, {
    message: 'screenshot_format is set without a screenshot reference',
  });

export type Observation = z.infer<typeof observationSchema>;

// ------------------------------------------------------------------ steps

export const trajectoryStepSchema = z
  .object({
    /** 1-indexed. See invariant 1; the sequence is checked at document level. */
    step_id: z.number().int().min(1, 'step_id is 1-indexed — the first step is 1, never 0'),
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }).optional(),
    /** The model's visible output for this step. */
    output_text: z.string().optional(),
    reasoning: reasoningTraceSchema.optional(),
    tool_calls: z.array(toolCallSchema).default([]),
    observation: observationSchema.optional(),
    metrics: stepMetricsSchema.optional(),
    /** Provider stop reason, verbatim. Not normalized — normalizing loses it. */
    finish_reason: z.string().optional(),
    /** Set when the step suspended for human approval (Art. 14). */
    approval_id: z.string().optional(),
    error: z.string().optional(),
  })
  .strict()
  .refine(
    (s) => s.ended_at === undefined || Date.parse(s.ended_at) >= Date.parse(s.started_at),
    { message: 'ended_at precedes started_at' },
  );

export type TrajectoryStep = z.infer<typeof trajectoryStepSchema>;

// ------------------------------------------------------------- trajectory

export const trajectorySchema = z
  .object({
    atif_version: z.literal(ATIF_VERSION),
    trial_id: z.string().min(1),
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    agent: agentDescriptorSchema,
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }).optional(),
    steps: z.array(trajectoryStepSchema),
    /** Terminal outcome. `incomplete` is honest about a trial that stopped. */
    outcome: z
      .enum(['success', 'failure', 'error', 'incomplete', 'blocked_by_policy'])
      .optional(),
    /** Verifier score for the trial, when one was computed. */
    score: z.number().optional(),
    /** Isolation the trial actually ran under, copied from the run manifest. */
    isolation_backend: z.string().optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    // Invariant 1, enforced on the whole sequence rather than per-step: a
    // per-step `min(1)` accepts [1, 1, 5] and only the sequence check rejects
    // it. This is the check that makes a trajectory a complete record.
    doc.steps.forEach((step, index) => {
      if (step.step_id !== index + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'step_id'],
          message:
            `step_id must be ${index + 1} at position ${index} but was ${step.step_id}. ` +
            'ATIF step ids are 1-indexed and gapless: a gap means a step is missing, ' +
            'and a trajectory with a missing step is not a record of what the agent did.',
        });
      }
    });
  });

export type Trajectory = z.infer<typeof trajectorySchema>;

// --------------------------------------------------------------- helpers

export class AtifError extends Error {
  constructor(
    message: string,
    readonly issues: readonly z.ZodIssue[] = [],
  ) {
    super(message);
    this.name = 'AtifError';
  }
}

/** Parse and validate an ATIF document, throwing `AtifError` on any violation. */
export function parseTrajectory(input: unknown): Trajectory {
  const result = trajectorySchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new AtifError(
      `Invalid ATIF v${ATIF_VERSION} document: ${first?.message ?? 'unknown validation failure'}`,
      result.error.issues,
    );
  }
  return result.data;
}

/**
 * The step id an append must use next.
 *
 * Derived from the length rather than from `last.step_id + 1`, because the two
 * differ exactly when the existing sequence is already corrupt — and in that
 * case the length is the value that restores the invariant.
 */
export function nextStepId(steps: readonly TrajectoryStep[]): number {
  return steps.length + 1;
}

/**
 * Append a step, enforcing the sequence.
 *
 * Returns a new array; the input is not mutated. A caller submitting the wrong
 * id is refused rather than corrected, because a client that believes it is on
 * step 7 when the server has 4 has lost steps, and silently renumbering would
 * hide that.
 */
export function appendStep(
  steps: readonly TrajectoryStep[],
  step: TrajectoryStep,
): TrajectoryStep[] {
  const expected = nextStepId(steps);
  if (step.step_id !== expected) {
    throw new AtifError(
      `Out-of-sequence step: expected step_id ${expected}, received ${step.step_id}. ` +
        'Steps are appended in order; a mismatch means the client and server disagree ' +
        'about how much of the trajectory exists.',
    );
  }
  return [...steps, step];
}

/**
 * Sum the metrics across a trajectory.
 *
 * `steps_reporting` is returned alongside each total so a consumer can tell a
 * genuine zero from an unreported one. A cost chart that draws a flat line for
 * "no provider reported usage" and for "the run was free" is lying about one
 * of them.
 */
export interface TrajectoryTotals {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms: number;
  steps: number;
  steps_reporting_tokens: number;
  steps_reporting_cost: number;
  tool_calls: number;
  blocked_tool_calls: number;
}

export function totals(traj: Pick<Trajectory, 'steps'>): TrajectoryTotals {
  const acc: TrajectoryTotals = {
    prompt_tokens: 0,
    completion_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    latency_ms: 0,
    steps: traj.steps.length,
    steps_reporting_tokens: 0,
    steps_reporting_cost: 0,
    tool_calls: 0,
    blocked_tool_calls: 0,
  };

  for (const step of traj.steps) {
    acc.tool_calls += step.tool_calls.length;
    acc.blocked_tool_calls += step.tool_calls.filter(
      (c) => c.blocked_by_policy !== undefined,
    ).length;

    const m = step.metrics;
    if (!m) continue;

    const reportedTokens =
      m.prompt_tokens !== undefined ||
      m.completion_tokens !== undefined ||
      m.total_tokens !== undefined;
    if (reportedTokens) acc.steps_reporting_tokens += 1;
    if (m.cost_usd !== undefined) acc.steps_reporting_cost += 1;

    acc.prompt_tokens += m.prompt_tokens ?? 0;
    acc.completion_tokens += m.completion_tokens ?? 0;
    acc.reasoning_tokens += m.reasoning_tokens ?? 0;
    // Prefer the provider's own total; fall back to the parts only when it is
    // absent, so a provider that counts differently is not overridden.
    acc.total_tokens += m.total_tokens ?? (m.prompt_tokens ?? 0) + (m.completion_tokens ?? 0);
    acc.cost_usd += m.cost_usd ?? 0;
    acc.latency_ms += m.latency_ms ?? 0;
  }

  // Floating-point addition of many small costs drifts; round to the
  // sub-cent precision providers actually bill at.
  acc.cost_usd = Math.round(acc.cost_usd * 1e6) / 1e6;
  return acc;
}

/** Every distinct screenshot referenced, for blob garbage collection. */
export function referencedBlobs(traj: Pick<Trajectory, 'steps'>): string[] {
  const refs = new Set<string>();
  for (const step of traj.steps) {
    if (step.observation?.screenshot) refs.add(step.observation.screenshot);
  }
  return [...refs];
}
