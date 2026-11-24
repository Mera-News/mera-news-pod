import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { call, killAll, ok, startServicesPod, world } from './helpers';

after(killAll);

const KEY = 'sk-test-0123456789abcdef';
const files = (home: string) => ({
  pod: () => JSON.parse(fs.readFileSync(path.join(home, 'pod.json'), 'utf8')),
  secretsFile: path.join(home, 'secrets.json'),
  secrets: () => JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')),
});

test('an AI service saved on a news-only pod answers only that it is set, is kept for the next start, and runs after it', async () => {
  const w = await world({ config: { ai: undefined } });
  const f = files(w.home);
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.equal((await ok(pod, 'reading.status')).ai, null);

    const reply = await ok(pod, 'aiService.set', { baseUrl: `${w.model.baseUrl}/`, model: 'small-model', apiKey: KEY });
    assert.deepEqual(reply, { set: true });
    assert.equal(f.pod().ai.model, 'small-model');
    assert.equal(f.pod().ai.baseUrl, w.model.baseUrl);
    assert.equal(f.secrets().aiApiKey, KEY);
    assert.equal(fs.statSync(f.secretsFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(w.home, 'pod.json')).mode & 0o777, 0o600);

    // The running pod keeps its boot settings and says what applies after a restart, never the key.
    const status = await ok(pod, 'reading.status');
    assert.equal(status.ai, null);
    assert.deepEqual(status.aiAfterRestart, { host: new URL(w.model.baseUrl).host, model: 'small-model' });
    assert.doesNotMatch(JSON.stringify(status), new RegExp(KEY));
    assert.ok(!pod.logs.some((l) => l.includes(KEY)), 'the key is never logged');
    await pod.ask('stop');

    const next = startServicesPod(w.home);
    assert.deepEqual(await next.first, { ready: true });
    const after = await ok(next, 'reading.status');
    assert.deepEqual(after.ai, { host: new URL(w.model.baseUrl).host, model: 'small-model' });
    assert.equal(after.aiAfterRestart, undefined);
    assert.ok(!after.problems.some((p: { code: string }) => p.code === 'no_ai_service'));
    await next.ask('stop');
  } finally {
    await w.close();
  }
});

test('a key is never sent to an address it was not given for: a new address without a key drops the old one, the same address keeps it', async () => {
  const w = await world();
  const f = files(w.home);
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await ok(pod, 'aiService.set', { baseUrl: w.model.baseUrl, model: 'm', apiKey: KEY });
    await ok(pod, 'aiService.set', { baseUrl: `${w.model.baseUrl}/v2`, model: 'other' });
    assert.equal(f.secrets().aiApiKey, KEY, 'same origin, no key given: kept');
    assert.equal(f.pod().ai.model, 'other');
    await ok(pod, 'aiService.set', { baseUrl: 'https://ai.example.org/v1', model: 'other' });
    assert.equal(f.secrets().aiApiKey, undefined, 'new origin, no key given: removed');
    assert.equal(f.pod().ai.baseUrl, 'https://ai.example.org/v1');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a bad address, model or key is refused with a next step and changes nothing', async () => {
  const w = await world({ config: { ai: undefined } });
  const f = files(w.home);
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const before = fs.readFileSync(path.join(w.home, 'pod.json'), 'utf8');
    for (const change of [
      { baseUrl: 'http://ai.example.org/v1', model: 'm' }, // plain http off this computer would send the key in the clear
      { baseUrl: 'ftp://ai.example.org', model: 'm' },
      { baseUrl: 'https://user:pass@ai.example.org', model: 'm' },
      { baseUrl: 'https://ai.example.org/v1?x=1', model: 'm' },
      { baseUrl: 'not an address', model: 'm' },
      { baseUrl: 'https://ai.example.org', model: '' },
      { baseUrl: 'https://ai.example.org', model: 'a\nb' },
      { baseUrl: 'https://ai.example.org', model: 'm', apiKey: 'has space' },
      { baseUrl: 'https://ai.example.org', model: 'm', apiKey: '' },
      { baseUrl: 'https://ai.example.org', model: 'm', apiKey: 'x'.repeat(2001) },
    ]) {
      const reply = await call(pod, 'aiService.set', change);
      assert.equal(reply.error?.code, 'bad_input', JSON.stringify(change));
      assert.ok(reply.error?.next, 'says what to do');
    }
    assert.equal(fs.readFileSync(path.join(w.home, 'pod.json'), 'utf8'), before);
    assert.ok(!fs.existsSync(f.secretsFile) || f.secrets().aiApiKey === undefined);
    assert.equal((await ok(pod, 'reading.status')).aiAfterRestart, undefined);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});
