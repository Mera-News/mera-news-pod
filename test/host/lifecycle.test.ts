import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from '../../src/host/lifecycle';

test('a cycle emits background, then active on a later macrotask', async () => {
  const lc = createLifecycle();
  const seen: string[] = [];
  lc.addEventListener('change', (s) => seen.push(s));
  assert.equal(lc.currentState, 'active');
  const done = lc.cycle();
  assert.deepEqual(seen, ['background']);
  assert.equal(lc.currentState, 'background');
  await done;
  assert.deepEqual(seen, ['background', 'active']);
  assert.equal(lc.currentState, 'active');
});

test('a removed listener hears nothing', async () => {
  const lc = createLifecycle();
  const seen: string[] = [];
  lc.addEventListener('change', (s) => seen.push(s)).remove();
  await lc.cycle();
  assert.deepEqual(seen, []);
});

test('the timer cycles unless paused, and stop ends it', async () => {
  const lc = createLifecycle();
  const seen: string[] = [];
  lc.addEventListener('change', (s) => seen.push(s));
  let paused = true;
  lc.startCycle(20, () => paused);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(seen.length, 0);
  paused = false;
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(seen.includes('background') && seen.includes('active'));
  lc.stop();
  // A cycle the timer started just before stop still comes back to active on the next macrotask.
  await new Promise((r) => setTimeout(r, 5));
  const count = seen.length;
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(seen.length, count);
});
