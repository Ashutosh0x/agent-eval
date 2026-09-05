/**
 * Isomorphic perturbation testing.
 *
 * Rewrite the task and the submission together in a way that cannot change
 * whether the task was solved, then re-grade. A correct grader returns the same
 * reward. A grader that returns a different one is keying on surface form, and
 * whatever it is measuring is not capability.
 *
 * This is the probe that finds the failure the canaries cannot. A grader can
 * refuse every canary -- pay nothing for an empty string, catch the reference
 * echo, sandbox the state write -- and still be scoring the shape of an answer
 * rather than its content. GAIA's "normalization collisions" are exactly this:
 * answers that are equal as values and unequal as strings.
 *
 * Two directions of failure, and both matter:
 *
 *   reward DROPS   a correct submission is marked wrong because it was spelled
 *                  differently. The benchmark understates capability, and
 *                  models are ranked by formatting luck.
 *   reward RISES   the grader found something to like in noise. Rarer, and
 *                  worse, because it is a gradient an optimiser will climb.
 *
 * The `assumption` field on each perturbation is load-bearing. Alpha-renaming
 * is semantics-preserving unless the identifier is part of a required API;
 * case folding is unless the answer is case-sensitive. A finding whose
 * assumption does not hold for a given suite is a false positive, and the
 * report says so rather than making the suite author guess.
 */

import type { Perturbation } from './types.js';
import type { TextTask } from './canaries.js';

type P = Perturbation<TextTask, string>;

/** Parses as a JSON object, so key order can be permuted without changing value. */
function asJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A submission that is a bare number, in any notation. */
function asNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export const STANDARD_PERTURBATIONS: ReadonlyArray<P> = [
  {
    name: 'task-id-rename',
    rationale:
      'Only the task identifier changes; the task and the submission are byte ' +
      'identical. A grader whose reward moves is consulting an answer key keyed ' +
      'by id rather than evaluating the submission. This is the cheapest ' +
      'possible detector for a hardcoded key and it costs one grader call.',
    apply: (task, submission) => ({
      task: { ...task, id: `${task.id}-isomorph-9f2c` },
      submission,
    }),
  },

  {
    name: 'submission-trailing-whitespace',
    rationale:
      'A trailing newline and spaces. Every grader should normalise these. One ' +
      'that does not is doing raw string equality, which means its scores ' +
      'depend on whether a model happened to emit a final newline.',
    apply: (task, submission) => ({ task, submission: `${submission}  \n` }),
  },

  {
    name: 'submission-leading-whitespace',
    rationale:
      'Leading whitespace, which changes nothing about an answer and breaks ' +
      'exact-match graders in the other direction. Tested separately from ' +
      'trailing because graders commonly strip one end and not both.',
    apply: (task, submission) => ({ task, submission: ` \n${submission}` }),
  },

  {
    name: 'answer-case-fold',
    rationale:
      'Uppercases the submission. For a natural-language or symbolic answer ' +
      'this is the same answer; a reward change means case is being scored.',
    assumption:
      'The expected answer is case-insensitive. Does not hold for tasks whose ' +
      'answer is a case-sensitive identifier, a hash, or source code.',
    apply: (task, submission) => {
      const upper = submission.toUpperCase();
      return upper === submission ? null : { task, submission: upper };
    },
  },

  {
    name: 'numeric-reformat',
    rationale:
      'Rewrites a numeric answer in an equal but differently spelled form -- ' +
      '7 becomes 7.0. Numerically identical, textually different. This is the ' +
      'GAIA normalization-collision class, where answers equal as values are ' +
      'unequal as strings and the grader scores the string.',
    apply: (task, submission) => {
      const n = asNumber(submission);
      if (n === null) return null;
      const rewritten = Number.isInteger(n) ? `${n}.0` : `${n}0`;
      return rewritten === submission.trim() ? null : { task, submission: rewritten };
    },
  },

  {
    name: 'json-key-reorder',
    rationale:
      'Permutes the keys of a JSON submission. JSON objects are unordered by ' +
      'definition, so this is the same value. A grader that notices is ' +
      'comparing serialized text instead of parsed structure -- the same class ' +
      'of bug that makes canonical JSON necessary in the evidence layer.',
    apply: (task, submission) => {
      const obj = asJsonObject(submission);
      if (!obj) return null;
      const keys = Object.keys(obj);
      if (keys.length < 2) return null;
      const reversed: Record<string, unknown> = {};
      for (const k of [...keys].reverse()) reversed[k] = obj[k];
      return { task, submission: JSON.stringify(reversed) };
    },
  },

  {
    name: 'prompt-neutral-prefix',
    rationale:
      'Prepends a label to the task prompt without altering what is asked. ' +
      'Aimed at LLM judges, which see the prompt and can be swayed by its ' +
      'framing. A reward change here means the judge is scoring the question ' +
      'as much as the answer.',
    apply: (task, submission) => ({
      task: { ...task, prompt: `Task: ${task.prompt}` },
      submission,
    }),
  },

  {
    name: 'prompt-whitespace-normalise',
    rationale:
      'Collapses runs of whitespace in the prompt. Semantically identical for ' +
      'any prose task, and it detects a grader that hashes or exact-matches the ' +
      'prompt to look up an expected answer.',
    apply: (task, submission) => {
      const normalised = task.prompt.replace(/\s+/g, ' ').trim();
      return normalised === task.prompt ? null : { task: { ...task, prompt: normalised }, submission };
    },
  },

  {
    name: 'identifier-alpha-rename',
    rationale:
      'Consistently renames an identifier that appears in both the prompt and ' +
      'the submission. Alpha-renaming is the textbook semantics-preserving ' +
      'transformation; a grader that changes its answer is pattern-matching ' +
      'source text rather than executing or parsing it.',
    assumption:
      'The renamed identifier is internal, not a required public name. A task ' +
      'that specifies "define a function called solve" is legitimately ' +
      'sensitive to this rename and should exclude this perturbation.',
    apply: (task, submission) => {
      // Pick the longest identifier the prompt and submission share, so the
      // rename is meaningful rather than incidental -- a shared `i` proves
      // nothing.
      const ids = (text: string) => new Set(text.match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) ?? []);
      const shared = [...ids(task.prompt)].filter((id) => ids(submission).has(id));
      if (shared.length === 0) return null;
      const target = shared.sort((a, b) => b.length - a.length)[0]!;
      const renamed = `${target}_r`;
      const swap = (text: string) =>
        text.replace(new RegExp(`\\b${target}\\b`, 'g'), renamed);
      return {
        task: { ...task, prompt: swap(task.prompt) },
        submission: swap(submission),
      };
    },
  },

  {
    name: 'comment-insertion',
    rationale:
      'Appends a comment line to a code submission. Comments cannot change ' +
      'behaviour, so an executing grader is unaffected. A grader that is ' +
      'diffing against a reference solution is not.',
    assumption:
      'The submission is code in a language where # begins a comment, or the ' +
      'grader ignores unparseable trailing lines.',
    apply: (task, submission) =>
      submission.trim() === ''
        ? null
        : { task, submission: `${submission}\n# no behavioural change` },
  },
];

/**
 * Perturbations that did not apply to this pair.
 *
 * Surfaced for the same reason inapplicable canaries are: a suite that reports
 * clean surface-sensitivity because nine of eleven rewrites silently skipped
 * has not been tested, and the report must not let that read as a pass.
 */
export function inapplicablePerturbations(
  task: TextTask,
  submission: string,
  perturbations: ReadonlyArray<P> = STANDARD_PERTURBATIONS,
): string[] {
  return perturbations.filter((p) => p.apply(task, submission) === null).map((p) => p.name);
}
