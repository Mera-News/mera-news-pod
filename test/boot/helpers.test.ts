import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { killAll, startPod, world } from './helpers';

after(killAll);

test('a pod process that ends while a test waits fails the call with how it ended', async () => {
  const w = await world();
  try {
    const pod = startPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const pending = pod.ask('a command the fixture never answers');
    pod.kill();
    await assert.rejects(pending, /ended \(exit code null, signal SIGKILL\); last stderr lines/);
    // And a call after the end fails at once instead of throwing from the channel.
    await assert.rejects(pod.ask('state'), /signal SIGKILL/);
  } finally {
    await w.close();
  }
});
