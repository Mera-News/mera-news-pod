import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { killAll, ok, startServicesPod, until, world } from '../services/helpers';
import { createNotifier, PartialSendError } from '../../src/notify';
import { sendNtfy } from '../../src/notify/ntfy';
import { sendWebhook } from '../../src/notify/webhook';
import type { PickView } from '../../src/plugin-api';

after(killAll);

interface Sink {
  origin: string;
  requests: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  status: number;
  /** When set, a request is recorded and never answered. */
  hang: boolean;
  /** Requests after this many answer 429. */
  tooManyAfter: number;
  close(): Promise<void>;
}
/** A loopback server that records what it is sent and answers with `status`. */
async function startSink(): Promise<Sink> {
  const sink: Sink = { origin: '', requests: [], status: 200, hang: false, tooManyAfter: Infinity, close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    sink.requests.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    if (sink.hang) return;
    res.writeHead(req.url === '/t' && sink.requests.length > sink.tooManyAfter ? 429 : sink.status);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  sink.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sink.close = () => new Promise((resolve) => (server.close(() => resolve()), server.closeAllConnections()));
  return sink;
}
const at = (sink: Sink, path: string) => sink.requests.filter((r) => r.path === path);
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

const pick = (over: Partial<PickView> = {}): PickView => ({
  id: 'pick-a',
  title: 'Dutch rail strike ends',
  publication: 'Paper',
  url: 'https://example.com/pick-a',
  publishedAt: '2026-11-18T01:00:00.000Z',
  level: 'high',
  lang: 'en',
  reason: 'You follow Dutch transport.',
  facts: ['Lives in Utrecht'],
  ...over,
});

test('ntfy gets the headline, the level and the link only, one message per pick: no reason and no fact', async () => {
  const sink = await startSink();
  try {
    await sendNtfy(`${sink.origin}/mera-topic`, [pick(), pick({ id: 'pick-b', title: 'Second headline', level: 'emergency', reason: 'Another reason.', url: 'https://example.com/pick-b' })]);
    assert.equal(sink.requests.length, 2);
    const [a, b] = sink.requests;
    assert.equal(a.headers.title, 'Dutch rail strike ends');
    assert.equal(a.headers.tags, 'high');
    assert.equal(a.headers.click, 'https://example.com/pick-a');
    assert.equal(a.body, 'https://example.com/pick-a');
    assert.equal(b.headers.tags, 'emergency');
    assert.equal(b.body, 'https://example.com/pick-b');
    // A reason is written from the profile, and anyone who knows the topic name can read it.
    assert.doesNotMatch(JSON.stringify(sink.requests), /Utrecht|Paper|Dutch transport|Another reason/);
  } finally {
    await sink.close();
  }
});

test('a title in another script is sent as an encoded header, not dropped or refused', async () => {
  const sink = await startSink();
  try {
    await sendNtfy(`${sink.origin}/t`, [pick({ title: 'Νέα ρεκόρ στην ιστιοπλοΐα\nsecond line' })]);
    const header = String(sink.requests[0].headers.title);
    const match = /^=\?UTF-8\?B\?(.+)\?=$/.exec(header);
    assert.ok(match, header);
    assert.equal(Buffer.from(match[1], 'base64').toString('utf8'), 'Νέα ρεκόρ στην ιστιοπλοΐα second line');
  } finally {
    await sink.close();
  }
});

test('the webhook gets one JSON body, { picks }, with the title, link, level and reason of each pick, and no fact', async () => {
  const sink = await startSink();
  try {
    await sendWebhook(`${sink.origin}/hook`, [pick()]);
    assert.equal(sink.requests[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(sink.requests[0].body), {
      picks: [{ title: 'Dutch rail strike ends', url: 'https://example.com/pick-a', level: 'high', reason: 'You follow Dutch transport.' }],
    });
    assert.doesNotMatch(sink.requests[0].body, /Utrecht/);
  } finally {
    await sink.close();
  }
});

test('a target that answers with an error makes the send fail, naming the status and nothing else', async () => {
  const sink = await startSink();
  sink.status = 503;
  try {
    await assert.rejects(sendNtfy(`${sink.origin}/secret-topic`, [pick()]), (e: Error) => /503/.test(e.message) && !/secret-topic|rail strike/.test(e.message));
    await assert.rejects(sendWebhook(`${sink.origin}/secret-hook`, [pick()]), (e: Error) => /503/.test(e.message) && !/secret-hook|rail strike/.test(e.message));
  } finally {
    await sink.close();
  }
});

test('notifiers that are not enabled send nothing, even when an address is written down', async () => {
  const sink = await startSink();
  const w = await world({ config: { notify: { ntfy: { enabled: false, url: `${sink.origin}/ntfy` }, webhook: { url: `${sink.origin}/hook` } } } });
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [{ id: 'urgent', relevance: 1.1 }]);
    assert.equal((await ok(pod, 'suggestions.get', { limit: 5 })).picks.length, 1);
    await settle();
    assert.deepEqual(sink.requests, []);
    assert.equal((await pod.ask('state')).notifiedSeq, 0);
    await pod.ask('stop');
  } finally {
    await w.close();
    await sink.close();
  }
});

test('enabled notifiers send each new emergency and high pick once, never a medium or low one, and not again after a restart', async () => {
  const sink = await startSink();
  const w = await world({ config: { notify: { ntfy: { enabled: true, url: `${sink.origin}/ntfy` }, webhook: { enabled: true, url: `${sink.origin}/hook` } } } });
  try {
    const first = startServicesPod(w.home);
    assert.deepEqual(await first.first, { ready: true });
    await first.ask('plant', [
      { id: 'low', relevance: 0.45, publishedHoursAgo: 4 },
      { id: 'medium', relevance: 0.65, publishedHoursAgo: 3 },
      { id: 'high', relevance: 0.85, publishedHoursAgo: 2, reason: 'Matters to you because of sailing.' },
      { id: 'urgent', relevance: 1.1, publishedHoursAgo: 1 },
    ]);
    await until(async () => (at(sink, '/ntfy').length >= 2 && at(sink, '/hook').length >= 1 ? 1 : 0), (n) => n === 1, 'both notifiers to be sent to');
    await settle();
    assert.equal(at(sink, '/ntfy').length, 2, 'one message each for the high and the emergency pick');
    assert.equal(at(sink, '/hook').length, 1);
    const sent = JSON.parse(at(sink, '/hook')[0].body).picks as PickView[];
    assert.deepEqual(sent.map((p) => [p.url, p.level]), [['https://example.com/high', 'high'], ['https://example.com/urgent', 'emergency']]);
    assert.equal(sent[0].reason, 'Matters to you because of sailing.');
    assert.equal(at(sink, '/ntfy')[0].body, 'https://example.com/high');
    assert.ok((await first.ask('state')).notifiedSeq >= 4, 'the position is saved after the send');

    // Reading the picks does not send them again, and neither does the next story at a lower level.
    await ok(first, 'suggestions.get', { limit: 10 });
    await first.ask('plant', [{ id: 'low2', relevance: 0.45 }]);
    await settle();
    assert.equal(sink.requests.length, 3);

    await first.ask('stop');
    assert.equal(await first.exited, 0);
    const second = startServicesPod(w.home);
    assert.deepEqual(await second.first, { ready: true });
    await settle();
    assert.equal(sink.requests.length, 3, 'a restart sends nothing again');
    await second.ask('plant', [{ id: 'later', relevance: 0.9 }]);
    await until(async () => at(sink, '/hook').length, (n) => n === 2, 'the new high pick to be sent');
    assert.deepEqual((JSON.parse(at(sink, '/hook')[1].body).picks as PickView[]).map((p) => p.url), ['https://example.com/later']);
    assert.equal(at(sink, '/ntfy').length, 3);
    await second.ask('stop');
  } finally {
    await w.close();
    await sink.close();
  }
});

test('a notifier that fails is logged without the pick, reading carries on, and the pick is sent on a later try', async () => {
  const sink = await startSink();
  sink.status = 500;
  const w = await world({ config: { notify: { webhook: { enabled: true, url: `${sink.origin}/hook-with-secret` } } } });
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [{ id: 'urgent', relevance: 1.1, title: 'Private headline words', reason: 'Private reason words.' }]);
    await until(async () => pod.logs.filter((l) => l.includes('notifier could not send')).length, (n) => n >= 1, 'the failure to be logged');
    assert.equal((await pod.ask('state')).notifiedSeq, 0, 'nothing is recorded as sent');
    assert.equal((await ok(pod, 'suggestions.get', { limit: 5 })).picks.length, 1, 'reading and the services go on');
    const lines = pod.logs.join('\n');
    assert.doesNotMatch(lines, /Private headline|Private reason|hook-with-secret|example\.com\/urgent/);

    // The server comes back; the next story that finishes sends the earlier pick too.
    sink.status = 200;
    await pod.ask('plant', [{ id: 'second', relevance: 0.9, publishedHoursAgo: 0.5 }]);
    await until(async () => sink.requests.filter((r) => r.body.includes('example.com/second')).length, (n) => n >= 1, 'the retry');
    const retried = JSON.parse(sink.requests.at(-1)!.body).picks as PickView[];
    assert.deepEqual(retried.map((p) => p.url), ['https://example.com/urgent', 'https://example.com/second']);
    assert.ok((await pod.ask('state')).notifiedSeq >= 2);
    await pod.ask('stop');
  } finally {
    await w.close();
    await sink.close();
  }
});

test('a notifier turned on for a pod with history sends none of the earlier picks, only new ones', async () => {
  const sink = await startSink();
  const w = await world();
  try {
    const before = startServicesPod(w.home);
    assert.deepEqual(await before.first, { ready: true });
    await before.ask('plant', [{ id: 'earlier', relevance: 1.1, publishedHoursAgo: 2 }, { id: 'before', relevance: 0.85, publishedHoursAgo: 1 }]);
    assert.equal((await ok(before, 'suggestions.get', { limit: 5 })).picks.length, 2);
    await before.ask('stop');
    assert.equal(await before.exited, 0);

    const podJson = path.join(w.home, 'pod.json');
    const cfg = JSON.parse(fs.readFileSync(podJson, 'utf8'));
    fs.writeFileSync(podJson, JSON.stringify({ ...cfg, notify: { webhook: { enabled: true, url: `${sink.origin}/hook` } } }));
    const after = startServicesPod(w.home);
    assert.deepEqual(await after.first, { ready: true });
    await settle();
    assert.deepEqual(sink.requests, [], 'the backlog is not sent');
    await after.ask('plant', [{ id: 'fresh', relevance: 0.9 }]);
    await until(async () => at(sink, '/hook').length, (n) => n === 1, 'the new pick to be sent');
    assert.deepEqual((JSON.parse(at(sink, '/hook')[0].body).picks as PickView[]).map((p) => p.url), ['https://example.com/fresh']);
    await after.ask('stop');
  } finally {
    await w.close();
    await sink.close();
  }
});

const APP = { meraNewsApp: { enabled: true, url: 'https://relay.example.org' } };

/** A plugin speaking 2 that records every notify event as one JSON line of the urls it carried. */
function listenerPlugin(w: { home: string }, extra = '') {
  const file = path.join(w.home, 'listen.js');
  const log = path.join(w.home, 'listen.log');
  fs.writeFileSync(
    file,
    `exports.podApi = 2; exports.name = 'listen';
exports.createPlugin = (ctx) => ({
  start: async () => {
    ${extra}
    ctx.services.events.on('notify', (picks) => require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(picks.map((p) => p.url)) + '\\n'));
  },
  stop: async () => {},
});`,
  );
  const podJson = path.join(w.home, 'pod.json');
  const cfg = JSON.parse(fs.readFileSync(podJson, 'utf8'));
  fs.writeFileSync(podJson, JSON.stringify({ ...cfg, plugins: [{ package: file }] }));
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
}
const u = (id: string) => `https://example.com/${id}`;

test('notify: the event carries exactly the important picks, without waiting for ntfy', async () => {
  const sink = await startSink();
  sink.hang = true;
  const w = await world({ config: { notify: { ntfy: { enabled: true, url: `${sink.origin}/ntfy` }, ...APP } } });
  const events = listenerPlugin(w);
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [{ id: 'medium', relevance: 0.65, publishedHoursAgo: 2 }, { id: 'high', relevance: 0.85, publishedHoursAgo: 1 }]);
    await until(async () => events().length, (n) => n >= 1, 'the event');
    assert.deepEqual(events(), [[u('high')]]);
    assert.equal(at(sink, '/ntfy').length, 1, 'ntfy was asked and is still waiting');
    await pod.ask('stop');
  } finally {
    await w.close();
    await sink.close();
  }
});

test('notify: an ntfy failure neither stops nor repeats the event', async () => {
  const sink = await startSink();
  sink.status = 500;
  const w = await world({ config: { notify: { ntfy: { enabled: true, url: `${sink.origin}/ntfy` }, ...APP } } });
  const events = listenerPlugin(w);
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [{ id: 'first', relevance: 0.85, publishedHoursAgo: 2 }]);
    await until(async () => events().length, (n) => n === 1, 'the first event');
    await until(async () => pod.logs.filter((l) => l.includes('notifier could not send')).length, (n) => n >= 1, 'the failure to be logged');
    assert.equal((await pod.ask('state')).notifiedSeq, 0);
    await settle();
    const failedSends = sink.requests.filter((r) => r.body === u('first')).length;
    sink.status = 200;
    await pod.ask('plant', [{ id: 'second', relevance: 0.85, publishedHoursAgo: 1 }]);
    await until(async () => (await pod.ask('state')).notifiedSeq, (n) => n >= 2, 'the position to advance');
    assert.deepEqual(events(), [[u('first')], [u('second')]]);
    assert.equal(sink.requests.filter((r) => r.body === u('first')).length, failedSends + 1, 'ntfy retried the first pick once more, after the failures');
    assert.equal(sink.requests.filter((r) => r.body === u('second')).length, 1);
    await pod.ask('stop');
  } finally {
    await w.close();
    await sink.close();
  }
});

test('notify: a listener that throws neither holds the position nor sends ntfy twice', async () => {
  const sink = await startSink();
  const w = await world({ config: { notify: { ntfy: { enabled: true, url: `${sink.origin}/ntfy` }, ...APP } } });
  const events = listenerPlugin(w, "ctx.services.events.on('notify', () => { throw new Error('x'); });");
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [{ id: 'first', relevance: 0.85, publishedHoursAgo: 2 }]);
    await until(async () => (await pod.ask('state')).notifiedSeq, (n) => n >= 1, 'the position to advance');
    await pod.ask('plant', [{ id: 'second', relevance: 0.85, publishedHoursAgo: 1 }]);
    await until(async () => (await pod.ask('state')).notifiedSeq, (n) => n >= 2, 'the position to advance again');
    assert.deepEqual(sink.requests.map((r) => r.body), [u('first'), u('second')]);
    assert.deepEqual(events(), [[u('first')], [u('second')]]);
    await pod.ask('stop');
  } finally {
    await w.close();
    await sink.close();
  }
});

test('notify: no event when meraNewsApp is off', async () => {
  const sink = await startSink();
  const w = await world({ config: { notify: { ntfy: { enabled: true, url: `${sink.origin}/ntfy` } } } });
  const events = listenerPlugin(w);
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [{ id: 'high', relevance: 0.85 }]);
    await until(async () => at(sink, '/ntfy').length, (n) => n === 1, 'ntfy to be sent');
    await settle();
    assert.deepEqual(events(), []);
    await pod.ask('stop');
  } finally {
    await w.close();
    await sink.close();
  }
});

test('notify: with only meraNewsApp on, the loop arms and emits', async () => {
  const w = await world({ config: { notify: APP } });
  const events = listenerPlugin(w);
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [{ id: 'high', relevance: 0.85 }]);
    await until(async () => events().length, (n) => n === 1, 'the event');
    assert.deepEqual(events(), [[u('high')]]);
    assert.ok((await pod.ask('state')).notifiedSeq >= 1);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a 429 part way through a burst keeps the delivered count, and the webhook is a target of its own', async () => {
  const sink = await startSink();
  try {
    const picks = Array.from({ length: 5 }, (_, i) => pick({ id: `p${i}`, url: `https://example.com/p${i}` }));
    const cfg = { notify: { ntfy: { url: `${sink.origin}/t` }, webhook: { url: `${sink.origin}/w` } } } as never;
    const [ntfy, webhook] = createNotifier(cfg, 0);
    sink.tooManyAfter = 2;
    await assert.rejects(ntfy.send(picks), (e) => e instanceof PartialSendError && e.delivered === 2 && /429/.test(e.message));
    assert.equal(sink.requests.length, 3, 'two ntfy messages and a refused third, no more');
    await webhook.send(picks);
    assert.equal(JSON.parse(at(sink, '/w')[0].body).picks.length, 5, 'the webhook does not depend on what ntfy delivered');
  } finally {
    await sink.close();
  }
});

test('a failing ntfy does not hold the webhook back: it gets every pick, and ntfy sends its picks again later', async () => {
  const ntfySink = await startSink();
  ntfySink.status = 500;
  const hookSink = await startSink();
  const w = await world({ config: { notify: { ntfy: { enabled: true, url: `${ntfySink.origin}/ntfy` }, webhook: { enabled: true, url: `${hookSink.origin}/hook` } } } });
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [{ id: 'one', relevance: 0.85, publishedHoursAgo: 3 }, { id: 'two', relevance: 0.9, publishedHoursAgo: 2 }, { id: 'three', relevance: 1.1, publishedHoursAgo: 1 }]);
    const hooked = () => at(hookSink, '/hook').flatMap((r) => (JSON.parse(r.body).picks as PickView[]).map((p) => p.url));
    await until(async () => new Set(hooked()).size, (n) => n === 3, 'the webhook to get all three picks');
    assert.equal(new Set(hooked()).size, hooked().length, 'the webhook got no pick twice');
    assert.equal((await pod.ask('state')).notifiedSeq, 0, 'the saved position is the slowest target: ntfy delivered nothing');
    ntfySink.status = 200;
    await pod.ask('plant', [{ id: 'four', relevance: 0.9 }]);
    await until(async () => ntfySink.requests.filter((r) => r.body === u('three')).length, (n) => n >= 1, 'ntfy to deliver the earlier picks');
    assert.equal(hooked().filter((url) => url === u('one')).length, 1, 'the webhook did not repeat a delivered pick');
    await pod.ask('stop');
  } finally {
    await w.close();
    await ntfySink.close();
    await hookSink.close();
  }
});

test('stop cancels a paced ntfy burst in flight: no pace timer is left', async () => {
  const sink = await startSink();
  const w = await world({ config: { notify: { ntfy: { enabled: true, url: `${sink.origin}/ntfy` } } } });
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [0, 1, 2, 3].map((i) => ({ id: `burst${i}`, relevance: 0.9, publishedHoursAgo: 4 - i })));
    await until(async () => pod.ask('timerCount'), (n) => (n as number) >= 1, 'a pace timer to be waiting');
    const { before, after } = (await pod.ask('stopAndCountDelayedWrites')) as { before: number; after: number };
    assert.ok(before >= 1);
    assert.equal(after, 0, 'stop cleared the pace timer');
  } finally {
    await w.close();
    await sink.close();
  }
});

test('ntfy messages in a burst are spaced by the pace', async () => {
  const sink = await startSink();
  try {
    const picks = [pick({ id: 'a' }), pick({ id: 'b' }), pick({ id: 'c' })];
    const started = Date.now();
    await sendNtfy(`${sink.origin}/t`, picks, 120);
    assert.ok(Date.now() - started >= 220, 'two gaps of about 120 ms');
    assert.equal(sink.requests.length, 3);
  } finally {
    await sink.close();
  }
});
