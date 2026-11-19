import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LoadedConfig } from '../../src/config';
import { acquireLock } from '../../src/host/lock';
import type { PodServices } from '../../src/plugin-api';
import { loadPlugins } from '../../src/plugins';
import { killAll, startPod, world, type World } from '../boot/helpers';

after(killAll);

/** A plugin that notes in a file what it is asked to do. `extra` runs inside the plugin factory. */
function plugin(w: World, name: string, extra = '', exports = '', start = `note('start ${name}')`) {
  fs.writeFileSync(
    path.join(w.home, `${name}.js`),
    `const fs = require('node:fs');
exports.podApi = 1;
exports.name = ${JSON.stringify(name)};
${exports}
exports.createPlugin = (ctx) => {
  const note = (line) => fs.appendFileSync(ctx.config.log, line + '\\n');
  ${extra}
  return {
    start: async () => { ${start}; },
    stop: async () => note('stop ${name}'),
    describe: () => ['${name} listens nowhere'],
  };
};
`,
  );
  return `./${name}.js`;
}
const withPlugins = async (build: (w: World, log: string) => { package: string; config?: object }[]) => {
  const w = await world();
  const log = path.join(w.home, 'plugin.log');
  const plugins = build(w, log).map((p) => ({ ...p, config: { log, ...p.config } }));
  fs.writeFileSync(path.join(w.home, 'pod.json'), JSON.stringify({ dataServer: { url: w.data.origin }, ai: { baseUrl: w.model.baseUrl, model: 'm' }, language: 'en', plugins }));
  return { w, log, read: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
};

test('plugins start in config order, get their context, and stop in reverse', async () => {
  const { w, read } = await withPlugins((w) => [
    { package: plugin(w, 'a', "note('ctx ' + JSON.stringify({ api: ctx.podApi, own: ctx.config.own, tokens: ctx.estimateTokens('abcdefgh'), dir: require('node:path').basename(ctx.dataDir), hasServices: typeof ctx.services.reading.set }));"), config: { own: 7 } },
    { package: plugin(w, 'b') },
  ]);
  try {
    const pod = startPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.deepEqual(read(), ['ctx {"api":1,"own":7,"tokens":2,"dir":"a","hasServices":"function"}', 'start a', 'start b']);
    assert.ok(fs.statSync(path.join(w.home, 'data', 'plugins', 'a')).isDirectory());
    await pod.ask('stop');
    assert.equal(await pod.exited, 0);
    assert.deepEqual(read().slice(3), ['stop b', 'stop a']);
  } finally {
    await w.close();
  }
});

test('a plugin that fails to start is named in one line, earlier plugins are stopped, and the exit code is not zero', async () => {
  const { w, read } = await withPlugins((w) => [
    { package: plugin(w, 'a') },
    { package: plugin(w, 'b', '', '', "throw new Error('port 9 is taken\\nmore detail')") },
  ]);
  try {
    const pod = startPod(w.home);
    assert.deepEqual(await pod.first, { error: 'The plugin ./b.js did not start: port 9 is taken' });
    assert.equal(await pod.exited, 1);
    // The plugin that failed is stopped too, in case it got part way.
    assert.deepEqual(read(), ['start a', 'stop b', 'stop a']);
    acquireLock(path.join(w.home, 'data', 'pod.lock.db')).release();
  } finally {
    await w.close();
  }
});

test('two plugins with the same name are refused, so they cannot share a data directory', async () => {
  const { w } = await withPlugins((w) => [{ package: plugin(w, 'one', '', "exports.name = 'same';") }, { package: plugin(w, 'two', '', "exports.name = 'same';") }]);
  try {
    const pod = startPod(w.home);
    assert.equal((await pod.first).error, 'The plugin ./two.js has the same name, same, as the plugin ./one.js. Each plugin needs its own name.');
    assert.equal(await pod.exited, 1);
  } finally {
    await w.close();
  }
});

test('a plugin that cannot be found, has no createPlugin, names another API version or none, or a name that is not a plain word is refused by name', async () => {
  const cases: { spec: (w: World) => string; error: RegExp }[] = [
    { spec: () => './missing.js', error: /^The plugin \.\/missing\.js was not found\./ },
    { spec: (w) => (fs.writeFileSync(path.join(w.home, 'empty.js'), 'exports.x = 1;'), './empty.js'), error: /^The plugin \.\/empty\.js does not export createPlugin\.$/ },
    { spec: (w) => plugin(w, 'old', '', 'exports.podApi = 3;'), error: /^The plugin \.\/old\.js needs plugin API version 3, and this pod speaks versions 1 and 2\.$/ },
    { spec: (w) => plugin(w, 'quiet', '', 'delete exports.podApi;'), error: /^The plugin \.\/quiet\.js does not say which plugin API it speaks\. Export podApi = 2 next to createPlugin\.$/ },
    { spec: (w) => plugin(w, 'escape', '', "exports.name = '../outside';"), error: /^The plugin \.\/escape\.js does not export a usable name\./ },
    { spec: (w) => plugin(w, 'scoped', '', "exports.name = '@scope/x';"), error: /^The plugin \.\/scoped\.js does not export a usable name\./ },
  ];
  for (const { spec, error } of cases) {
    const { w } = await withPlugins((w) => [{ package: spec(w) }]);
    try {
      const pod = startPod(w.home);
      const result = await pod.first;
      assert.match(result.error ?? '', error);
      assert.equal(await pod.exited, 1);
    } finally {
      await w.close();
    }
  }
});

// --- contract version 2 --------------------------------------------------------------------------

/** Loads plugin files straight through the plugin host with a counting stand-in for the services. */
const fn = async () => undefined;
async function hosted(files: Record<string, string>, meraNewsApp: string | null = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-plugins-'));
  const specs = Object.entries(files).map(([name, body]) => {
    const file = path.join(dir, `${name}.js`);
    fs.writeFileSync(file, body);
    return { package: file, config: {} };
  });
  const subs = { on: 0, off: 0, listeners: new Set<() => void>() };
  const services = {
    profile: { get: fn, addFacts: fn, removeFacts: fn, editTopics: fn },
    suggestions: { get: fn },
    reading: { status: fn, set: fn, readNow: fn },
    model: { chatCompletions: fn },
    news: { graphql: fn },
    commands: { run: fn },
    display: { snapshot: async () => ({}), versions: () => ({ schemaVersion: 0, registry: 0 }) },
    events: {
      on(_name: string, fn: () => void) {
        subs.on++;
        subs.listeners.add(fn);
        return () => { subs.off++; subs.listeners.delete(fn); };
      },
    },
  } as unknown as PodServices;
  const cfg = { plugins: specs, paths: { home: dir, pluginsDir: path.join(dir, 'plugins') }, notify: meraNewsApp ? { meraNewsApp: { origin: meraNewsApp } } : {} } as unknown as LoadedConfig;
  const lines: string[] = [];
  const plugins = await loadPlugins(cfg, { services, write: (_l, line) => lines.push(line), podRoot: dir });
  return { plugins, subs, lines, dir };
}
const body = (api: number, name: string, inside: string) => `exports.podApi = ${api}; exports.name = '${name}';
exports.createPlugin = (ctx) => { ${inside}
  return { start: async () => {}, stop: async () => { globalThis.__stopped = (globalThis.__stopped || []).concat('${name}'); } }; };`;

test('a plugin speaking 1 gets exactly the members it had, one speaking 2 gets every member', async () => {
  const members = "Object.fromEntries(Object.entries(ctx.services).map(([k, v]) => [k, Object.keys(v).sort()]))";
  const { plugins } = await hosted({
    one: body(1, 'one', `globalThis.__seen = { ...(globalThis.__seen || {}), one: [ctx.podApi, ${members}] };`),
    two: body(2, 'two', `globalThis.__seen = { ...(globalThis.__seen || {}), two: [ctx.podApi, ${members}] };`),
  });
  const seen = (globalThis as any).__seen;
  assert.deepEqual(seen.one, [1, {
    profile: ['addFacts', 'editTopics', 'get', 'removeFacts'],
    suggestions: ['get'],
    reading: ['set', 'status'],
    model: ['chatCompletions'],
    news: ['graphql'],
  }]);
  assert.deepEqual(seen.two, [2, {
    profile: ['addFacts', 'editTopics', 'get', 'removeFacts'],
    suggestions: ['get'],
    reading: ['readNow', 'set', 'status'],
    model: ['chatCompletions'],
    news: ['graphql'],
    commands: ['run'],
    display: ['snapshot', 'versions'],
    events: ['on'],
  }]);
  await plugins.stop();
});

test('plugins: a version 2 plugin sees meraNewsApp; a version 1 plugin does not', async () => {
  const { plugins } = await hosted({
    one: body(1, 'one', `globalThis.__app = { ...(globalThis.__app || {}), one: 'meraNewsApp' in ctx };`),
    two: body(2, 'two', `globalThis.__app = { ...(globalThis.__app || {}), two: ctx.meraNewsApp, gone: 'wakeRelay' in ctx };`),
  }, 'https://relay.example.org');
  assert.deepEqual((globalThis as any).__app, { one: false, two: 'https://relay.example.org', gone: false });
  await plugins.stop();
  const off = await hosted({ three: body(2, 'three', `globalThis.__appOff = ctx.meraNewsApp;`) });
  assert.equal((globalThis as any).__appOff, null);
  await off.plugins.stop();
});

test('a plugin speaking another version is refused with both versions the pod speaks', async () => {
  await assert.rejects(hosted({ three: body(3, 'three', '') }), /needs plugin API version 3, and this pod speaks versions 1 and 2\.$/);
});

test('stopping a plugin removes its change listeners and no other plugin\'s', async () => {
  const { plugins, subs } = await hosted({
    a: body(2, 'a', "ctx.services.events.on('changed', () => {}); ctx.services.events.on('changed', () => {});"),
    b: body(2, 'b', "ctx.services.events.on('changed', () => {});"),
  });
  await plugins.start();
  assert.deepEqual([subs.on, subs.off], [3, 0]);
  await plugins.stop();
  assert.deepEqual([subs.on, subs.off, subs.listeners.size], [3, 3, 0]);
});
