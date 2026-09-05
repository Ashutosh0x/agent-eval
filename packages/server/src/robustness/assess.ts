/**
 * The orchestrator: run the three probes against a grader and report what they
 * establish.
 *
 * ---------------------------------------------------------------------------
 * (b) IS A MULTIPLIER THE RIGHT TREATMENT? No, and this file does not use one.
 * ---------------------------------------------------------------------------
 *
 * The composite was specified as
 *
 *     score = passAtK * (1 - contamination) * (1 - gaming) * verifierConfidence
 *
 * The first two multipliers are defensible and stay. Contamination is a
 * measured upward bias: some fraction of the score is attributable to the model
 * having seen the task, and removing it is subtraction of a quantity that was
 * estimated. Gaming rate is measured OCCURRENCE: those runs were caught
 * cheating, their reward is void, and scaling by (1 - rate) discards them.
 *
 * Verifier weakness is categorically different. It measures OPPORTUNITY, not
 * occurrence. A grader that would pay full marks for an empty submission tells
 * you nothing about whether the agent under evaluation submitted one. So
 * multiplying the point estimate by a verifier-confidence scalar asserts that
 * the exploit was taken -- which is precisely the thing `gamingRate` already
 * measures. Applying both multiplies the same phenomenon twice, and the second
 * application is unmeasured.
 *
 * Consider two agents scoring 0.80 against a grader with an exploitable gap of
 * 0.5. One solved every task honestly; the other found the hole. Their true
 * capabilities are 0.80 and something near 0. A multiplier maps both to 0.40,
 * which is wrong for both of them and right for neither. What the measurement
 * actually supports is:
 *
 *     true capability lies somewhere in [0.80 - gap, 0.80]
 *
 * That is ASYMMETRIC, ONE-SIDED uncertainty, bounded below by the measured
 * gap -- an interval statement, not a point shift. A weak verifier does not
 * make a score lower. It makes it less knowable, and only in one direction,
 * because exploitation can inflate a score and cannot deflate it.
 *
 * Surface sensitivity is different again and belongs in the other side of the
 * interval too: a reward that moves under a rewrite which cannot change
 * correctness is noise, and noise widens an interval SYMMETRICALLY.
 *
 * So the recommended treatment, implemented in `composite.ts`:
 *
 *     lower  -= exploitableGap        (one-sided, from canaries and fuzzing)
 *     both   -/+ surfaceNoise         (symmetric, from perturbation testing)
 *     point estimate: UNCHANGED
 *
 * ---------------------------------------------------------------------------
 * (a) WHAT MAPS THE THREE RESULTS ONTO [0,1]?
 * ---------------------------------------------------------------------------
 *
 * The best answer is that for the treatment above, NOTHING HAS TO. Both
 * quantities the interval needs are already in reward units:
 *
 *     exploitableGap  the highest reward any provably non-solving submission
 *                     was paid. A reward, on the score's own scale.
 *     surfaceNoise    the mean absolute change in reward under a
 *                     semantics-preserving rewrite. Also a reward.
 *
 * The demand for a single [0,1] `verifierConfidence` is what forces an
 * arbitrary mapping into existence. Using the right statistical treatment
 * removes the need for one -- which is a strong hint that the multiplier was
 * the wrong shape to begin with.
 *
 * `verifierConfidence` is still produced, because callers ask for it and a
 * summary number has real communicative value. It is defined as
 *
 *     verifierConfidence = 1 - exploitableGap
 *
 * and it is labelled, in the output, as an ASSUMED mapping with no empirical
 * basis -- the same discipline the evidence bundle applies to a regulatory
 * mapping that does not `satisfy`. It is named (`gap-complement-v1`) and
 * tunable so that a future calibration against real graders can replace it
 * without silently changing the meaning of anyone's stored assessment.
 */

import {
  type Canary,
  type Finding,
  type Grader,
  type Perturbation,
  type RobustnessReport,
  type SolutionOracle,
  type TaskAssessment,
} from './types.js';
import { mean, proportion, quantile, stdDev } from './statistics.js';
import { fuzzGrader, type FuzzSeed, type Mutator } from './fuzzer.js';

/** How `verifierConfidence` is derived. Versioned so a change is visible. */
export interface ConfidenceMapping {
  name: string;
  formula: string;
  /**
   * Where the mapping comes from. `assumed` means exactly that: it is a
   * defensible shape, not a calibrated one, and no dataset supports the
   * particular curve.
   */
  basis: 'assumed' | 'calibrated';
  caveat: string;
}

/**
 * The verifier-side inputs to a composite score. Both are in reward units.
 *
 * This is what `compositeScore` consumes. `verifierConfidence` deliberately is
 * not part of it -- see the header.
 */
export interface VerifierAdjustment {
  /**
   * The highest reward paid to a submission that does not solve the task.
   * Bounds how much of an observed score could be unearned.
   */
  exploitableGap: number;
  /** Mean absolute reward change under a semantics-preserving rewrite. */
  surfaceNoise: number;
  /** What established the gap, carried so a reader can weigh it. */
  basis: string;
}

export interface VerifierAssessment {
  report: RobustnessReport;

  /** Measured, in score units. The one-sided bound on unearned reward. */
  exploitableGap: number;
  exploitableGapBasis: 'measured-with-oracle' | 'canary-construction' | 'not-established';

  /** Measured, in score units. Symmetric noise from surface sensitivity. */
  surfaceNoise: number;

  /** The [0,1] summary. An assumption, and labelled as one. */
  verifierConfidence: number;
  confidenceMapping: ConfidenceMapping;

  /** Ready to hand to `compositeScore`. */
  adjustment: VerifierAdjustment;
}

export interface AssessOptions<TTask, TSubmission> {
  suiteId: string;
  tasks: readonly TTask[];
  taskId(task: TTask): string;
  grader: Grader<TTask, TSubmission>;

  canaries?: ReadonlyArray<Canary<TTask, TSubmission>>;
  perturbations?: ReadonlyArray<Perturbation<TTask, TSubmission>>;

  /**
   * A submission believed to solve the task. Required for perturbation
   * testing: the invariant being checked is that a CORRECT submission grades
   * identically after a semantics-preserving rewrite, and without one there is
   * nothing to hold fixed.
   */
  referenceSubmission?(task: TTask): TSubmission | null;

  /** Establishes how much a submission actually solved. */
  oracle?: SolutionOracle<TTask, TSubmission>;

  /** Grades per probe. Above 1 gives a standard deviation per finding. */
  repeats?: number;
  /** Grades of one identical pair used to detect a nondeterministic grader. */
  determinismSamples?: number;
  /** Reward above which a canary counts as having been paid. */
  rewardThreshold?: number;
  /** Total grader calls allowed. The assessment stops cleanly at the cap. */
  maxGraderCalls?: number;

  /** Fuzzing config, or false to skip it. */
  fuzz?:
    | false
    | {
        mutators: ReadonlyArray<Mutator<TSubmission>>;
        maxGraderCallsPerTask?: number;
        maxStepsPerSeed?: number;
      };
}

/** Thrown when a report would claim more than it established. */
export class OverclaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverclaimError';
  }
}

/**
 * Every finding that is not `closed` must carry a caveat.
 *
 * The same rule the evidence bundle enforces on regulatory mappings, for the
 * same reason: the failure mode of a robustness report is not being wrong, it
 * is being quoted. A finding that says `suspected` with no explanation will be
 * read as `open` by whoever needs it to be.
 */
export function assertNoOverclaim(report: RobustnessReport): void {
  for (const task of report.perTask) {
    const all = [
      ...task.canaryFindings,
      ...task.perturbationFindings,
      ...(task.fuzzFinding ? [task.fuzzFinding] : []),
    ];
    for (const finding of all) {
      if (finding.status !== 'closed' && !finding.caveat) {
        throw new OverclaimError(
          `${task.taskId}/${finding.channel} is "${finding.status}" with no caveat`,
        );
      }
    }
  }
}

export async function assessVerifier<TTask, TSubmission>(
  options: AssessOptions<TTask, TSubmission>,
): Promise<VerifierAssessment> {
  const {
    suiteId,
    tasks,
    taskId,
    grader,
    canaries = [],
    perturbations = [],
    referenceSubmission,
    oracle,
    repeats = 1,
    determinismSamples = 3,
    rewardThreshold = 0,
    maxGraderCalls = Number.POSITIVE_INFINITY,
    fuzz = false,
  } = options;

  let graderCalls = 0;
  let budgetExhausted = false;

  const gradeOnce = async (task: TTask, submission: TSubmission): Promise<number | null> => {
    if (graderCalls >= maxGraderCalls) {
      budgetExhausted = true;
      return null;
    }
    graderCalls++;
    const outcome = await grader(task, submission);
    return clamp01(outcome.reward);
  };

  /** Grade `repeats` times, returning mean and spread. */
  const gradeRepeated = async (
    task: TTask,
    submission: TSubmission,
  ): Promise<{ mean: number; stdDev: number; repeats: number } | null> => {
    const rewards: number[] = [];
    for (let i = 0; i < Math.max(1, repeats); i++) {
      const reward = await gradeOnce(task, submission);
      if (reward === null) break;
      rewards.push(reward);
    }
    if (rewards.length === 0) return null;
    return { mean: mean(rewards), stdDev: stdDev(rewards), repeats: rewards.length };
  };

  // ---------------------------------------------------------- determinism
  //
  // Done first and on one pair, because the answer changes how every later
  // number should be read. A grader that returns different rewards for
  // identical input makes single-shot findings unreliable regardless of what
  // they say.
  let nondeterministic = false;
  if (tasks.length > 0 && determinismSamples > 1) {
    const probeTask = tasks[0]!;
    const probeSubmission =
      referenceSubmission?.(probeTask) ?? canaries[0]?.build(probeTask) ?? null;
    if (probeSubmission !== null) {
      const observed: number[] = [];
      for (let i = 0; i < determinismSamples; i++) {
        const reward = await gradeOnce(probeTask, probeSubmission);
        if (reward === null) break;
        observed.push(reward);
      }
      nondeterministic = observed.length > 1 && stdDev(observed) > 0;
    }
  }

  // ------------------------------------------------------------- per task
  const perTask: TaskAssessment[] = [];
  const surfaceDeltas: number[] = [];
  let anyOracleConfirmedGap = false;
  let anyCanaryGap = false;

  for (const task of tasks) {
    const id = taskId(task);
    const canaryFindings: Finding[] = [];
    const perturbationFindings: Finding[] = [];
    let fuzzFinding: Finding | null = null;

    // --- canaries. solve = 0 by construction, so reward IS the gap.
    for (const canary of canaries) {
      const submission = canary.build(task);
      if (submission === null) {
        canaryFindings.push({
          channel: canary.id,
          status: 'not-tested',
          reward: 0,
          solve: null,
          gap: null,
          rewardStdDev: 0,
          repeats: 0,
          caveat:
            'This canary does not apply to this task, so the channel was not ' +
            'exercised. Not evidence that it is shut.',
        });
        continue;
      }

      const graded = await gradeRepeated(task, submission);
      if (!graded) {
        canaryFindings.push({
          channel: canary.id,
          status: 'not-tested',
          reward: 0,
          solve: null,
          gap: null,
          rewardStdDev: 0,
          repeats: 0,
          caveat: 'Grader-call budget was exhausted before this canary ran.',
        });
        continue;
      }

      const paid = graded.mean > rewardThreshold;
      if (paid) anyCanaryGap = true;
      canaryFindings.push({
        channel: canary.id,
        status: paid ? 'open' : 'closed',
        reward: graded.mean,
        solve: 0,
        gap: graded.mean,
        rewardStdDev: graded.stdDev,
        repeats: graded.repeats,
        caveat: paid
          ? `Reward ${graded.mean.toFixed(3)} was paid for a submission that does not ` +
            `solve the task. ${canary.rationale}`
          : undefined,
      });
    }

    // --- perturbations. Needs a reference submission to hold fixed.
    const reference = referenceSubmission?.(task) ?? null;
    if (reference === null) {
      for (const perturbation of perturbations) {
        perturbationFindings.push({
          channel: perturbation.name,
          status: 'not-tested',
          reward: 0,
          solve: null,
          gap: null,
          rewardStdDev: 0,
          repeats: 0,
          caveat:
            'No reference submission for this task, so there was nothing to hold ' +
            'invariant. Surface sensitivity is unknown, not absent.',
        });
      }
    } else {
      const baseline = await gradeRepeated(task, reference);
      for (const perturbation of perturbations) {
        const rewritten = perturbation.apply(task, reference);
        if (!baseline || rewritten === null) {
          perturbationFindings.push({
            channel: perturbation.name,
            status: 'not-tested',
            reward: baseline?.mean ?? 0,
            solve: null,
            gap: null,
            rewardStdDev: 0,
            repeats: 0,
            caveat: !baseline
              ? 'Grader-call budget was exhausted before the baseline was graded.'
              : 'This rewrite does not apply to this task and submission.',
          });
          continue;
        }

        const after = await gradeRepeated(rewritten.task, rewritten.submission);
        if (!after) {
          perturbationFindings.push({
            channel: perturbation.name,
            status: 'not-tested',
            reward: baseline.mean,
            solve: null,
            gap: null,
            rewardStdDev: 0,
            repeats: 0,
            caveat: 'Grader-call budget was exhausted before the rewrite was graded.',
          });
          continue;
        }

        const delta = Math.abs(after.mean - baseline.mean);
        surfaceDeltas.push(delta);
        const moved = delta > 0;
        perturbationFindings.push({
          channel: perturbation.name,
          status: moved ? 'open' : 'closed',
          reward: after.mean,
          solve: null,
          gap: null,
          rewardStdDev: after.stdDev,
          repeats: after.repeats,
          detail: `baseline ${baseline.mean.toFixed(3)} -> ${after.mean.toFixed(3)}`,
          caveat: moved
            ? `Reward moved by ${delta.toFixed(3)} under a rewrite that cannot change ` +
              `whether the task was solved. ${perturbation.rationale}` +
              (perturbation.assumption
                ? ` Assumes: ${perturbation.assumption}`
                : '')
            : undefined,
        });
      }
    }

    // --- fuzzing, seeded from the canaries that are known non-solving.
    if (fuzz !== false && graderCalls < maxGraderCalls) {
      const seeds: Array<FuzzSeed<TSubmission>> = [];
      for (const canary of canaries) {
        const submission = canary.build(task);
        if (submission !== null) {
          seeds.push({ origin: canary.id, submission, provablyUnsolving: true });
        }
      }

      if (seeds.length > 0) {
        const perTaskBudget = Math.min(
          fuzz.maxGraderCallsPerTask ?? 40,
          maxGraderCalls - graderCalls,
        );
        const result = await fuzzGrader(task, {
          grader: async (t, s) => {
            graderCalls++;
            return grader(t, s);
          },
          seeds,
          mutators: fuzz.mutators,
          maxGraderCalls: perTaskBudget,
          maxStepsPerSeed: fuzz.maxStepsPerSeed,
          oracle,
        });

        if (result.best && result.best.gap > rewardThreshold) {
          const confirmed = !result.best.gapIsAssumed && result.best.solve !== null;
          if (confirmed) anyOracleConfirmedGap = true;
          fuzzFinding = {
            channel: 'fuzz',
            status: confirmed ? 'open' : 'suspected',
            reward: result.best.reward,
            solve: result.best.solve,
            gap: result.best.gap,
            rewardStdDev: 0,
            repeats: 1,
            detail: `via ${result.best.lineage.join(' -> ')}`,
            caveat: confirmed
              ? `Reward ${result.best.reward.toFixed(3)} against an independently ` +
                `measured solve of ${(result.best.solve ?? 0).toFixed(3)}.`
              : 'Reward was paid to a mutation of a non-solving seed, but no oracle ' +
                'confirmed the mutation did not accidentally solve the task. ' +
                'Reported as suspected rather than open.',
          };
        }
      }
    }

    const gaps = [
      ...canaryFindings.map((f) => f.gap),
      fuzzFinding?.gap ?? null,
    ].filter((g): g is number => g !== null && g > 0);

    perTask.push({
      taskId: id,
      canaryFindings,
      perturbationFindings,
      fuzzFinding,
      worstGap: gaps.length > 0 ? Math.max(...gaps) : null,
      openChannels: [
        ...canaryFindings.filter((f) => f.status === 'open').map((f) => f.channel),
        ...(fuzzFinding?.status === 'open' ? ['fuzz'] : []),
      ],
    });
  }

  // --------------------------------------------------------------- rollup
  const tasksWithOpenChannel = perTask.filter((t) => t.openChannels.length > 0).length;
  const tasksWithSurfaceMovement = perTask.filter((t) =>
    t.perturbationFindings.some((f) => f.status === 'open'),
  ).length;
  const perturbationTestedTasks = perTask.filter((t) =>
    t.perturbationFindings.some((f) => f.status !== 'not-tested'),
  ).length;

  const measuredGaps = perTask
    .map((t) => t.worstGap)
    .filter((g): g is number => g !== null);

  const channelNames = new Set<string>();
  for (const task of perTask) {
    for (const f of [...task.canaryFindings, ...task.perturbationFindings]) {
      channelNames.add(f.channel);
    }
    if (task.fuzzFinding) channelNames.add('fuzz');
  }

  const channelSummary = [...channelNames]
    .map((channel) => {
      const all = perTask.flatMap((t) =>
        [...t.canaryFindings, ...t.perturbationFindings, ...(t.fuzzFinding ? [t.fuzzFinding] : [])].filter(
          (f) => f.channel === channel,
        ),
      );
      return {
        channel,
        open: all.filter((f) => f.status === 'open').length,
        suspected: all.filter((f) => f.status === 'suspected').length,
        closed: all.filter((f) => f.status === 'closed').length,
        notTested: all.filter((f) => f.status === 'not-tested').length,
      };
    })
    .sort((a, b) => b.open - a.open);

  const limitations = buildLimitations({
    taskCount: tasks.length,
    hasOracle: Boolean(oracle),
    hasReference: Boolean(referenceSubmission),
    perturbationTestedTasks,
    fuzzRan: fuzz !== false,
    budgetExhausted,
    nondeterministic,
    channelSummary,
  });

  const report: RobustnessReport = {
    suiteId,
    assessedAt: new Date().toISOString(),
    taskCount: tasks.length,
    graderCalls,
    gameability: proportion(tasksWithOpenChannel, tasks.length),
    surfaceSensitivity: proportion(tasksWithSurfaceMovement, perturbationTestedTasks),
    nondeterministic,
    gapDistribution: {
      median: quantile(measuredGaps, 0.5),
      p95: quantile(measuredGaps, 0.95),
      max: measuredGaps.length > 0 ? Math.max(...measuredGaps) : null,
      measured: measuredGaps.length,
    },
    perTask,
    channelSummary,
    limitations,
  };

  assertNoOverclaim(report);

  // The gap is the worst reward any non-solving submission was paid, over the
  // whole suite. Worst rather than mean: it is a bound on what an optimising
  // agent could have obtained, and such an agent would have found the worst
  // case rather than an average one.
  const exploitableGap = measuredGaps.length > 0 ? Math.max(...measuredGaps) : 0;
  const surfaceNoise = surfaceDeltas.length > 0 ? mean(surfaceDeltas) : 0;

  const exploitableGapBasis: VerifierAssessment['exploitableGapBasis'] =
    anyOracleConfirmedGap
      ? 'measured-with-oracle'
      : anyCanaryGap
        ? 'canary-construction'
        : 'not-established';

  const confidenceMapping: ConfidenceMapping = {
    name: 'gap-complement-v1',
    formula: 'verifierConfidence = 1 - exploitableGap',
    basis: 'assumed',
    caveat:
      'This mapping is a defensible shape, not a calibrated one. No dataset ' +
      'relates a measured exploitable gap to a verifier trustworthiness score, ' +
      'so the linear complement is a stated convention rather than a finding. ' +
      'It is versioned so a later calibration can replace it without changing ' +
      'the meaning of assessments already stored. Prefer the interval treatment ' +
      'in `adjustment`, which needs no mapping because its quantities are ' +
      'already in reward units.',
  };

  return {
    report,
    exploitableGap,
    exploitableGapBasis,
    surfaceNoise,
    verifierConfidence: clamp01(1 - exploitableGap),
    confidenceMapping,
    adjustment: {
      exploitableGap,
      surfaceNoise,
      basis:
        exploitableGapBasis === 'measured-with-oracle'
          ? 'Largest gap between paid reward and independently measured solve.'
          : exploitableGapBasis === 'canary-construction'
            ? 'Largest reward paid to a submission that is non-solving by construction.'
            : 'No gap was established; no non-solving submission was paid.',
    },
  };
}

function buildLimitations(input: {
  taskCount: number;
  hasOracle: boolean;
  hasReference: boolean;
  perturbationTestedTasks: number;
  fuzzRan: boolean;
  budgetExhausted: boolean;
  nondeterministic: boolean;
  channelSummary: Array<{ channel: string; notTested: number }>;
}): string[] {
  const limitations: string[] = [];

  if (!input.hasOracle) {
    limitations.push(
      'No solution oracle was supplied. Canary gaps are established by ' +
        'construction and are sound, but fuzzing results are reported as ' +
        'suspected rather than open because a mutation could in principle have ' +
        'solved the task.',
    );
  }
  if (!input.hasReference || input.perturbationTestedTasks === 0) {
    limitations.push(
      'Perturbation testing did not run on any task, so surface sensitivity is ' +
        'unmeasured. A grader can refuse every canary and still be scoring the ' +
        'shape of an answer rather than its content.',
    );
  }
  if (!input.fuzzRan) {
    limitations.push(
      'Fuzzing was disabled. Only the named channels were tested; an unnamed ' +
        'one would not have been found.',
    );
  }
  if (input.budgetExhausted) {
    limitations.push(
      'The grader-call budget was exhausted before every probe ran. Untested ' +
        'probes are marked not-tested and must not be read as passes.',
    );
  }
  if (input.nondeterministic) {
    limitations.push(
      'The grader returned different rewards for identical input. Every figure ' +
        'here is a sample from a distribution, and single-repeat findings ' +
        'carry that uncertainty without quantifying it.',
    );
  }
  if (input.taskCount < 20) {
    limitations.push(
      `Only ${input.taskCount} tasks were assessed. The gameability rate carries ` +
        'a wide interval at this sample size; read the bounds, not the point.',
    );
  }
  const untested = input.channelSummary.filter((c) => c.notTested > 0).map((c) => c.channel);
  if (untested.length > 0) {
    limitations.push(
      `These channels went untested on at least one task: ${untested.join(', ')}. ` +
        'Usually because the task did not declare the field the probe needs, ' +
        'which is itself worth checking -- a benchmark that does leak its ' +
        'reference answer but did not populate it here will show a clean result ' +
        'that means nothing.',
    );
  }

  // Never empty. An assessment with no stated limitation has not been thought
  // about, and this is the line that says so.
  if (limitations.length === 0) {
    limitations.push(
      'Every configured probe ran against every task. This bounds the channels ' +
        'that were tested; it does not establish that no other channel exists.',
    );
  }
  return limitations;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
