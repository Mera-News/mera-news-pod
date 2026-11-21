// The pod against the data server's one-computer store, end to end: the store fetches fixture feeds
// from loopback with its test embedder and serves them; first-picks makes a pick from it, and a pod
// with no AI service answers search_news and latest_news through the mcp plugin. A recording proxy
// between the pod and the store checks that the store accepts every news document the pod sends.
// Runs only when MERA_LOCAL_STORE_CLI (the store's dist/cli.mjs) and MERA_MCP_PLUGIN (a built
// packages/mcp folder) are set; CI's local-store job sets both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const STORE = process.env.MERA_LOCAL_STORE_CLI;
const MCP = process.env.MERA_MCP_PLUGIN;
const ROOT = path.resolve(__dirname, '../..');
const POD_CLI = path.join(ROOT, 'build', 'cli.js');
const FACT = 'I live in Brightwater and follow its new electric buses.';
// The one document the public server does not answer, refused with its validation error.
const NOT_PUBLIC = new Set(['PublicationDisplayNames']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => Promise<boolean> | boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await ok()) return;
    } catch {
      // not yet
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const plainEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...extra };
  for (const k of ['NODE_OPTIONS', 'MERA_POD_DATA_API_KEY', 'MERA_POD_AI_API_KEY']) delete env[k];
  return env;
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

function rss(site: string, titles: string[]) {
  const items = titles
    .map((t, i) => `<item><title>${t}</title><link>https://${site}.example/a/${i}</link><guid>https://${site}.example/a/${i}</guid><description>${t}.</description><pubDate>${new Date(Date.now() - (i + 1) * 3_600_000).toUTCString()}</pubDate></item>`)
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${site}</title><link>https://${site}.example/</link><description>${site}</description>${items}</channel></rss>`;
}
const FEEDS: Record<string, string> = {
  '/a.xml': rss('brightwater-post', ['Brightwater starts electric buses on three routes', 'City council votes on the new harbour bridge']),
  '/b.xml': rss('valley-times', ['Electric buses arrive in the valley next spring', 'Farmers report a record apple harvest']),
};
const TITLES = Object.values(FEEDS).flatMap((x) => [...x.matchAll(/<item><title>([^<]+)<\/title>/g)].map((m) => m[1]));

interface Seen {
  names: string[];
  codes: string[];
}

test('the pod reads the one-computer store: first picks, the read tools, and every document it sends', { skip: !STORE || !MCP ? 'set MERA_LOCAL_STORE_CLI and MERA_MCP_PLUGIN' : false }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-local-store-'));
  const procs: ChildProcess[] = [];
  const servers: http.Server[] = [];
  const storeHome = path.join(work, 'store');
  const storeEnv = plainEnv({ MERA_NEWS_LOCAL_TEST_EMBEDDER: 'fake:768', MERA_NEWS_LOCAL_ALLOW_FAKE: '1' });
  const store = (...args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) =>
      execFile(process.execPath, [STORE!, ...args, '--home', storeHome, '--json'], { env: storeEnv, timeout: 180_000 }, (e, out) =>
        resolve({ code: e ? Number((e as { code?: unknown }).code ?? 1) : 0, out: String(out) }),
      ),
    );
  try {
    // Fixture feeds on loopback; the store refuses local addresses unless they are allowed by name.
    const feeds = http.createServer((req, res) => (FEEDS[req.url ?? ''] ? res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(FEEDS[req.url!]) : res.writeHead(404).end()));
    servers.push(feeds);
    await new Promise<void>((r) => feeds.listen(0, '127.0.0.1', r));
    const feedHost = `127.0.0.1:${(feeds.address() as AddressInfo).port}`;
    for (const args of [['config', 'set', 'contact', 'ci@example.org'], ['config', 'set', 'feeds.allowHosts', feedHost], ...Object.keys(FEEDS).map((f) => ['feeds', 'add', `http://${feedHost}${f}`])]) {
      const r = await store(...args);
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.out}`);
    }
    const ingest = await store('ingest');
    assert.equal(ingest.code, 0, ingest.out);

    const storePort = await freePort();
    const serve = spawn(process.execPath, [STORE!, 'serve', '--port', String(storePort), '--home', storeHome], { env: storeEnv, stdio: 'ignore' });
    procs.push(serve);
    const storeUrl = `http://127.0.0.1:${storePort}/graphql`;
    await until('the store to serve', async () => (await fetch(storeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"{ newsServerStatus { lastArticleAt } }"}' })).ok, 30_000);

    // Every request the pod sends passes through here: its operation names and the store's error codes.
    const seen: Seen = { names: [], codes: [] };
    const refusedNames: string[] = [];
    const proxy = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const upstream = await fetch(storeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const text = await upstream.text();
      try {
        const ops = ([] as { query?: string; operationName?: string }[]).concat(JSON.parse(body));
        const replies = ([] as { errors?: { extensions?: { code?: string } }[] }[]).concat(JSON.parse(text));
        ops.forEach((op, i) => {
          const name = op.operationName ?? /^\s*(?:query|mutation)\s+(\w+)/.exec(op.query ?? '')?.[1] ?? (op.query?.includes('__schema') ? 'introspection' : 'unnamed');
          seen.names.push(name);
          for (const e of replies[i]?.errors ?? []) {
            const code = e.extensions?.code ?? 'no_code';
            seen.codes.push(code);
            if (code === 'GRAPHQL_VALIDATION_FAILED' && !NOT_PUBLIC.has(name)) refusedNames.push(name);
          }
        });
      } catch {
        seen.codes.push('unparsable');
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }).end(text);
    });
    servers.push(proxy);
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const viaProxy = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    // 1. A pod with the fake model makes its first pick from the store.
    const picks = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'first-picks.mjs'), '--data-server', viaProxy, '--fact', FACT, '--timeout', '120'], { env: plainEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout!.on('data', (d) => (out += d));
      c.stderr!.on('data', (d) => (out += d));
      c.once('close', (code) => resolve({ code, out }));
    });
    assert.equal(picks.code, 0, picks.out);

    // 2. A pod with no AI service and no data key answers the read tools through the mcp plugin.
    const podHome = path.join(work, 'pod');
    const mcpPort = await freePort();
    fs.mkdirSync(podHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(podHome, 'pod.json'), JSON.stringify({ dataServer: { url: viaProxy }, language: 'en', plugins: [{ package: MCP, config: { port: mcpPort } }] }));
    const lines: string[] = [];
    const pod = spawn(process.execPath, [POD_CLI, 'start'], { env: plainEnv({ MERA_POD_HOME: podHome }), stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(pod);
    for (const s of [pod.stdout!, pod.stderr!]) s.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
    const tokenFile = path.join(podHome, 'data', 'plugins', 'mcp', 'token');
    await until('the pod and its mcp plugin', async () => fs.existsSync(tokenFile) && (await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST' })).status === 401, 60_000);

    const sdk = createRequire(path.join(MCP!, 'package.json'));
    const { Client, StreamableHTTPClientTransport } = sdk('@modelcontextprotocol/client') as any;
    const client = new Client({ name: 'contract', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}` } } }));
    const call = async (name: string, args: object = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
    try {
      const status = await call('get_status');
      assert.deepEqual(status.problems.map((p: { code: string }) => p.code), ['no_ai_service']);
      const found = await call('search_news', { query: 'electric buses' });
      assert.ok(found.results.some((r: { title: string }) => r.title === 'Brightwater starts electric buses on three routes'), JSON.stringify(found));
      const latest = await call('latest_news', { limit: 10 });
      assert.deepEqual(latest.results.map((r: { title: string }) => r.title).sort(), [...TITLES].sort());
      for (const r of [...found.results, ...latest.results]) assert.deepEqual(Object.keys(r).sort(), ['id', 'language', 'link', 'publishedAt', 'publisher', 'title']);
    } finally {
      await client.close();
    }

    // 3. The store accepted every document the pod sent, and answered the read tools' own queries.
    assert.deepEqual(refusedNames, [], `the store refused: ${refusedNames.join(', ')}`);
    for (const name of ['GetArticleIdsForPersona', 'GetArticlesForTopicsByIds', 'SearchNews', 'GetArticlesForCountry']) assert.ok(seen.names.includes(name), `${name} was sent`);
    assert.deepEqual(seen.codes.filter((c) => c === 'INTERNAL_SERVER_ERROR' || c === 'unparsable'), []);
    assert.deepEqual(lines.filter((l) => /blocked request to|ERR_MODULE_NOT_FOUND/.test(l)), []);
  } finally {
    for (const p of procs) p.kill('SIGTERM');
    await sleep(1000);
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    for (const s of servers) s.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
