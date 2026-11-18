import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire, builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { defaultSchemaPath, startFakeDataServer, startFakeModel } from '../../src/testing';

// The pod as a person runs it: the compiled build under plain `node`, with no loader. The rest of the
// suite runs the TypeScript source through tsx, which resolves imports plain Node refuses.
const ROOT = path.resolve(__dirname, '../..');
const BUILD = path.join(ROOT, 'build');
const PROBE = path.join(__dirname, 'fixtures', 'probe-plugin');

const running = new Set<ChildProcess>();
after(() => running.forEach((p) => p.kill('SIGKILL')));

// npm test builds first; building here would load the machine while the other files run.
before(() => {
  const newest = (dir: string): number =>
    Math.max(...fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).mtimeMs)));
  const cli = path.join(BUILD, 'cli.js');
  assert.ok(fs.existsSync(cli) && fs.statSync(cli).mtimeMs >= newest(path.join(ROOT, 'src')) - 1, 'the build is older than src: run npm run build');
});

const builtFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? builtFiles(full) : e.name.endsWith('.js') ? [full] : [];
  });

test('every require and import in the build resolves under plain Node, the lazy ones included', () => {
  const unresolved: string[] = [];
  let count = 0;
  for (const file of builtFiles(BUILD)) {
    const code = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');
    if (/\bimport\(/.test(code)) unresolved.push(`${path.relative(BUILD, file)}: a native import(), which resolves no extensions`);
    const from = createRequire(file);
    for (const [, , spec] of code.matchAll(/\brequire\((["'])([^"']+)\1\)/g)) {
      count++;
      if (builtinModules.includes(spec.replace(/^node:/, ''))) continue;
      try {
        from.resolve(spec);
      } catch {
        unresolved.push(`${path.relative(BUILD, file)}: require ${spec}`);
      }
    }
  }
  assert.deepEqual(unresolved, []);
  assert.ok(count > 50, `only ${count} requires found`);
});

test('the built pod, run with plain node, boots, reads, makes a pick with a reason, and serves a version 2 plugin', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-built-'));
  const ids = Array.from({ length: 8 }, (_, i) => `sail${i}`);
  const words = ['harbour', 'regatta', 'keel', 'mainsail', 'spinnaker', 'mooring', 'tiller', 'jib'];
  const data = await startFakeDataServer({
    schemaPath: defaultSchemaPath(),
    articles: ids.map((_id, i) => ({ _id, title: `${words[i]} report number ${i}` })),
    topics: { 'sailing latest': ids.slice(0, 6) },
    headlines: ids.slice(6),
  });
  const model = await startFakeModel();
  fs.writeFileSync(
    path.join(home, 'pod.json'),
    JSON.stringify({ dataServer: { url: data.origin }, ai: { baseUrl: model.baseUrl, model: 'm' }, language: 'en', plugins: [{ package: PROBE }] }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, MERA_POD_HOME: home, MERA_POD_INTERVAL_SECONDS: '2' };
  delete env.NODE_OPTIONS; // the test runner's loader must not reach the pod
  const pod = spawn(process.execPath, [path.join(BUILD, 'cli.js'), 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(pod);
  const output: string[] = [];
  pod.stdout!.on('data', (d: Buffer) => output.push(...d.toString().split('\n').filter(Boolean)));
  pod.stderr!.on('data', (d: Buffer) => output.push(...d.toString().split('\n').filter(Boolean)));
  const exited = new Promise<number | null>((r) => pod.once('exit', (code) => r(code)));
  const probeFile = path.join(home, 'data', 'plugins', 'probe', 'probe.json');
  try {
    let probe: any;
    const end = Date.now() + 90_000;
    while (Date.now() < end && pod.exitCode === null) {
      probe = fs.existsSync(probeFile) ? JSON.parse(fs.readFileSync(probeFile, 'utf8')) : undefined;
      if (probe?.picks?.length && probe.changed > 0 && probe.command) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const tail = `last pod lines:\n${output.slice(-15).join('\n')}`;
    assert.ok(probe?.picks?.length, `no pick within 90 s; probe ${JSON.stringify(probe)}; ${tail}`);
    assert.deepEqual([probe.execArgv, probe.nodeOptions], [[], ''], 'the pod ran with no loader');
    assert.ok(probe.picks.every((p: { reason: string }) => p.reason.length > 0), 'every pick has a reason');
    // The newest contract, through the built code: a snapshot, a phone's command, and the change event.
    assert.ok(probe.snapshotFacts > 0, `the snapshot serves the facts: ${JSON.stringify(probe)}`);
    assert.ok(probe.command && 'ok' in probe.command, `the command ran: ${JSON.stringify(probe.command)}`);
    assert.deepEqual(probe.factsAfterCommand, ['Follows rowing', 'Follows sailing']);
    assert.ok(probe.changed > 0, 'the plugin heard a change');
    assert.deepEqual(output.filter((l) => /ERR_MODULE_NOT_FOUND|Cannot find module|blocked request to/.test(l)), [], tail);
    assert.ok(output.some((l) => l === 'The pod is running and reads every 2 seconds (MERA_POD_INTERVAL_SECONDS).'), tail);
    pod.kill('SIGTERM');
    assert.equal(await exited, 0, tail);
  } finally {
    pod.kill('SIGKILL');
    await data.close();
    await model.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
