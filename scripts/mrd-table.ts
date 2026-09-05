/**
 * Minimum resolvable difference for published agent benchmarks.
 *
 * Run: pnpm mrd
 *
 * Task counts are published figures. Everything else -- attempts per task,
 * reported k, clustering -- is an ASSUMPTION, stated in the output, because
 * most benchmarks do not publish a sampling design at all. That is itself the
 * finding: a benchmark that does not state n and k cannot have its resolving
 * power computed by anyone, including its own authors.
 *
 * The numbers are not the deliverable. The calculator is. Anyone who disagrees
 * with an assumption here can change it on one line and rerun.
 */

import {
  resolutionTable,
  resolvingPower,
  designEffect,
  requiredTasks,
} from '../packages/server/src/scoring/mrd.js';

/** Published task counts. Sources in the comments; sampling design assumed. */
const BENCHMARKS = [
  { benchmark: 'AIME', tasks: 30 },
  { benchmark: 'Cybench', tasks: 40 }, // Stanford, 40 professional CTF tasks
  { benchmark: 'Terminal-Bench 2.0', tasks: 89 }, // arXiv 2601.11868
  { benchmark: 'HumanEval', tasks: 164 },
  { benchmark: 'GAIA (validation)', tasks: 165 },
  { benchmark: 'NYU CTF Bench', tasks: 200 },
  { benchmark: 'CyberGym L1 subset', tasks: 300 }, // the subset the paper evaluates
  { benchmark: 'OSWorld', tasks: 369 },
  { benchmark: 'SWE-bench Pro', tasks: 731 },
  { benchmark: 'WebArena', tasks: 812 },
  { benchmark: 'FieldWorkArena', tasks: 890 },
  { benchmark: 'CyberGym (full)', tasks: 1507 }, // 1,507 instances, 188 projects
];

const N = 32;
const K = 1;

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function main(): void {
  console.log('Minimum resolvable difference, published agent benchmarks');
  console.log('='.repeat(78));
  console.log(
    `\nSampling design assumed: n=${N} samples per task, reporting pass@${K}, ` +
      `95% confidence.\nVariance is the worst case over all true success rates, so these are ` +
      `guarantees,\nnot estimates at a convenient operating point.\n`,
  );

  const rows = resolutionTable(BENCHMARKS.map((b) => ({ ...b, n: N, k: K })));

  console.log(
    'benchmark'.padEnd(22) +
      'tasks'.padStart(6) +
      'score +/-'.padStart(12) +
      'MRD unpaired'.padStart(14) +
      'MRD paired'.padStart(12) +
      '   (rho=0.7)',
  );
  console.log('-'.repeat(78));

  for (const row of rows) {
    const paired = resolvingPower({ n: N, k: K, tasks: row.tasks }, 0.7);
    console.log(
      row.benchmark.padEnd(22) +
        String(row.tasks).padStart(6) +
        pct(row.resolution.halfWidth).padStart(12) +
        pct(row.resolution.unpairedMrd).padStart(14) +
        pct(paired.pairedMrd).padStart(12),
    );
  }

  console.log(
    '\n"MRD unpaired" is the smallest gap between two models that clears significance\n' +
      'when they are evaluated separately. "MRD paired" is the same thing when both run\n' +
      'the identical task set -- the cheapest precision available, and it costs nothing.\n',
  );

  // Clustering is the part everyone omits, and it is the part that dominates.
  console.log('Clustering, which none of the above accounts for');
  console.log('='.repeat(78));
  console.log(
    '\nCyberGym draws 1,507 instances from 188 projects. Tasks from one project are\n' +
      'not independent observations. At an intra-cluster correlation of 0.3:\n',
  );

  const clusterSizes = Array.from({ length: 188 }, () => 1507 / 188);
  const deff = designEffect(clusterSizes, 0.3);
  const naive = resolvingPower({ n: N, k: K, tasks: 1507 });
  const clustered = resolvingPower({ n: N, k: K, tasks: 1507, designEffect: deff });

  console.log(`  design effect                 ${deff.toFixed(2)}x`);
  console.log(
    `  effective tasks               ${clustered.effectiveTasks.toFixed(0)} (not ${1507})`,
  );
  console.log(`  MRD assuming independence     ${pct(naive.unpairedMrd)}`);
  console.log(`  MRD accounting for clusters   ${pct(clustered.unpairedMrd)}`);
  console.log(
    `  interval understated by       ${(clustered.unpairedMrd / naive.unpairedMrd).toFixed(2)}x\n`,
  );
  console.log(
    'Note the two scales, because conflating them is easy and wrong. The design effect\n' +
      'is a VARIANCE ratio; standard errors and MRDs are its square root. A 3.10x design\n' +
      'effect widens the interval by 1.76x, not 3.10x.\n',
  );
  // Miller reports up to 3x on the SE scale, which is a 9x design effect. Check
  // whether this cluster structure can even reach that, rather than implying it
  // does. Average cluster size caps the design effect at ICC = 1.
  const meanClusterSize = clusterSizes[0]!;
  const maxDeff = designEffect(clusterSizes, 1);
  const maxSeInflation = Math.sqrt(maxDeff);
  console.log(
    'Miller (arXiv 2411.00640) measures cluster-adjusted STANDARD ERRORS up to 3x the\n' +
      'naive ones, which is a 9x design effect. This benchmark cannot reach that:\n',
  );
  console.log(
    `  mean cluster size             ${meanClusterSize.toFixed(1)} tasks per project`,
  );
  console.log(`  design effect at ICC = 1      ${maxDeff.toFixed(2)}x (the ceiling)`);
  console.log(
    `  widest possible interval      ${maxSeInflation.toFixed(2)}x the naive one\n`,
  );
  console.log(
    'So a 3x understatement needs much larger clusters than 8 tasks -- a benchmark\n' +
      'drawn from a handful of repositories, say. The number that matters is not any\n' +
      'particular ICC. It is that no agent benchmark publishes one, so no published\n' +
      'interval on any of them can be checked by a reader.\n',
  );

  console.log('What it would take to resolve 2 points');
  console.log('='.repeat(78) + '\n');
  for (const rho of [0, 0.5, 0.8]) {
    const { tasks } = requiredTasks({
      n: N,
      k: K,
      targetDifference: 0.02,
      pairedCorrelation: rho,
    });
    console.log(`  score correlation ${rho.toFixed(1)}   ->  ${tasks} tasks`);
  }
  console.log(
    '\nPairing is not a refinement. At rho=0.8 the same claim needs a fifth of the\n' +
      'tasks, which is the difference between a benchmark you can afford to run and\n' +
      'one you cannot.\n',
  );
}

main();
