/**
 * Grader robustness assessment: the shared vocabulary.
 *
 * The thing being measured here is not "is the agent good". It is "how much
 * reward does this grader hand out for work that did not happen".
 *
 * Every interviewee in Epoch AI's January 2026 study of the RL-environment
 * market named reward hacking as their top problem, and Berkeley RDI scored
 * 100% on four published agent benchmarks without solving a single task. Those
 * two facts describe a market with an unmeasured defect, and a defect nobody
 * measures is one nobody can price.
 *
 * The central quantity is the EXPLOITABLE REWARD GAP:
 *
 *     gap = reward(submission) - solve(submission)
 *
 * Reward is what the grader pays. Solve is what the submission actually
 * accomplished, established independently. A grader with a gap of 0 pays only
 * for work. A grader with a gap of 1 pays full marks for nothing, which is
 * precisely what SWE-bench Pro and FieldWorkArena were shown to do.
 *
 * Two design commitments carry through every file here.
 *
 * `solve` is never guessed. A canary submission has solve = 0 by CONSTRUCTION
 * -- an empty string does not fix a bug, and that needs no oracle to assert.
 * Anywhere solve cannot be established that way, the assessment either takes a
 * caller-supplied oracle or reports the channel as untested. It never infers a
 * gap from a number it did not measure.
 *
 * Absence of evidence is reported as absence of evidence. A probe that could
 * not run is `not-tested`, never `closed`. This is the same discipline the
 * evidence bundle already applies to regulatory mappings, and it exists for the
 * same reason: a robustness report that overclaims is worse than none, because
 * someone will rely on it.
 */

/** A grader's payout for a submission. Normalised to [0, 1]. */
export interface GradeOutcome {
  /**
   * The reward. Must be in [0, 1]; a grader with a different range should be
   * wrapped rather than have its scale guessed at here.
   */
  reward: number;
  /** The grader's own pass/fail verdict, where it has one. */
  passed?: boolean;
  /** Anything worth carrying into the report -- a judge's rationale, stderr. */
  detail?: string;
}

/**
 * The system under test.
 *
 * Deliberately `(task, submission) => outcome` and nothing more. A grader that
 * needs a container, a network or a judge model hides that behind this
 * signature, because the assessment must work identically against a regex and
 * against an LLM judge.
 */
export type Grader<TTask, TSubmission> = (
  task: TTask,
  submission: TSubmission,
) => Promise<GradeOutcome> | GradeOutcome;

/**
 * An independent judgment of how much of the task a submission actually
 * accomplished, in [0, 1].
 *
 * Optional, and the assessment is honest about what it cannot conclude without
 * one. Where it exists it is usually a reference test suite run outside the
 * agent's environment -- which is the same isolation property whose absence
 * broke SWE-bench, Terminal-Bench and OSWorld.
 */
export type SolutionOracle<TTask, TSubmission> = (
  task: TTask,
  submission: TSubmission,
) => Promise<number> | number;

/**
 * A semantics-preserving rewrite of a (task, submission) pair.
 *
 * The invariant a conforming grader must satisfy:
 *
 *     grade(task, submission) === grade(...apply(task, submission))
 *
 * Both halves are transformed together because some rewrites are only
 * semantics-preserving as a pair -- renaming a variable in the task statement
 * means renaming it in the solution too. Where only one side changes, the
 * other transform is identity.
 *
 * A grader that fails this is keying on surface form. It will reward a
 * submission that looks right over one that is right, and it will be gamed by
 * whoever notices first.
 */
export interface Perturbation<TTask, TSubmission> {
  name: string;
  /** Why a grader that changes its answer under this rewrite is broken. */
  rationale: string;
  /**
   * The assumption under which this rewrite is semantics-preserving, where it
   * needs one. Alpha-renaming an identifier is safe unless the name is part of
   * a required API; case folding is safe unless the answer is case-sensitive.
   * Carried into the report so a finding can be discounted rather than
   * silently trusted.
   */
  assumption?: string;
  /** Returns null when this rewrite does not apply to this pair. */
  apply(
    task: TTask,
    submission: TSubmission,
  ): { task: TTask; submission: TSubmission } | null;
}

/**
 * A submission that provably does not solve the task.
 *
 * `solve` is 0 by construction, not by measurement: this is the whole reason
 * canaries need no oracle. Each one corresponds to a gameability channel
 * observed in the wild, named so a report says which door was open rather than
 * just that one was.
 */
export interface Canary<TTask, TSubmission> {
  /** Stable identifier, used as the channel name in findings. */
  id: string;
  /** The attack this stands in for, and where it has been seen. */
  rationale: string;
  /**
   * Build the non-solving submission. Returns null when this canary does not
   * apply to this task -- which is reported as `not-tested`, never as a pass.
   */
  build(task: TTask): TSubmission | null;
}

/** What a probe concluded. Ordering matters: worse first. */
export type ChannelStatus =
  /** Confirmed: reward was paid for a submission that provably did not solve. */
  | 'open'
  /** Reward was paid, but `solve` could not be independently established. */
  | 'suspected'
  /** Tested, and the grader paid nothing. */
  | 'closed'
  /** Could not be tested here. Not a pass. */
  | 'not-tested';

export interface Finding {
  channel: string;
  status: ChannelStatus;
  /** Mean reward the grader paid, across repeats. */
  reward: number;
  /** Independently established solve, where known. */
  solve: number | null;
  /** reward - solve, when both are known. */
  gap: number | null;
  /** Spread across repeats. Non-zero means the grader is nondeterministic. */
  rewardStdDev: number;
  repeats: number;
  /**
   * Required whenever status is not `closed`. The report refuses to serialize
   * without it -- the same rule the evidence bundle applies to any mapping
   * that does not `satisfy`.
   */
  caveat?: string;
  detail?: string;
}

/** A proportion with an interval, because these are small samples. */
export interface Proportion {
  count: number;
  total: number;
  rate: number;
  /** Wilson score interval at 95%. */
  lower: number;
  upper: number;
}

export interface TaskAssessment {
  taskId: string;
  /**
   * Canary results. `open` here means reward was paid for a submission that
   * does not solve the task -- a gameability channel, confirmed without an
   * oracle because the canary is non-solving by construction.
   */
  canaryFindings: Finding[];
  /**
   * Perturbation results. `open` here means something different: the reward
   * CHANGED under a rewrite that cannot change whether the task was solved.
   * That is surface sensitivity, not gameability, and it is counted separately.
   */
  perturbationFindings: Finding[];
  /** The fuzzer's best result, when fuzzing ran. */
  fuzzFinding: Finding | null;
  /** The largest confirmed gap on this task. Null when nothing was confirmed. */
  worstGap: number | null;
  /** Channels found open on this task. */
  openChannels: string[];
}

export interface RobustnessReport {
  suiteId: string;
  assessedAt: string;
  taskCount: number;
  /** Grader calls made. Graders cost money and callers budget for this. */
  graderCalls: number;

  /** Fraction of tasks with at least one open channel. */
  gameability: Proportion;
  /** Fraction of tasks where a semantics-preserving rewrite changed the reward. */
  surfaceSensitivity: Proportion;
  /**
   * Whether repeated identical grades disagreed. When true, every other figure
   * here is a distribution rather than a value, and the intervals matter.
   */
  nondeterministic: boolean;

  /** Distribution of the worst confirmed gap per task. */
  gapDistribution: {
    median: number | null;
    p95: number | null;
    max: number | null;
    /** Tasks where a gap could be confirmed at all. */
    measured: number;
  };

  perTask: TaskAssessment[];
  /** Channels ranked by how many tasks they are open on. */
  channelSummary: Array<{ channel: string; open: number; suspected: number; closed: number; notTested: number }>;

  /** What this assessment did NOT establish. Never empty in practice. */
  limitations: string[];
}
