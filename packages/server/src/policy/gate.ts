/**
 * The tool-call gate.
 *
 * Every agent action passes through `evaluateToolCall` before it executes.
 * This is the enforcement point for EU AI Act Art. 14 (human oversight): a
 * destructive action does not run until a named person has approved it, and
 * the approval is committed to the audit log with their identity and reason.
 *
 * THE ORDER OF THE THREE CHECKS IS PART OF THE CONTRACT, and it is not
 * arbitrary:
 *
 *   1. BUDGET first. An over-budget run is terminated, not queued for a human.
 *      Asking a reviewer to approve a call that must be refused anyway wastes
 *      their attention, and reviewer attention is the scarce resource that
 *      makes Art. 14 oversight real rather than ceremonial.
 *   2. EGRESS second. A blocked destination is a hard deny with no human path:
 *      the July-2026 class of incident is an agent reaching infrastructure it
 *      was never scoped to reach, and "a reviewer can wave it through" is
 *      precisely the escape hatch that makes an allowlist decorative.
 *   3. APPROVAL last. What remains is permitted by the deployment's own limits
 *      and only needs a person to accept the consequences.
 *
 * Every outcome is a value, never an exception. A gate that throws would need a
 * try/catch at each call site and the first one that forgot would fail open.
 */

import type { PolicyDecision, PolicyEngine } from './engine.js';

export type GateOutcome = 'allow' | 'deny' | 'require_approval' | 'terminate_run';

export interface ToolCallContext {
  runId: string;
  trialId: string;
  taskId: string;
  tenantId: string;
  /** 1-indexed ATIF step this call belongs to. */
  stepId: number;
  /** Tool name as the agent asked for it. */
  tool: string;
  /** Coarse verb the policies match on: "read", "delete", "write_prod", … */
  action: string;
  arguments: Record<string, unknown>;
  /** Hostname for a network-capable tool. Absent for a purely local call. */
  domain?: string;
  /** Spend so far on this run, from observed provider figures only. */
  tokensUsed: number;
  costIncurredUsd: number;
  /** Ceilings from the run manifest. */
  budgetTokens?: number;
  maxCostUsd?: number;
  /** Cost of this specific call where it is known ahead of execution. */
  callCostUsd?: number;
}

export interface GateResult {
  outcome: GateOutcome;
  /** Written for a human reading an audit trail, not for a log grep. */
  reason: string;
  /** Which rule decided. `null` when nothing fired and the call is allowed. */
  rule: 'budget' | 'egress' | 'approval' | null;
  /** Every decision consulted, in order, for the audit record. */
  decisions: PolicyDecision[];
  /** Set when the outcome is `require_approval`. */
  approvalAction?: string;
}

/**
 * Actions that can destroy or exfiltrate, listed here rather than only in Rego.
 *
 * This is defence in depth against a specific failure: if the bundle is missing
 * the engine fails closed and `require_approval` defaults to true, which is
 * correct — but that default is uniform. This set lets the gate say WHICH
 * action it is refusing to guess about, so the audit record and the reviewer's
 * queue both carry a meaningful reason rather than "policy unavailable".
 *
 * It is deliberately a superset of the Rego list. Rego stays authoritative for
 * allowing; this only ever makes the outcome more restrictive.
 */
const KNOWN_DESTRUCTIVE = new Set([
  'delete',
  'drop_db',
  'write_prod',
  'deploy',
  'transfer_funds',
  'send_email',
  'exec_shell',
  'modify_iam',
  'rotate_credentials',
]);

export interface GateOptions {
  /**
   * Refuse anything the policy engine could not evaluate.
   *
   * Default true. Set false only for a deployment that has consciously accepted
   * running without policy — the run's evidence records it either way.
   */
  strict?: boolean;
}

export async function evaluateToolCall(
  engine: PolicyEngine,
  ctx: ToolCallContext,
  options: GateOptions = {},
): Promise<GateResult> {
  const strict = options.strict ?? true;
  const decisions: PolicyDecision[] = [];

  // --- 1. Budget ----------------------------------------------------------
  // Checked first so an over-budget run terminates instead of queuing work for
  // a reviewer that must be refused regardless of their answer.
  if (ctx.budgetTokens !== undefined || ctx.maxCostUsd !== undefined) {
    const projectedCost = ctx.costIncurredUsd + (ctx.callCostUsd ?? 0);
    const { result: overBudget, decision } = await engine.decideBoolean(
      'agenteval/budget/deny_budget',
      {
        tokens_used: ctx.tokensUsed,
        budget_limit: ctx.budgetTokens ?? Number.MAX_SAFE_INTEGER,
        cost_incurred: projectedCost,
        max_cost: ctx.maxCostUsd ?? Number.MAX_SAFE_INTEGER,
      },
      // Fails closed at TRUE: unable to prove the run is within budget, stop.
      strict,
    );
    decisions.push(decision);

    if (overBudget) {
      const limit =
        ctx.budgetTokens !== undefined && ctx.tokensUsed > ctx.budgetTokens
          ? `${ctx.tokensUsed} tokens used against a ${ctx.budgetTokens} limit`
          : `$${projectedCost.toFixed(4)} against a $${(ctx.maxCostUsd ?? 0).toFixed(4)} cap`;
      return {
        outcome: 'terminate_run',
        reason: decision.evaluated
          ? `Run exceeded its budget: ${limit}.`
          : `Budget could not be verified (${decision.unavailableReason}), so the run was stopped.`,
        rule: 'budget',
        decisions,
      };
    }
  }

  // --- 2. Egress ----------------------------------------------------------
  // Only for calls that name a destination. A local file read has no domain,
  // and demanding one would make every allowlist include the empty string.
  if (ctx.domain !== undefined) {
    const { result: allowed, decision } = await engine.decideBoolean(
      'agenteval/egress/allow_egress',
      { task_id: ctx.taskId, domain: ctx.domain, tool: ctx.tool },
      // Fails closed at FALSE: an unverifiable destination is not reachable.
      !strict,
    );
    decisions.push(decision);

    if (!allowed) {
      return {
        outcome: 'deny',
        reason: decision.evaluated
          ? `Egress to "${ctx.domain}" is not on the allowlist for task ${ctx.taskId}.`
          : `Egress to "${ctx.domain}" could not be authorized (${decision.unavailableReason}).`,
        rule: 'egress',
        decisions,
      };
    }
  }

  // --- 3. Approval --------------------------------------------------------
  const { result: needsApproval, decision } = await engine.decideBoolean(
    'agenteval/approval/require_approval',
    {
      action: ctx.action,
      tool: ctx.tool,
      cost: ctx.callCostUsd ?? 0,
      run_id: ctx.runId,
      task_id: ctx.taskId,
    },
    // Fails closed at TRUE: unable to prove a call is safe, ask a person.
    strict,
  );
  decisions.push(decision);

  // The local list can only add restriction, never remove it.
  const locallyDestructive = KNOWN_DESTRUCTIVE.has(ctx.action);

  if (needsApproval || locallyDestructive) {
    const why = !decision.evaluated
      ? `policy could not be evaluated (${decision.unavailableReason})`
      : needsApproval
        ? 'policy requires human approval for this action'
        : `"${ctx.action}" is a destructive action`;
    return {
      outcome: 'require_approval',
      reason: `Step ${ctx.stepId} calling "${ctx.tool}" was suspended: ${why}.`,
      rule: 'approval',
      decisions,
      approvalAction: `${ctx.tool}:${ctx.action}`,
    };
  }

  return {
    outcome: 'allow',
    reason: `No policy objected to "${ctx.tool}" (${ctx.action}).`,
    rule: null,
    decisions,
  };
}

/**
 * Flatten a gate result for the audit log.
 *
 * The bundle digest is included so a historical decision can be replayed
 * against the exact policy that produced it — an allow that a later policy
 * would deny is not a contradiction, and the record has to be able to show
 * which version was in force.
 */
export function auditPayload(ctx: ToolCallContext, result: GateResult): Record<string, unknown> {
  return {
    runId: ctx.runId,
    trialId: ctx.trialId,
    stepId: ctx.stepId,
    tool: ctx.tool,
    action: ctx.action,
    ...(ctx.domain !== undefined ? { domain: ctx.domain } : {}),
    outcome: result.outcome,
    reason: result.reason,
    rule: result.rule,
    policyBundle: result.decisions[0]?.bundleDigest ?? 'unloaded',
    // Every decision consulted, so "why was this allowed" is answerable
    // without re-running anything.
    evaluations: result.decisions.map((d) => ({
      entrypoint: d.entrypoint,
      evaluated: d.evaluated,
      value: d.value,
      ...(d.unavailableReason ? { unavailableReason: d.unavailableReason } : {}),
    })),
  };
}
