import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSchemaPath, startFakeDataServer, startFakeModel } from '../../src/testing';
import { call, killAll, ok, startServicesPod } from '../services/helpers';
import { fixture } from './helpers';

after(killAll);

/** A home whose pod.json has no ai block, beside a model the config does not name. */
async function newsOnlyWorld() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-news-only-'));
  const data = await startFakeDataServer({ schemaPath: defaultSchemaPath(), articles: [{ _id: 'a1', title: 'One' }], topics: {} }); // no places: a store without them must not add a second problem
  const model = await startFakeModel();
  fs.writeFileSync(path.join(home, 'pod.json'), JSON.stringify({ dataServer: { url: data.origin }, language: 'en' }));
  return {
    home,
    data,
    model,
    async close() {
      await data.close();
      await model.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('news-only: the pod starts with no ai, sends nothing to any AI origin, and the assistant is told to pick', async () => {
  const w = await newsOnlyWorld();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });

    const status = await ok(pod, 'reading.status');
    assert.deepEqual(status.problems.map((p: { code: string }) => p.code), ['no_ai_service']);
    assert.equal(status.problems[0].who, 'assistant', 'the person\'s own assistant picks instead');
    assert.match(status.problems[0].fix, /^Nothing is saved yet\. Offer to set up their news profile/, 'with nothing saved, the assistant is told to set up the profile');
    assert.equal(status.ai, null);
    assert.equal(status.reading, 'paused', 'nothing can read without an AI service');
    assert.equal(status.nextReadAt, null);

    const empty = await ok(pod, 'suggestions.get', { limit: 10 });
    assert.equal(empty.state, 'no_facts');
    assert.match(empty.hint, /Ask your assistant to set up your news profile\.$/, 'a page shows this to the person');

    const news = await ok(pod, 'news.graphql', { operationName: 'NewsServerStatus', query: 'query NewsServerStatus { newsServerStatus { placesSeeded } }' });
    assert.ok(news.data || news.errors, 'the data server answered');

    const added = await ok(pod, 'profile.addFacts', ['Follows sailing']);
    assert.equal(added.added.length, 1);
    await new Promise((r) => setTimeout(r, 3000));
    const facts = await ok(pod, 'profile.get');
    assert.equal(facts.facts.length, 1);
    assert.equal(facts.facts[0].topicsStatus, 'pending', 'no topic job ran');
    assert.ok(pod.logs.filter((l) => l.includes('Geo derivation failed')).length <= 1);

    // The assistant writes the topics itself, and the pod is then usable, not waiting on a read.
    const topics = await ok(pod, 'profile.addTopics', added.added[0].id, ['sailing', 'regattas']);
    assert.deepEqual(topics.added.map((t: { text: string }) => t.text), ['sailing', 'regattas']);
    assert.equal(topics.note, undefined);
    assert.equal((await ok(pod, 'profile.get')).facts[0].topicsStatus, 'done');
    const suggestions = await ok(pod, 'suggestions.get', { limit: 10 });
    assert.equal(suggestions.state, 'ok');
    assert.deepEqual(suggestions.picks, []);
    assert.equal(suggestions.hint, 'This pod makes no picks on its own. Ask your assistant for the news.');
    assert.match((await ok(pod, 'reading.status')).problems[0].fix, /^This pod does not rate the news on its own\. Pick for the person yourself/);
    assert.doesNotMatch(suggestions.hint, /pod\.json|key/i);

    assert.equal(await pod.ask('trigger'), 'paused', 'a read is held');
    const chat = await call(pod, 'model.chatCompletions', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(chat.error?.code, 'no_ai_service');

    assert.equal(w.model.requests.length, 0);
    assert.equal(w.model.bodies.length, 0);
    assert.deepEqual(pod.logs.filter((l) => l.includes('blocked request to')), []);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('news-only: check prints the no-AI line and still checks the data server', async () => {
  const w = await newsOnlyWorld();
  try {
    const proc = spawn(process.execPath, ['--import', 'tsx', fixture('cli-child.ts'), 'check'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, MERA_POD_HOME: w.home } });
    process.once('exit', () => proc.kill('SIGKILL'));
    let out = '';
    proc.stdout!.on('data', (d) => (out += d));
    assert.equal(await new Promise((r) => proc.once('exit', r)), 0);
    assert.ok(out.split('\n').includes('No AI service is set: only the news tools work.'));
    assert.equal(w.data.requests.length, 1);
    assert.equal(w.model.requests.length, 0);
  } finally {
    await w.close();
  }
});
