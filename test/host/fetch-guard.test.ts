import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { guardedFetch, installGlobalFetch } from '../../src/host/fetch-guard';

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const originOf = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

const hits: string[] = [];
const servers: Promise<http.Server>[] = [];
const serve = (handler: http.RequestListener) => {
  const s = listen((req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    handler(req, res);
  });
  servers.push(s);
  return s;
};
after(async () => {
  for (const s of await Promise.all(servers)) s.close();
});

test('an allowed origin is reached', async () => {
  const s = await serve((_req, res) => res.end('ok'));
  const fetch = guardedFetch([originOf(s)]);
  assert.equal(await (await fetch(`${originOf(s)}/x`)).text(), 'ok');
});

test('another host and another port are refused before any request is made', async () => {
  const allowed = await serve((_req, res) => res.end('ok'));
  const other = await serve((_req, res) => res.end('other'));
  const logs: string[] = [];
  const fetch = guardedFetch([originOf(allowed)], (l) => logs.push(l));
  hits.length = 0;
  await assert.rejects(fetch(`${originOf(other)}/x`), { name: 'BlockedRequestError', message: `blocked request to ${originOf(other)}` });
  await assert.rejects(fetch(`${originOf(other)}/y`), { name: 'BlockedRequestError' });
  await assert.rejects(fetch('http://example.com/'), { name: 'BlockedRequestError' });
  await assert.rejects(fetch('https://127.0.0.1:' + new URL(originOf(allowed)).port + '/'), { name: 'BlockedRequestError' });
  assert.deepEqual(hits, []);
  assert.equal(logs.filter((l) => l.includes(originOf(other))).length, 1, 'logged once per origin');
});

test('a redirect is never followed, even to an allowed origin', async () => {
  const target = await serve((_req, res) => res.end('target'));
  const s = await serve((_req, res) => {
    res.writeHead(302, { location: `${originOf(target)}/landed` });
    res.end();
  });
  const fetch = guardedFetch([originOf(s), originOf(target)]);
  hits.length = 0;
  await assert.rejects(fetch(`${originOf(s)}/go`));
  assert.ok(!hits.some((h) => h.endsWith('/landed')));
  // A caller asking to follow redirects does not get them.
  await assert.rejects(fetch(`${originOf(s)}/go`, { redirect: 'follow' }));
  // A caller that asks for the redirect itself gets it unfollowed, so it can stop without retrying.
  const res = await fetch(`${originOf(s)}/go`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(!hits.some((h) => h.endsWith('/landed')));
});

test('a Request object and a URL object are checked the same way', async () => {
  const s = await serve((_req, res) => res.end('ok'));
  const fetch = guardedFetch([originOf(s)]);
  assert.equal(await (await fetch(new URL(`${originOf(s)}/a`))).text(), 'ok');
  assert.equal(await (await fetch(new Request(`${originOf(s)}/a`))).text(), 'ok');
  await assert.rejects(fetch(new Request('http://example.com/')), { name: 'BlockedRequestError' });
});

test('installed as the global fetch, it blocks other origins and still reaches allowed ones', async () => {
  const s = await serve((_req, res) => res.end('ok'));
  const real = globalThis.fetch;
  try {
    installGlobalFetch(guardedFetch([originOf(s)], () => {}));
    assert.equal(await (await globalThis.fetch(`${originOf(s)}/`)).text(), 'ok');
    await assert.rejects(globalThis.fetch('http://example.com/'), { name: 'BlockedRequestError' });
  } finally {
    globalThis.fetch = real;
  }
});
