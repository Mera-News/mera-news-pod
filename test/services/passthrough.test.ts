import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LoadedConfig } from '../../src/config';
import { guardedFetch } from '../../src/host/fetch-guard';
import { createModelService } from '../../src/services/model';
import { createNewsService } from '../../src/services/news';
import { defaultSchemaPath, startFakeDataServer } from '../../src/testing';

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
const servers: http.Server[] = [];
const originOf = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void): Promise<{ origin: string; seen: Seen[]; server: http.Server }> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const entry: Seen = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null };
    seen.push(entry);
    handler(req, res, entry);
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ origin: originOf(server), seen, server })));
}
after(() => servers.forEach((s) => (s.closeAllConnections(), s.close())));

const MODEL_KEY = 'ai-key-secret';
const DATA_KEY = 'data-key-secret';
const cfgFor = (aiBase: string, graphqlUrl: string) =>
  ({ ai: { baseUrl: aiBase, model: 'configured-model', apiKey: MODEL_KEY, quirks: [] }, dataServer: { graphqlUrl, apiKey: DATA_KEY } }) as unknown as LoadedConfig;
const only = (...urls: string[]) => guardedFetch(urls.map((u) => new URL(u).origin), () => {});
const json = (res: http.ServerResponse, body: unknown) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));

// --- model ---------------------------------------------------------------------------------------

test('the model request goes to the configured endpoint with the configured model and key, whatever the caller sends', async () => {
  const up = await serve((_q, res) => json(res, { ok: true }));
  const model = createModelService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), only(up.origin));
  const reply = await model.chatCompletions(
    { model: 'caller-model', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, baseUrl: 'http://evil.example', apiKey: 'caller-key', headers: { authorization: 'Bearer caller' }, stream: false },
    new AbortController().signal,
  );
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { ok: true });
  const [got] = up.seen;
  assert.equal(got.url, '/v1/chat/completions');
  assert.equal(got.body.model, 'configured-model');
  assert.equal(got.headers.authorization, `Bearer ${MODEL_KEY}`);
  assert.deepEqual(Object.keys(got.body).sort(), ['messages', 'model', 'stream', 'temperature']);
});

test('an endpoint with the no-sampling quirk never gets temperature or top_p', async () => {
  const up = await serve((_q, res) => json(res, { ok: true }));
  const cfg = cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`);
  cfg.ai!.quirks = ['no-sampling'];
  const model = createModelService(cfg, only(up.origin));
  await model.chatCompletions({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, top_p: 0.9, max_tokens: 50 }, new AbortController().signal);
  assert.deepEqual(Object.keys(up.seen[0].body).sort(), ['max_tokens', 'messages', 'model']);
});

test('nothing from the caller is forwarded as a header', async () => {
  const up = await serve((_q, res) => json(res, {}));
  const model = createModelService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), only(up.origin));
  await model.chatCompletions({ messages: [], headers: { cookie: 'sid=1', authorization: 'Bearer caller' } }, new AbortController().signal);
  const names = Object.keys(up.seen[0].headers).filter((h) => h.startsWith('x-') || h === 'cookie');
  assert.deepEqual(names, []);
  assert.equal(up.seen[0].headers.cookie, undefined);
});

test('a tools field is refused and nothing is sent', async () => {
  const up = await serve((_q, res) => json(res, {}));
  const model = createModelService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), only(up.origin));
  await assert.rejects(model.chatCompletions({ messages: [], tools: [{}] }, new AbortController().signal), (e: any) => e.code === 'tools_not_allowed');
  assert.equal(up.seen.length, 0);
});

test('a body without messages is refused', async () => {
  const up = await serve((_q, res) => json(res, {}));
  const model = createModelService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), only(up.origin));
  await assert.rejects(model.chatCompletions({ prompt: 'x' }, new AbortController().signal), (e: any) => e.code === 'bad_request');
  assert.equal(up.seen.length, 0);
});

test('the reply streams: the first chunk arrives before the upstream finishes, and an abort ends the upstream request', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((r) => (upstreamClosed = r));
  const up = await serve((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    res.on('close', upstreamClosed);
    void gate.then(() => res.end('data: two\n\n'));
  });
  const model = createModelService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), only(up.origin));
  const abort = new AbortController();
  const reply = await model.chatCompletions({ messages: [], stream: true }, abort.signal);
  const reader = reply.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /data: one/);
  abort.abort();
  await assert.rejects(reader.read());
  await closed;
  release();
});

test('a redirect from the model endpoint is refused and the target gets nothing', async () => {
  const target = await serve((_q, res) => json(res, { reached: true }));
  const up = await serve((_q, res) => (res.writeHead(307, { location: `${target.origin}/v1/chat/completions` }), res.end()));
  const model = createModelService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), guardedFetch([up.origin, target.origin], () => {}));
  await assert.rejects(model.chatCompletions({ messages: [] }, new AbortController().signal));
  assert.equal(target.seen.length, 0);
});

test('the model request goes through the fetch it was given, so an origin outside the allowlist is blocked', async () => {
  const up = await serve((_q, res) => json(res, {}));
  const model = createModelService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), guardedFetch(['http://127.0.0.1:1'], () => {}));
  await assert.rejects(model.chatCompletions({ messages: [] }, new AbortController().signal), (e: any) => e.name === 'BlockedRequestError');
  assert.equal(up.seen.length, 0);
});

// --- news ----------------------------------------------------------------------------------------

const RECENT = { operationName: 'GetRecentArticleCount', query: 'query GetRecentArticleCount { recentArticleCount }' };

test("the allowlist is the client's: its news and the app's news pass, account and fact-check operations do not", async () => {
  const lists = require('mera-news-client/dist/lib/graphql/news-operations') as Record<string, readonly string[]>;
  const up = await serve((_q, res) => json(res, { data: {} }));
  const news = createNewsService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), only(up.origin));
  const ask = (name: string) => news.graphql({ operationName: name, query: `query ${name} { recentArticleCount }` }) as Promise<any>;
  for (const name of [...lists.NEWS_OPERATION_NAMES, ...lists.HOST_NEWS_OPERATION_NAMES]) assert.equal((await ask(name)).errors, undefined, name);
  for (const name of [...lists.ACCOUNT_OPERATION_NAMES, ...lists.MERA_SERVICE_OPERATION_NAMES]) assert.equal((await ask(name)).errors[0].extensions.code, 'NOT_ALLOWED', name);
  assert.equal(up.seen.length, lists.NEWS_OPERATION_NAMES.length + lists.HOST_NEWS_OPERATION_NAMES.length);
});

test('an allowed operation reaches the data server with the data key and no caller header', async () => {
  const up = await serve((_q, res) => json(res, { data: { recentArticleCount: 3 } }));
  const news = createNewsService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), only(up.origin));
  const reply = await news.graphql({ ...RECENT, extensions: { x: 1 }, headers: { cookie: 'sid' } });
  assert.deepEqual(reply, { data: { recentArticleCount: 3 } });
  const got = up.seen[0];
  assert.equal(got.url, '/graphql');
  assert.equal(got.headers['x-api-key'], DATA_KEY);
  assert.deepEqual(Object.keys(got.body).sort(), ['operationName', 'query']);
  const extra = Object.keys(got.headers).filter((h) => (h.startsWith('x-') && h !== 'x-api-key') || h === 'cookie' || h === 'authorization');
  assert.deepEqual(extra, []);
});

const refusals: [string, unknown][] = [
  ['an operation not on the list', { operationName: 'Nope', query: 'query Nope { recentArticleCount }' }],
  ['a mutation', { operationName: 'DeleteExpoPushToken', query: 'mutation DeleteExpoPushToken { x }' }],
  ['a mutation named like an allowed query', { operationName: 'GetRecentArticleCount', query: 'mutation GetRecentArticleCount { x }' }],
  ['an allowed name whose document holds another operation', { operationName: 'GetRecentArticleCount', query: `${RECENT.query} mutation Evil { x }` }],
  ['an anonymous operation', { query: '{ recentArticleCount }' }],
  ['a batch with one operation not allowed', [RECENT, { operationName: 'Nope', query: 'query Nope { recentArticleCount }' }]],
  ['a body that is not an operation', { hello: 1 }],
];
for (const [name, body] of refusals) {
  test(`${name} is refused with NOT_ALLOWED and never reaches the data server`, async () => {
    const up = await serve((_q, res) => json(res, { data: {} }));
    const news = createNewsService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), only(up.origin));
    const reply = (await news.graphql(body)) as any;
    const first = Array.isArray(reply) ? reply[0] : reply;
    assert.equal(first.errors[0].extensions.code, 'NOT_ALLOWED');
    assert.equal(up.seen.length, 0);
  });
}

test('an operation the data server does not serve comes back as its own validation error, not a failure', async () => {
  const fake = await startFakeDataServer({ schemaPath: defaultSchemaPath(), apiKey: DATA_KEY, articles: [], topics: {} });
  after(() => fake.close());
  const news = createNewsService(cfgFor(`${fake.origin}/v1`, fake.graphqlUrl), only(fake.origin));
  const reply = (await news.graphql({ operationName: 'GetWorldHeadlines', query: 'query GetWorldHeadlines { worldHeadlines { id } }' })) as any;
  assert.equal(reply.errors[0].extensions.code, 'GRAPHQL_VALIDATION_FAILED');
  const ok = (await news.graphql(RECENT)) as any;
  assert.equal(ok.data.recentArticleCount, 0);
});

test('a redirect from the data server is refused and the target gets nothing', async () => {
  const target = await serve((_q, res) => json(res, { data: {} }));
  const up = await serve((_q, res) => (res.writeHead(307, { location: `${target.origin}/graphql` }), res.end()));
  const news = createNewsService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), guardedFetch([up.origin, target.origin], () => {}));
  const reply = (await news.graphql(RECENT)) as any;
  assert.ok(reply.errors.length > 0);
  assert.equal(target.seen.length, 0);
});

test('the news request goes through the fetch it was given', async () => {
  const up = await serve((_q, res) => json(res, {}));
  const news = createNewsService(cfgFor(`${up.origin}/v1`, `${up.origin}/graphql`), guardedFetch(['http://127.0.0.1:1'], () => {}));
  const reply = (await news.graphql(RECENT)) as any;
  assert.ok(reply.errors.length > 0);
  assert.equal(up.seen.length, 0);
});
