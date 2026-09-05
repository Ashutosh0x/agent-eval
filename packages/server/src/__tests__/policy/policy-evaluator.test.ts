/**
 * The policy engine and the tool-call gate.
 *
 * These tests run the REAL compiled WASM bundle, not a stub. That matters: the
 * point of the exercise is that the Rego under `policies/` actually decides
 * things, and a mocked engine would prove only that the plumbing is connected.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { PolicyEngine } from '../../policy/engine.js';
import { evaluateToolCall, auditPayload, type ToolCallContext } from '../../policy/gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, '../../../policy-bundle/policy.wasm');

/** Data the policies read via `data.*`. */
const POLICY_DATA = {
  budget: { threshold: 100 },
  task_allowlist: {
    'task-web': ['example.com', 'api.example.com'],
    'task-offline': [],
  },
};

function ctx(over: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    runId: 'run-1',
    trialId: 'trial-1',
    taskId: 'task-web',
    tenantId: 'tenant-1',
    stepId: 1,
    tool: 'http_get',
    action: 'read',
    arguments: {},
    tokensUsed: 0,
    costIncurredUsd: 0,
    ...over,
  };
}

describe('the bundle exists', () => {
  it('was built by scripts/build-policy-bundle.sh', () => {
    // If this fails the rest of the file is testing nothing, so it is asserted
    // rather than skipped.
    expect(existsSync(BUNDLE)).toBe(true);
  });
});

describe('PolicyEngine — real WASM', () => {
  let engine: PolicyEngine;

  beforeAll(async () => {
    engine = new PolicyEngine({ bundlePath: BUNDLE, data: POLICY_DATA });
    await engine.load();
  });

  it('loads and reports ready', () => {
    expect(engine.ready).toBe(true);
    expect(engine.unavailableReason).toBeNull();
  });

  it('pins every decision to the bundle digest', async () => {
    const d = await engine.evaluate('agenteval/approval/require_approval', { action: 'read' });
    // Without this an auditor cannot tell which policy version allowed a call.
    expect(d.bundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(engine.bundleDigest).toBe(d.bundleDigest);
  });

  it('evaluates approval-required.rego: destructive actions need a human', async () => {
    for (const action of ['delete', 'write_prod', 'drop_db']) {
      const { result, decision } = await engine.decideBoolean(
        'agenteval/approval/require_approval',
        { action },
        true,
      );
      expect(decision.evaluated).toBe(true);
      expect(`${action}:${result}`).toBe(`${action}:true`);
    }
  });

  it('evaluates approval-required.rego: a safe read does not', async () => {
    const { result, decision } = await engine.decideBoolean(
      'agenteval/approval/require_approval',
      { action: 'read', tool: 'http_get', cost: 1 },
      true,
    );
    expect(decision.evaluated).toBe(true);
    expect(result).toBe(false);
  });

  it('evaluates approval-required.rego: restricted tools need a human', async () => {
    const { result } = await engine.decideBoolean(
      'agenteval/approval/require_approval',
      { action: 'read', tool: 'shell' },
      true,
    );
    expect(result).toBe(true);
  });

  it('reads data.budget.threshold from injected data, not from the bundle', async () => {
    // threshold is 100; 150 is over, 50 is under. This proves external data
    // reaches the policy, which is what lets a deployment retune without
    // recompiling Rego.
    const over = await engine.decideBoolean(
      'agenteval/approval/require_approval',
      { action: 'read', cost: 150 },
      true,
    );
    const under = await engine.decideBoolean(
      'agenteval/approval/require_approval',
      { action: 'read', cost: 50 },
      true,
    );
    expect(over.result).toBe(true);
    expect(under.result).toBe(false);
  });

  it('evaluates egress-allowlist.rego against the per-task allowlist', async () => {
    const allowed = await engine.decideBoolean(
      'agenteval/egress/allow_egress',
      { task_id: 'task-web', domain: 'example.com' },
      false,
    );
    const denied = await engine.decideBoolean(
      'agenteval/egress/allow_egress',
      { task_id: 'task-web', domain: 'evil.example.net' },
      false,
    );
    expect(allowed.result).toBe(true);
    expect(denied.result).toBe(false);
  });

  it('denies egress for a task with an empty allowlist', async () => {
    const { result } = await engine.decideBoolean(
      'agenteval/egress/allow_egress',
      { task_id: 'task-offline', domain: 'example.com' },
      false,
    );
    expect(result).toBe(false);
  });

  it('denies egress for a task that has no allowlist entry at all', async () => {
    // An unknown task must not inherit permission from a missing key.
    const { result } = await engine.decideBoolean(
      'agenteval/egress/allow_egress',
      { task_id: 'task-never-configured', domain: 'example.com' },
      false,
    );
    expect(result).toBe(false);
  });
});

describe('PolicyEngine — fails closed', () => {
  it('reports unavailable rather than throwing when the bundle is missing', async () => {
    const engine = new PolicyEngine({ bundlePath: '/nonexistent/policy.wasm' });
    const decision = await engine.evaluate('agenteval/approval/require_approval', {});
    expect(decision.evaluated).toBe(false);
    expect(engine.ready).toBe(false);
    expect(decision.unavailableReason).toMatch(/could not be loaded/i);
  });

  it('honours the caller-supplied safe default in both polarities', async () => {
    // The polarity is per-rule and cannot be a single global default:
    // require_approval fails closed at TRUE, allow_egress at FALSE.
    const engine = new PolicyEngine({ bundlePath: '/nonexistent/policy.wasm' });
    const approval = await engine.decideBoolean('agenteval/approval/require_approval', {}, true);
    const egress = await engine.decideBoolean('agenteval/egress/allow_egress', {}, false);
    expect(approval.result).toBe(true);
    expect(egress.result).toBe(false);
  });

  it('does not throw when the loaded policy throws', async () => {
    const engine = new PolicyEngine({
      bundlePath: BUNDLE,
      loader: async () => ({
        setData() {},
        evaluate() {
          throw new Error('wasm trap');
        },
      }),
    });
    const decision = await engine.evaluate('agenteval/approval/require_approval', {});
    expect(decision.evaluated).toBe(false);
    expect(decision.unavailableReason).toMatch(/threw: wasm trap/);
  });

  it('treats an empty result set as unevaluated, not as false', async () => {
    // opa-wasm returns [] for an undefined document. Reading that as `false`
    // would turn "the rule did not apply" into "the rule permitted it".
    const engine = new PolicyEngine({
      bundlePath: BUNDLE,
      loader: async () => ({ setData() {}, evaluate: () => [] }),
    });
    const { result, decision } = await engine.decideBoolean(
      'agenteval/egress/allow_egress',
      {},
      false,
    );
    expect(decision.evaluated).toBe(false);
    expect(result).toBe(false);
  });

  it('treats a non-boolean from a boolean rule as unevaluated', async () => {
    const engine = new PolicyEngine({
      bundlePath: BUNDLE,
      loader: async () => ({ setData() {}, evaluate: () => [{ result: 'yes' }] }),
    });
    const { result, decision } = await engine.decideBoolean(
      'agenteval/approval/require_approval',
      {},
      true,
    );
    expect(decision.evaluated).toBe(false);
    expect(result).toBe(true);
  });
});

describe('the tool-call gate', () => {
  let engine: PolicyEngine;

  beforeAll(async () => {
    engine = new PolicyEngine({ bundlePath: BUNDLE, data: POLICY_DATA });
    await engine.load();
  });

  it('allows a safe read to an allowlisted domain', async () => {
    const r = await evaluateToolCall(engine, ctx({ domain: 'example.com' }));
    expect(r.outcome).toBe('allow');
    expect(r.rule).toBeNull();
  });

  it('halts a destructive action for human approval', async () => {
    const r = await evaluateToolCall(engine, ctx({ tool: 'db', action: 'drop_db' }));
    expect(r.outcome).toBe('require_approval');
    expect(r.rule).toBe('approval');
    expect(r.approvalAction).toBe('db:drop_db');
  });

  it('denies egress to a domain outside the task allowlist', async () => {
    const r = await evaluateToolCall(engine, ctx({ domain: 'huggingface.co' }));
    expect(r.outcome).toBe('deny');
    expect(r.rule).toBe('egress');
    expect(r.reason).toContain('huggingface.co');
  });

  it('gives egress NO human-approval path', async () => {
    // An allowlist a reviewer can wave through is decorative. Even a
    // destructive action to a blocked domain must deny rather than escalate.
    const r = await evaluateToolCall(
      engine,
      ctx({ domain: 'evil.example.net', action: 'delete', tool: 'shell' }),
    );
    expect(r.outcome).toBe('deny');
    expect(r.outcome).not.toBe('require_approval');
  });

  it('terminates an over-budget run instead of queuing it for a human', async () => {
    const r = await evaluateToolCall(
      engine,
      ctx({ tokensUsed: 2_000, budgetTokens: 1_000, action: 'delete' }),
    );
    expect(r.outcome).toBe('terminate_run');
    expect(r.rule).toBe('budget');
  });

  it('checks budget BEFORE approval', async () => {
    // Ordering is the contract: a call that must be refused anyway must never
    // consume reviewer attention.
    const r = await evaluateToolCall(
      engine,
      ctx({ tool: 'shell', action: 'drop_db', costIncurredUsd: 500, maxCostUsd: 10 }),
    );
    expect(r.outcome).toBe('terminate_run');
  });

  it('checks egress BEFORE approval', async () => {
    const r = await evaluateToolCall(
      engine,
      ctx({ domain: 'blocked.example.net', tool: 'shell', action: 'delete' }),
    );
    expect(r.rule).toBe('egress');
  });

  it('counts the pending call toward the cost cap', async () => {
    // Excluding it would let the cap be walked past one call at a time.
    const r = await evaluateToolCall(
      engine,
      ctx({ costIncurredUsd: 9.5, callCostUsd: 1.0, maxCostUsd: 10 }),
    );
    expect(r.outcome).toBe('terminate_run');
  });

  it('does not evaluate egress for a call with no destination', async () => {
    const r = await evaluateToolCall(engine, ctx({ tool: 'read_file', action: 'read' }));
    expect(r.outcome).toBe('allow');
    expect(r.decisions.some((d) => d.entrypoint.includes('egress'))).toBe(false);
  });

  it('escalates a locally-known destructive action even if Rego does not list it', async () => {
    // Defence in depth: the local set may only ever add restriction.
    const r = await evaluateToolCall(engine, ctx({ tool: 'ses', action: 'transfer_funds' }));
    expect(r.outcome).toBe('require_approval');
  });

  it('never lets the local list turn a Rego deny into an allow', async () => {
    const r = await evaluateToolCall(engine, ctx({ tool: 'shell', action: 'read' }));
    // "shell" is restricted in Rego; "read" is not in the local set.
    expect(r.outcome).toBe('require_approval');
  });
});

describe('the gate with no policy engine', () => {
  const broken = () => new PolicyEngine({ bundlePath: '/nonexistent/policy.wasm' });

  it('requires approval for everything in strict mode', async () => {
    const r = await evaluateToolCall(broken(), ctx({ action: 'read', tool: 'http_get' }));
    expect(r.outcome).toBe('require_approval');
    expect(r.reason).toMatch(/could not be evaluated/);
  });

  it('denies egress rather than allowing it', async () => {
    const r = await evaluateToolCall(broken(), ctx({ domain: 'example.com' }));
    expect(r.outcome).toBe('deny');
  });

  it('stops a budgeted run it cannot verify', async () => {
    const r = await evaluateToolCall(broken(), ctx({ budgetTokens: 1_000, tokensUsed: 1 }));
    expect(r.outcome).toBe('terminate_run');
  });

  it('non-strict mode is permissive, and the evidence still records it', async () => {
    const r = await evaluateToolCall(broken(), ctx({ action: 'read' }), { strict: false });
    expect(r.outcome).toBe('allow');
    // The audit payload must still show that nothing was actually evaluated.
    const payload = auditPayload(ctx({ action: 'read' }), r);
    const evals = payload.evaluations as Array<{ evaluated: boolean }>;
    expect(evals.every((e) => e.evaluated === false)).toBe(true);
  });
});

describe('audit payload', () => {
  it('records every decision consulted and the bundle that produced it', async () => {
    const engine = new PolicyEngine({ bundlePath: BUNDLE, data: POLICY_DATA });
    const c = ctx({ domain: 'example.com', budgetTokens: 10_000, tokensUsed: 5 });
    const r = await evaluateToolCall(engine, c);
    const payload = auditPayload(c, r);

    expect(payload.outcome).toBe('allow');
    expect(payload.policyBundle).toMatch(/^sha256:/);
    // budget + egress + approval were all consulted.
    expect((payload.evaluations as unknown[]).length).toBe(3);
  });

  it('carries no tool arguments, which may hold secrets', async () => {
    const engine = new PolicyEngine({ bundlePath: BUNDLE, data: POLICY_DATA });
    const c = ctx({ arguments: { api_key: 'sk-live-should-never-be-logged' } });
    const payload = auditPayload(c, await evaluateToolCall(engine, c));
    expect(JSON.stringify(payload)).not.toContain('sk-live-should-never-be-logged');
  });
});
