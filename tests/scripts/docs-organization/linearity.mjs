// Linear-time assertions that survive a loaded host. A wall-clock budget
// measures the machine; the cost ratio between n and 4n measures the
// algorithm: linear ≈ 4, quadratic ≈ 16. Load slows both sizes alike.
import { performance } from 'node:perf_hooks';

export const LINEAR_LIMIT = 8;
const RUNS = 3;
// A sub-millisecond small run makes the ratio pure noise; callers must pick
// an n whose small run costs well over this floor.
const FLOOR_MS = 1;

async function bestOf(fn, n) {
  let best = Infinity;
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await fn(n);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

export async function scalingRatio(fn, n) {
  await fn(n); // warm the JIT so the first timed run is not an outlier
  const small = Math.max(await bestOf(fn, n), FLOOR_MS);
  const large = await bestOf(fn, 4 * n);
  return large / small;
}
