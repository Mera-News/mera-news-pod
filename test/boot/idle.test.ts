import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { killAll, startPod, world } from './helpers';

after(killAll);

test('a pod with an empty profile asks the data server once at start, then waits for the next scheduled read', async () => {
  const w = await world();
  try {
    const pod = startPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    // Four scheduler ticks.
    await new Promise((r) => setTimeout(r, 21_000));
    const asked = w.data.requests.map((r) => (r.body as { operationName?: string } | null)?.operationName ?? r.path);
    assert.ok(asked.length <= 2, `the data server was asked ${asked.length} times: ${asked.join(', ')}`);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});
