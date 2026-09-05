/**
 * Point estimators for agent evaluation.
 *
 * Four quantities, because "did it succeed" is four different questions and
 * every current leaderboard renders them as one number.
 *
 *   pass@k      can it EVER do this, given k attempts -- a capability ceiling
 *   pass^k      does it do this EVERY time across k trials -- reliability
 *   G-pass@k_t  does it succeed on at least a fraction t of k trials
 *   mG-pass@k   G-pass integrated over t, so potential and stability collapse
 *               into one number without pretending stability is optional
 *
 * The gap between pass@k and pass^k is the finding. A model with
 * pass@10 = 0.9 and pass^10 = 0.1 succeeds nine times in ten *runs of ten* and
 * fails most individual attempts. Deployed, that is not a 0.9 system. HAL
 * pivoted its whole research programme toward reliability after measuring this,
 * and today's leaderboards still publish the 0.9 alone.
 *
 * All four are UNBIASED estimators computed from n samples with c successes.
 * The naive alternative -- run k attempts once, report whether any passed -- is
 * biased and high-variance, and it is what most harnesses do.
 *
 * Reference: Chen et al. 2021 (Codex), section 2.1, for pass@k; the G-pass
 * family from the Bayesian-evaluation literature (arXiv 2510.04265).
 */

/**
 * log(n!) by cumulative summation, memoised.
 *
 * Used instead of a Lanczos gamma approximation because every argument here is
 * a small non-negative integer, where the exact cumulative sum is both simpler
 * and more accurate. Combinatorics are done in log space throughout: C(1000,
 * 500) overflows a double by hundreds of orders of magnitude, and a
 * hypergeometric tail computed with raw factorials silently returns NaN.
 */
const logFactorialTable: number[] = [0, 0];

function logFactorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) {
    throw new RangeError(`logFactorial expects a non-negative integer, got ${n}`);
  }
  for (let i = logFactorialTable.length; i <= n; i++) {
    logFactorialTable[i] = logFactorialTable[i - 1]! + Math.log(i);
  }
  return logFactorialTable[n]!;
}

/** log C(n, k). Returns -Infinity when the choice is impossible. */
export function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

function assertSample(n: number, c: number, k: number): void {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`n must be a positive integer, got ${n}`);
  if (!Number.isInteger(c) || c < 0 || c > n) {
    throw new RangeError(`c must be an integer in [0, ${n}], got ${c}`);
  }
  if (!Number.isInteger(k) || k <= 0) throw new RangeError(`k must be a positive integer, got ${k}`);
  if (k > n) {
    throw new RangeError(
      `k=${k} exceeds n=${n}: pass@k cannot be estimated from fewer samples than attempts`,
    );
  }
}

/**
 * Unbiased pass@k (Chen et al. 2021).
 *
 *     P_k = 1 - C(n-c, k) / C(n, k)
 *
 * Computed as the complementary product rather than from the ratio of
 * binomials. The closed form is arithmetically identical and numerically
 * hostile: both terms overflow well before n = 200, and the ratio of two
 * infinities is NaN. The product form stays in [0, 1] throughout.
 */
export function passAtK(n: number, c: number, k: number): number {
  assertSample(n, c, k);
  // Fewer than k failures means every k-subset contains a success.
  if (n - c < k) return 1;
  let product = 1;
  for (let i = n - c + 1; i <= n; i++) {
    product *= 1 - k / i;
  }
  return 1 - product;
}

/**
 * Unbiased pass^k: the probability that all of k trials succeed.
 *
 *     P^k = C(c, k) / C(n, k)
 *
 * which is the chance that a uniformly drawn k-subset of the n samples is
 * entirely successes. Computed as a running product for the same numerical
 * reason as above.
 *
 * This is the reliability number. It is the one a deployment decision actually
 * rests on, and essentially nobody publishes it.
 */
export function passPowK(n: number, c: number, k: number): number {
  assertSample(n, c, k);
  if (c < k) return 0;
  let product = 1;
  for (let i = 0; i < k; i++) {
    product *= (c - i) / (n - i);
  }
  return product;
}

/**
 * G-pass@k at threshold tau: succeeds on at least ceil(tau * k) of k trials.
 *
 * The hypergeometric tail over k-subsets of the n samples:
 *
 *     sum over j >= ceil(tau*k) of  C(c, j) * C(n-c, k-j) / C(n, k)
 *
 * pass@k and pass^k are the endpoints of this family -- tau just above 0
 * recovers pass@k, tau = 1 recovers pass^k -- so a leaderboard that reports
 * G-pass at a few thresholds is reporting the whole reliability curve rather
 * than two points on it.
 */
export function gPassAtK(n: number, c: number, k: number, tau: number): number {
  assertSample(n, c, k);
  if (tau < 0 || tau > 1) throw new RangeError(`tau must be in [0, 1], got ${tau}`);

  const threshold = Math.ceil(tau * k);
  // At least zero successes is certain; the sum below would also give 1 but
  // this says why.
  if (threshold <= 0) return 1;
  if (threshold > k) return 0;

  const logDenominator = logChoose(n, k);
  let total = 0;
  for (let j = threshold; j <= Math.min(k, c); j++) {
    const logTerm = logChoose(c, j) + logChoose(n - c, k - j) - logDenominator;
    if (logTerm > -Infinity) total += Math.exp(logTerm);
  }
  // Guard against accumulated floating error escaping the unit interval.
  return Math.min(1, Math.max(0, total));
}

/**
 * mG-pass@k: G-pass integrated over tau in [0.5, 1].
 *
 *     mG-pass@k = (2/k) * sum over i in (k/2, k] of G-pass@k_{i/k}
 *
 * The lower limit is 0.5 rather than 0 deliberately: a model that succeeds on
 * fewer than half its attempts is not "sometimes reliable", and averaging that
 * region in would let a high pass@k paper over it. This is a single number that
 * cannot be inflated by luck the way pass@k can.
 */
export function mGPassAtK(n: number, c: number, k: number): number {
  assertSample(n, c, k);
  let total = 0;
  const start = Math.floor(k / 2) + 1;
  for (let i = start; i <= k; i++) {
    total += gPassAtK(n, c, k, i / k);
  }
  return Math.min(1, Math.max(0, (2 / k) * total));
}

/**
 * Exact variance of the pass@k estimator at a given true success rate.
 *
 * c is Binomial(n, p), and pass@k is a deterministic function of c, so the
 * variance is computed exactly by summing over every attainable c rather than
 * by simulation. Cheap, and it removes a source of Monte Carlo noise from a
 * number whose entire job is to quantify noise.
 *
 * This is the input to the minimum resolvable difference.
 */
export function passAtKVariance(n: number, k: number, p: number): number {
  if (p < 0 || p > 1) throw new RangeError(`p must be in [0, 1], got ${p}`);

  let expectation = 0;
  let expectationOfSquare = 0;

  for (let c = 0; c <= n; c++) {
    const logProbability =
      logChoose(n, c) +
      (c === 0 ? 0 : c * Math.log(p)) +
      (n - c === 0 ? 0 : (n - c) * Math.log(1 - p));
    // p = 0 or 1 makes all but one term log(0); those are genuine zeros.
    const probability = Number.isFinite(logProbability) ? Math.exp(logProbability) : 0;
    if (probability === 0) continue;
    const value = passAtK(n, c, k);
    expectation += probability * value;
    expectationOfSquare += probability * value * value;
  }

  return Math.max(0, expectationOfSquare - expectation * expectation);
}

/**
 * The worst-case variance of pass@k over all true success rates.
 *
 * A benchmark's resolving power has to hold for whatever the models actually
 * score, which is not known before running them. Taking the maximum over p
 * makes the resulting minimum resolvable difference a guarantee rather than an
 * estimate that happens to hold at the p someone assumed.
 *
 * Scanned on a grid then refined locally: the variance is smooth and
 * single-peaked in p, so this converges quickly and needs no derivative.
 */
export function maxPassAtKVariance(n: number, k: number, gridPoints = 201): {
  variance: number;
  atP: number;
} {
  let best = { variance: -1, atP: 0 };

  for (let i = 0; i <= gridPoints; i++) {
    const p = i / gridPoints;
    const variance = passAtKVariance(n, k, p);
    if (variance > best.variance) best = { variance, atP: p };
  }

  // Refine around the grid maximum, since the peak rarely lands on a grid node.
  let step = 1 / gridPoints;
  for (let refinement = 0; refinement < 20; refinement++) {
    step /= 2;
    for (const candidate of [best.atP - step, best.atP + step]) {
      if (candidate < 0 || candidate > 1) continue;
      const variance = passAtKVariance(n, k, candidate);
      if (variance > best.variance) best = { variance, atP: candidate };
    }
  }

  return best;
}
