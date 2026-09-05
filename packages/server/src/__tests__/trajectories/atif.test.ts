import { describe, it, expect } from 'vitest';
import {
  ATIF_VERSION,
  AtifError,
  appendStep,
  nextStepId,
  parseTrajectory,
  referencedBlobs,
  totals,
  trajectoryStepSchema,
  type TrajectoryStep,
} from '../../trajectories/atif.js';

const T0 = '2026-09-05T10:00:00.000Z';
const T1 = '2026-09-05T10:00:01.000Z';

function step(over: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return trajectoryStepSchema.parse({
    step_id: 1,
    started_at: T0,
    ended_at: T1,
    output_text: 'ok',
    ...over,
  });
}

function doc(over: Record<string, unknown> = {}) {
  return {
    atif_version: ATIF_VERSION,
    trial_id: 'trial-1',
    run_id: 'run-1',
    task_id: 'task-1',
    agent: {
      model_identifier: 'openai/gpt-4o',
      provider: 'openai',
      system_prompt_sha256: 'a'.repeat(64),
      temperature: 0.2,
    },
    started_at: T0,
    steps: [],
    ...over,
  };
}

describe('the 1-indexed gapless step invariant', () => {
  it('accepts a correctly numbered sequence', () => {
    const parsed = parseTrajectory(
      doc({ steps: [step({ step_id: 1 }), step({ step_id: 2 }), step({ step_id: 3 })] }),
    );
    expect(parsed.steps.map((s) => s.step_id)).toEqual([1, 2, 3]);
  });

  it('rejects a 0-indexed document rather than renumbering it', () => {
    // Renumbering would erase the difference between "starts at 0" and
    // "step 1 is missing", which are different facts about an audit.
    //
    // Built raw rather than through step(), which parses eagerly: the point is
    // what the DOCUMENT parser does with a 0, not what the step schema does.
    const raw = doc({ steps: [{ step_id: 0, started_at: T0, tool_calls: [] }] });
    expect(() => parseTrajectory(raw)).toThrow(AtifError);
  });

  it('rejects a gap', () => {
    expect(() =>
      parseTrajectory(doc({ steps: [step({ step_id: 1 }), step({ step_id: 3 })] })),
    ).toThrow(/step_id must be 2/);
  });

  it('rejects a duplicate', () => {
    expect(() =>
      parseTrajectory(doc({ steps: [step({ step_id: 1 }), step({ step_id: 1 })] })),
    ).toThrow(/step_id must be 2/);
  });

  it('rejects out-of-order steps even when the set is complete', () => {
    expect(() =>
      parseTrajectory(doc({ steps: [step({ step_id: 2 }), step({ step_id: 1 })] })),
    ).toThrow(AtifError);
  });

  it('explains why, so the error is actionable', () => {
    try {
      parseTrajectory(doc({ steps: [step({ step_id: 1 }), step({ step_id: 5 })] }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as AtifError).message).toMatch(/1-indexed and gapless/);
      expect((e as AtifError).issues.length).toBeGreaterThan(0);
    }
  });
});

describe('appending steps', () => {
  it('computes the next id from the length', () => {
    expect(nextStepId([])).toBe(1);
    expect(nextStepId([step({ step_id: 1 })])).toBe(2);
  });

  it('appends in sequence', () => {
    let steps: TrajectoryStep[] = [];
    steps = appendStep(steps, step({ step_id: 1 }));
    steps = appendStep(steps, step({ step_id: 2 }));
    expect(steps.map((s) => s.step_id)).toEqual([1, 2]);
  });

  it('refuses an out-of-sequence append instead of correcting it', () => {
    // A client that thinks it is on step 7 when the server has 4 has lost
    // steps; silently renumbering would hide that.
    expect(() => appendStep([step({ step_id: 1 })], step({ step_id: 7 }))).toThrow(
      /expected step_id 2, received 7/,
    );
  });

  it('does not mutate the input array', () => {
    const original = [step({ step_id: 1 })];
    appendStep(original, step({ step_id: 2 }));
    expect(original).toHaveLength(1);
  });
});

describe('chain-of-thought capture', () => {
  it('records a reasoning trace', () => {
    const s = step({
      reasoning: { content: 'First I will list the directory, then read the file.', redacted: false },
    });
    expect(s.reasoning?.content).toContain('list the directory');
  });

  it('allows redaction only with a stated reason', () => {
    // "The model emitted no reasoning" and "the operator withheld it" are
    // different facts; the schema must not let the second hide in the first.
    expect(() => step({ reasoning: { redacted: true } as never })).toThrow();
    const ok = step({
      reasoning: { redacted: true, redaction_reason: 'customer PII in trace', content_sha256: 'b'.repeat(64) },
    });
    expect(ok.reasoning?.redacted).toBe(true);
  });

  it('rejects a reasoning block that is neither present nor redacted', () => {
    expect(() => step({ reasoning: { redacted: false } as never })).toThrow();
  });

  it('keeps a hash of a redacted trace so redaction is provable', () => {
    const s = step({
      reasoning: { redacted: true, redaction_reason: 'trade secret', content_sha256: 'c'.repeat(64) },
    });
    expect(s.reasoning?.content_sha256).toHaveLength(64);
    expect(s.reasoning?.content).toBeUndefined();
  });
});

describe('tool calls', () => {
  it('records arguments, output and exit code', () => {
    const s = step({
      tool_calls: [
        {
          tool_call_id: 'tc-1',
          name: 'bash',
          arguments: { command: 'ls -la' },
          stdout: 'total 0',
          stderr: '',
          exit_code: 0,
          output_truncated: false,
        },
      ],
    });
    expect(s.tool_calls[0]?.exit_code).toBe(0);
  });

  it('distinguishes "no exit code" from "exited 0"', () => {
    // A killed or timed-out tool has no exit code. Defaulting to 0 would
    // record a successful execution that never happened.
    const killed = step({
      tool_calls: [
        { tool_call_id: 'tc-1', name: 'bash', arguments: {}, exit_code: null, output_truncated: false },
      ],
    });
    expect(killed.tool_calls[0]?.exit_code).toBeNull();

    const omitted = step({
      tool_calls: [{ tool_call_id: 'tc-2', name: 'bash', arguments: {}, output_truncated: false }],
    });
    expect(omitted.tool_calls[0]?.exit_code).toBeUndefined();
  });

  it('keeps a blocked call in the trajectory rather than dropping it', () => {
    // A blocked tool call is exactly what an auditor is looking for.
    const s = step({
      tool_calls: [
        {
          tool_call_id: 'tc-1',
          name: 'shell',
          arguments: { command: 'rm -rf /' },
          blocked_by_policy: 'agenteval/approval/require_approval',
          output_truncated: false,
        },
      ],
    });
    expect(s.tool_calls[0]?.blocked_by_policy).toBeTruthy();
  });

  it('defaults tool_calls to an empty array, never undefined', () => {
    expect(step().tool_calls).toEqual([]);
  });
});

describe('observations and screenshots', () => {
  it('accepts a content-addressed screenshot reference', () => {
    const s = step({
      observation: {
        screenshot: `sha256:${'d'.repeat(64)}`,
        screenshot_format: 'webp',
        screenshot_width: 1280,
        screenshot_height: 800,
        terminated: false,
        truncated: false,
      },
    });
    expect(s.observation?.screenshot).toMatch(/^sha256:/);
  });

  it('rejects an embedded base64 image', () => {
    // Embedding would inflate the JSON that has to be canonicalized and signed.
    expect(() =>
      step({
        observation: { screenshot: 'data:image/png;base64,iVBORw0KGgo=', terminated: false, truncated: false } as never,
      }),
    ).toThrow();
  });

  it('rejects a format with no screenshot', () => {
    expect(() =>
      step({ observation: { screenshot_format: 'webp', terminated: false, truncated: false } as never }),
    ).toThrow();
  });
});

describe('metrics are observed, never estimated', () => {
  it('permits a step with no metrics at all', () => {
    expect(step().metrics).toBeUndefined();
  });

  it('rejects a total smaller than its parts', () => {
    expect(() =>
      step({ metrics: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 50 } as never }),
    ).toThrow(/parts cannot exceed the whole/);
  });

  it('accepts a provider total larger than the parts', () => {
    // Some providers bill reasoning tokens outside prompt+completion.
    const s = step({ metrics: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 500 } });
    expect(s.metrics?.total_tokens).toBe(500);
  });
});

describe('totals', () => {
  it('sums observed usage', () => {
    const t = totals({
      steps: [
        step({ step_id: 1, metrics: { prompt_tokens: 100, completion_tokens: 50, cost_usd: 0.01, latency_ms: 120 } }),
        step({ step_id: 2, metrics: { prompt_tokens: 200, completion_tokens: 60, cost_usd: 0.02, latency_ms: 80 } }),
      ],
    });
    expect(t.prompt_tokens).toBe(300);
    expect(t.completion_tokens).toBe(110);
    expect(t.cost_usd).toBeCloseTo(0.03, 6);
    expect(t.latency_ms).toBe(200);
  });

  it('distinguishes an unreported zero from a real one', () => {
    // A cost chart that draws a flat line for both is lying about one of them.
    const none = totals({ steps: [step({ step_id: 1 })] });
    expect(none.cost_usd).toBe(0);
    expect(none.steps_reporting_cost).toBe(0);

    const free = totals({ steps: [step({ step_id: 1, metrics: { cost_usd: 0 } })] });
    expect(free.cost_usd).toBe(0);
    expect(free.steps_reporting_cost).toBe(1);
  });

  it("prefers the provider's own total over the sum of parts", () => {
    const t = totals({
      steps: [step({ step_id: 1, metrics: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 999 } })],
    });
    expect(t.total_tokens).toBe(999);
  });

  it('falls back to the parts when no total is reported', () => {
    const t = totals({ steps: [step({ step_id: 1, metrics: { prompt_tokens: 10, completion_tokens: 5 } })] });
    expect(t.total_tokens).toBe(15);
  });

  it('counts tool calls and blocked tool calls', () => {
    const t = totals({
      steps: [
        step({
          step_id: 1,
          tool_calls: [
            { tool_call_id: 'a', name: 'ls', arguments: {}, output_truncated: false },
            { tool_call_id: 'b', name: 'rm', arguments: {}, blocked_by_policy: 'approval', output_truncated: false },
          ],
        }),
      ],
    });
    expect(t.tool_calls).toBe(2);
    expect(t.blocked_tool_calls).toBe(1);
  });

  it('does not drift when summing many small costs', () => {
    const steps = Array.from({ length: 100 }, (_, i) =>
      step({ step_id: i + 1, metrics: { cost_usd: 0.0001 } }),
    );
    expect(totals({ steps }).cost_usd).toBe(0.01);
  });
});

describe('blob references', () => {
  it('lists each distinct screenshot once', () => {
    const a = `sha256:${'1'.repeat(64)}`;
    const b = `sha256:${'2'.repeat(64)}`;
    const refs = referencedBlobs({
      steps: [
        step({ step_id: 1, observation: { screenshot: a, terminated: false, truncated: false } }),
        step({ step_id: 2, observation: { screenshot: b, terminated: false, truncated: false } }),
        step({ step_id: 3, observation: { screenshot: a, terminated: false, truncated: false } }),
      ],
    });
    expect(refs.sort()).toEqual([a, b].sort());
  });
});

describe('document-level rules', () => {
  it('pins the version', () => {
    expect(() => parseTrajectory(doc({ atif_version: '1.6' }))).toThrow(AtifError);
  });

  it('rejects unknown top-level fields', () => {
    // Strict objects: an unrecognized field is usually a version mismatch, and
    // silently ignoring it loses data the producer believed it recorded.
    expect(() => parseTrajectory(doc({ unexpected_field: true }))).toThrow(AtifError);
  });

  it('requires the agent to be identifiable', () => {
    expect(() =>
      parseTrajectory(doc({ agent: { model_identifier: 'x/y', provider: 'x' } })),
    ).toThrow(/system_prompt/);
  });

  it('rejects a step that ended before it started', () => {
    expect(() => step({ started_at: T1, ended_at: T0 })).toThrow(/precedes/);
  });

  it('round-trips through JSON without loss', () => {
    const original = parseTrajectory(
      doc({
        steps: [
          step({
            step_id: 1,
            reasoning: { content: 'think', redacted: false },
            metrics: { prompt_tokens: 5, cost_usd: 0.001 },
          }),
        ],
        outcome: 'success',
        score: 1,
      }),
    );
    expect(parseTrajectory(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });
});
