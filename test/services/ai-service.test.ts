import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { call, killAll, ok, startServicesPod, until, world } from './helpers';

after(killAll);

const KEY = 'sk-test-0123456789abcdef';
const files = (home: string) => ({
  pod: () => JSON.parse(fs.readFileSync(path.join(home, 'pod.json'), 'utf8')),
  secretsFile: path.join(home, 'secrets.json'),
  secrets: () => JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')),
});

interface Seen {
  method: string;
  path: string;
  auth?: string;
  body: any;
}
type Answer = { status: number; body: unknown };

/** A local AI service whose answer the test chooses per request; every request is recorded. */
async function provider(answer: (req: Seen) => Answer = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } })) {
  const seen: Seen[] = [];
  let respond = answer;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const entry = { method: req.method!, path: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      const { status, body } = respond(entry);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    seen,
    answer(next: (req: Seen) => Answer) {
      respond = next;
    },
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

const noKeyInLogs = (logs: string[]) => assert.ok(!logs.some((l) => l.includes(KEY)), 'the key is never logged');

test('an AI service set on a news-only pod is tested, saved and in use at once: failed topics are made again', async () => {
  const w = await world({ config: { ai: undefined } });
  const f = files(w.home);
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.equal((await ok(pod, 'reading.status')).ai, null);
    const fact = await pod.ask('plantFact', { statement: 'Follows chess', status: 'error' });

    const reply = await ok(pod, 'aiService.set', { baseUrl: `${w.model.baseUrl}/`, model: 'small-model', apiKey: KEY });
    assert.deepEqual(reply, { set: true });
    assert.equal(f.pod().ai.model, 'small-model');
    assert.equal(f.pod().ai.baseUrl, w.model.baseUrl);
    assert.equal(f.secrets().aiApiKey, KEY);
    assert.equal(fs.statSync(f.secretsFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(w.home, 'pod.json')).mode & 0o777, 0o600);

    // The test request: one short completion, sent to an address the pod's fetch did not yet allow.
    const probe = w.model.requests[0];
    assert.equal(probe.path, '/v1/chat/completions');
    assert.equal((probe.body as any).model, 'small-model');
    assert.equal((probe.body as any).max_tokens, 16);

    const status = await ok(pod, 'reading.status');
    assert.deepEqual(status.ai, { host: new URL(w.model.baseUrl).host, model: 'small-model', relevanceModel: 'small-model', reasons: true });
    assert.equal(status.aiAfterRestart, undefined);
    assert.equal(status.reading, 'on');
    assert.ok(!status.problems.some((p: { code: string }) => p.code === 'no_ai_service'));
    assert.doesNotMatch(JSON.stringify(status), new RegExp(KEY));

    // The failed fact's topics are made by the new service, through the pod's guarded fetch.
    await until(() => pod.ask('factRows'), (rows: any[]) => rows.find((r) => r.id === fact.id)?.topicsStatus === 'done', 'the failed topics made again');
    assert.ok(w.model.bodies.some((b) => b.model === 'small-model' && /Fact: "Follows chess"/.test(b.messages.at(-1)!.content)));
    assert.ok(!pod.logs.some((l) => l.includes('blocked request')), 'the new address was allowed before it was used');
    noKeyInLogs(pod.logs);

    // A second set switches again without starting the inference queue a second time.
    await ok(pod, 'aiService.set', { baseUrl: w.model.baseUrl, model: 'small-model' });
    assert.equal(await pod.ask('queueStarts'), 1);
    await pod.ask('stop');

    const next = startServicesPod(w.home);
    assert.deepEqual(await next.first, { ready: true });
    assert.deepEqual((await ok(next, 'reading.status')).ai, status.ai);
    await next.ask('stop');
  } finally {
    await w.close();
  }
});

test('two models: articles are rated by the relevance model, topics are made by the main one, and each was tested first', async () => {
  const w = await world({ articles: [{ _id: 'c1', title: 'Chess final goes to a tiebreak' }], topics: { chess: ['c1'] } });
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await ok(pod, 'aiService.set', { baseUrl: w.model.baseUrl, model: 'chat-m', relevanceModel: 'rel-m' });
    const tested = w.model.bodies.filter((b) => b.max_tokens === 16).map((b) => b.model);
    assert.deepEqual(tested.sort(), ['chat-m', 'rel-m']);
    assert.equal(files(w.home).pod().ai.relevanceModel, 'rel-m');
    assert.equal((await ok(pod, 'reading.status')).ai.relevanceModel, 'rel-m');

    const from = w.model.bodies.length;
    const fact = await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    const user = (b: { messages: { role: string; content: string }[] }) => [...b.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    await until(async () => w.model.bodies.slice(from), (bodies) => bodies.some((b) => user(b).includes('===== Article ')), 'an article rated');
    await pod.ask('regenerate', fact.id);
    await until(async () => w.model.bodies.slice(from), (bodies) => bodies.some((b) => user(b).startsWith('Fact: "')), 'topics made');
    const after = w.model.bodies.slice(from);
    assert.deepEqual([...new Set(after.filter((b) => user(b).includes('===== Article ')).map((b) => b.model))], ['rel-m']);
    assert.deepEqual([...new Set(after.filter((b) => user(b).startsWith('Fact: "')).map((b) => b.model))], ['chat-m']);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a service that fails the test is refused with a plain reason, and nothing is saved', async () => {
  const w = await world({ config: { ai: undefined } });
  const ai = await provider();
  const closed = await provider();
  await closed.close();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const before = fs.readFileSync(path.join(w.home, 'pod.json'), 'utf8');
    const refuse = async (change: object, reason: RegExp) => {
      const reply = await call(pod, 'aiService.set', change);
      assert.equal(reply.error?.code, 'ai_test_failed', JSON.stringify(change));
      assert.match(reply.error!.message, reason);
      assert.ok(reply.error!.next);
      assert.ok(reply.error!.message.length < 400);
      assert.doesNotMatch(reply.error!.message, new RegExp(KEY));
    };

    ai.answer(() => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } }));
    await refuse({ baseUrl: ai.baseUrl, model: 'm', apiKey: KEY }, /refused the key/);
    ai.answer(() => ({ status: 404, body: { error: { message: 'no such thing' } } }));
    await refuse({ baseUrl: ai.baseUrl, model: 'big-model', apiKey: KEY }, /big-model/);
    ai.answer((r) => (r.body.model === 'rel' ? { status: 400, body: { error: { message: 'The model `rel` does not exist' } } } : { status: 200, body: {} }));
    await refuse({ baseUrl: ai.baseUrl, model: 'chat', relevanceModel: 'rel', apiKey: KEY }, /"rel"/);
    ai.answer(() => ({ status: 500, body: { error: { message: `Overloaded for ${KEY} ${'x'.repeat(500)}` } } }));
    await refuse({ baseUrl: ai.baseUrl, model: 'm', apiKey: KEY }, /^The service answered: Overloaded for \[key\] x+/);
    await refuse({ baseUrl: closed.baseUrl, model: 'm', apiKey: KEY }, /cannot reach/i);

    assert.equal(fs.readFileSync(path.join(w.home, 'pod.json'), 'utf8'), before);
    assert.ok(!fs.existsSync(files(w.home).secretsFile) || files(w.home).secrets().aiApiKey === undefined);
    assert.equal((await ok(pod, 'reading.status')).ai, null);
    noKeyInLogs(pod.logs);
    await pod.ask('stop');
  } finally {
    await ai.close();
    await w.close();
  }
});

test('a key is never sent to an address it was not given for: a new address without a key drops the old one, the same address keeps it', async () => {
  const w = await world();
  const one = await provider();
  const two = await provider();
  const f = files(w.home);
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await ok(pod, 'aiService.set', { baseUrl: one.baseUrl, model: 'm', apiKey: KEY });
    await ok(pod, 'aiService.set', { baseUrl: `${one.baseUrl}/v2`, model: 'other' });
    assert.equal(f.secrets().aiApiKey, KEY, 'same origin, no key given: kept');
    assert.equal(one.seen.at(-1)!.path, '/v1/v2/chat/completions');
    assert.equal(one.seen.at(-1)!.auth, `Bearer ${KEY}`);
    assert.equal(f.pod().ai.model, 'other');
    await ok(pod, 'aiService.set', { baseUrl: two.baseUrl, model: 'other' });
    assert.equal(two.seen[0].auth, undefined, 'the new address never got the old key');
    assert.equal(f.secrets().aiApiKey, undefined, 'new origin, no key given: removed');
    assert.equal(f.pod().ai.baseUrl, two.baseUrl);
    await pod.ask('stop');
  } finally {
    await one.close();
    await two.close();
    await w.close();
  }
});

test('a new key for the same service clears the refused-key problem at once', async () => {
  const w = await world({ config: { ai: undefined }, articles: [{ _id: 'c1', title: 'Chess final goes to a tiebreak' }], topics: { chess: ['c1'] } });
  const ai = await provider((r) => (r.auth === `Bearer ${KEY}` ? { status: 200, body: { choices: [{ message: { content: '[0.9]' } }] } } : { status: 401, body: {} }));
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await ok(pod, 'aiService.set', { baseUrl: ai.baseUrl, model: 'm', apiKey: KEY });
    await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    // The key stops working at the service: the pod's next request is refused.
    ai.answer(() => ({ status: 401, body: {} }));
    await until(() => ok(pod, 'reading.status'), (s) => s.problems.some((p: any) => p.code === 'ai_key_refused'), 'the refused key');
    ai.answer(() => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } }));
    await ok(pod, 'aiService.set', { baseUrl: ai.baseUrl, model: 'm', apiKey: `${KEY}-new` });
    assert.ok(!(await ok(pod, 'reading.status')).problems.some((p: any) => p.code === 'ai_key_refused'));
    await pod.ask('stop');
  } finally {
    await ai.close();
    await w.close();
  }
});

test('the model list keeps chat models only, sorted, with the key sent; a refusal says why', async () => {
  const w = await world({ config: { ai: undefined } });
  const plain = await provider(() => ({
    status: 200,
    body: { data: ['models/gpt-b', 'gpt-a', 'text-embedding-3', 'tts-1', 'whisper-1', 'dall-e-3', 'gpt-image-1', 'gpt-a', 'omni-moderation', 'gpt-realtime', 'gpt-audio'].map((id) => ({ id })) },
  }));
  const tagged = await provider(() => ({
    status: 200,
    body: { data: [{ id: 'm-chat', capabilities: { completion_chat: true } }, { id: 'm-embed', capabilities: { completion_chat: false } }] },
  }));
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.deepEqual(await ok(pod, 'aiService.models', { baseUrl: plain.baseUrl, apiKey: KEY }), { models: ['gpt-a', 'gpt-b'] });
    assert.equal(plain.seen[0].method, 'GET');
    assert.equal(plain.seen[0].path, '/v1/models');
    assert.equal(plain.seen[0].auth, `Bearer ${KEY}`);
    assert.deepEqual(await ok(pod, 'aiService.models', { baseUrl: tagged.baseUrl }), { models: ['m-chat'] });
    assert.equal(tagged.seen[0].auth, undefined);

    plain.answer(() => ({ status: 403, body: {} }));
    const refused = await call(pod, 'aiService.models', { baseUrl: plain.baseUrl, apiKey: KEY });
    assert.equal(refused.error?.code, 'ai_models_failed');
    assert.match(refused.error!.message, /refused the key/);
    assert.equal((await call(pod, 'aiService.models', { baseUrl: 'ftp://x' })).error?.code, 'bad_input');

    const providers = await ok(pod, 'aiService.providers');
    assert.equal(providers.at(-1).id, 'other');
    noKeyInLogs(pod.logs);
    await pod.ask('stop');
  } finally {
    await plain.close();
    await tagged.close();
    await w.close();
  }
});

test('reasons can be turned off and on, with the service or alone, and status says which', async () => {
  const w = await world({ config: { ai: undefined } });
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.equal((await call(pod, 'aiService.setReasons', false)).error?.code, 'no_ai_service');
    await ok(pod, 'aiService.set', { baseUrl: w.model.baseUrl, model: 'm', reasons: false });
    assert.equal((await ok(pod, 'reading.status')).ai.reasons, false);
    await ok(pod, 'aiService.set', { baseUrl: w.model.baseUrl, model: 'm' });
    assert.equal((await ok(pod, 'reading.status')).ai.reasons, false, 'left out: kept');
    assert.deepEqual(await ok(pod, 'aiService.setReasons', true), { set: true });
    assert.equal((await ok(pod, 'reading.status')).ai.reasons, true);
    assert.equal((await call(pod, 'aiService.setReasons', 'yes')).error?.code, 'bad_input');
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
      { baseUrl: 'https://ai.example.org', model: 'm', relevanceModel: 'a\nb' },
      { baseUrl: 'https://ai.example.org', model: 'm', reasons: 'no' },
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
    assert.equal(w.model.requests.length, 0, 'nothing was sent');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('with MERA_POD_AI_API_KEY set, the AI service is not set here: nothing is sent and nothing saved', async () => {
  const w = await world();
  const other = await provider();
  const f = files(w.home);
  try {
    const pod = startServicesPod(w.home, { MERA_POD_AI_API_KEY: KEY });
    assert.deepEqual(await pod.first, { ready: true });
    const before = fs.readFileSync(path.join(w.home, 'pod.json'), 'utf8');
    for (const [fn, arg] of [
      ['aiService.set', { baseUrl: other.baseUrl, model: 'm' }],
      ['aiService.set', { baseUrl: other.baseUrl, model: 'm', apiKey: `${KEY}-new` }],
      ['aiService.set', { baseUrl: w.model.baseUrl, model: 'other' }],
      ['aiService.models', { baseUrl: other.baseUrl }],
    ] as const) {
      const reply = await call(pod, fn, arg);
      assert.equal(reply.error?.code, 'bad_input', JSON.stringify(arg));
      assert.match(reply.error!.message, /MERA_POD_AI_API_KEY/);
      assert.ok(reply.error!.next);
    }
    assert.equal(other.seen.length, 0, 'nothing was sent to the new address');
    assert.ok(!w.model.bodies.some((b) => b.max_tokens === 16), 'no test request was sent');
    assert.equal(fs.readFileSync(path.join(w.home, 'pod.json'), 'utf8'), before);
    assert.ok(!fs.existsSync(f.secretsFile));
    noKeyInLogs(pod.logs);
    await pod.ask('stop');
  } finally {
    await other.close();
    await w.close();
  }
});

test('the person\'s harness applies to the main model only, also when the relevance model is the one the pod started with', async () => {
  const w = await world({ articles: [{ _id: 'c1', title: 'Chess final goes to a tiebreak' }], topics: { chess: ['c1'] } });
  fs.mkdirSync(path.join(w.home, 'harness'));
  fs.writeFileSync(path.join(w.home, 'harness', 'harness.json'), JSON.stringify({ params: { quirks: ['thinking-off-kwarg'] } }));
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    // The pod started with model m and the harness mapped to it; m is now only the relevance model.
    await ok(pod, 'aiService.set', { baseUrl: w.model.baseUrl, model: 'chat-m', relevanceModel: 'm' });
    const from = w.model.bodies.length;
    const fact = await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    const user = (b: { messages: { role: string; content: string }[] }) => [...b.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    await until(async () => w.model.bodies.slice(from), (bodies) => bodies.some((b) => user(b).includes('===== Article ')), 'an article rated');
    await pod.ask('regenerate', fact.id);
    await until(async () => w.model.bodies.slice(from), (bodies) => bodies.some((b) => user(b).startsWith('Fact: "')), 'topics made');
    const later = w.model.bodies.slice(from) as any[];
    const rated = later.filter((b) => user(b).includes('===== Article '));
    const topics = later.filter((b) => user(b).startsWith('Fact: "'));
    assert.ok(rated.every((b) => b.model === 'm' && b.chat_template_kwargs === undefined), 'rating runs without the harness');
    assert.ok(topics.every((b) => b.model === 'chat-m' && b.chat_template_kwargs !== undefined), 'the main model runs with the harness');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a switch that fails after saving is undone: the old service stays in use, and a reasons choice is kept', async () => {
  const w = await world();
  const other = await provider();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const fact = await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    await pod.ask('failNextApply');
    const reply = await call(pod, 'aiService.set', { baseUrl: other.baseUrl, model: 'other', reasons: false, apiKey: KEY });
    assert.equal(reply.error?.code, 'ai_not_applied');
    assert.match(reply.error!.message, /saved.*next start/);
    assert.doesNotMatch(reply.error!.message, new RegExp(KEY));
    assert.equal(files(w.home).pod().ai.baseUrl, other.baseUrl, 'saved for the next start');

    const status = await ok(pod, 'reading.status');
    assert.equal(status.ai.host, new URL(w.model.baseUrl).host, 'the old service is still in use');
    assert.equal(status.ai.reasons, false, 'the reasons choice was kept');

    const tested = other.seen.length;
    const from = w.model.bodies.length;
    await pod.ask('regenerate', fact.id);
    await until(async () => w.model.bodies.slice(from), (bodies) => bodies.some((b) => b.model === 'm'), 'topics made by the old service');
    assert.equal(other.seen.length, tested, 'nothing but the test reached the new address');
    assert.ok(!pod.logs.some((l) => l.includes('blocked request')));
    noKeyInLogs(pod.logs);
    await pod.ask('stop');
  } finally {
    await other.close();
    await w.close();
  }
});
