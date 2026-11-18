import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from '../../src/host/lock';
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
    { spec: (w) => plugin(w, 'old', '', 'exports.podApi = 2;'), error: /^The plugin \.\/old\.js needs plugin API version 2, and this pod speaks version 1\.$/ },
    { spec: (w) => plugin(w, 'quiet', '', 'delete exports.podApi;'), error: /^The plugin \.\/quiet\.js does not say which plugin API it speaks\. Export podApi = 1 next to createPlugin\.$/ },
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
