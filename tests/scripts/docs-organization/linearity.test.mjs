import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scalingRatio, LINEAR_LIMIT } from './linearity.mjs';

const linear = (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
};

const quadratic = (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s += (i ^ j) & 1;
  return s;
};

test('a linear function scales under the limit', async () => {
  assert.ok(await scalingRatio(linear, 6_000_000) < LINEAR_LIMIT);
});

test('a quadratic function scales over the limit', async () => {
  assert.ok(await scalingRatio(quadratic, 4_000) > LINEAR_LIMIT);
});

test('scalingRatio awaits every call to an async function', async () => {
  // 1 warm-up + 3 small + 3 large runs. The call must finish on a timer
  // (macrotask): microtask continuations would be flushed by the test's own
  // `await scalingRatio(...)` even if the helper never awaited fn.
  let completed = 0;
  const fn = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    completed++;
  };
  await scalingRatio(fn, 1);
  assert.equal(completed, 7);
});
