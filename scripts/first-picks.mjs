// Checks that a pod reading from a data server makes its first picks, against a fake model.
// Usage: node scripts/first-picks.mjs --data-server <url> [--api-key <key>] [--fact <text>] [--timeout <seconds>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'build', 'cli.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataServer = opt('data-server');
const fact = opt('fact') ?? 'Follows world news';
const timeoutSeconds = Number(opt('timeout') ?? 900);
const apiKey = opt('api-key') ?? process.env.MERA_POD_DATA_API_KEY;
if (!dataServer || !(timeoutSeconds > 0)) {
  console.error('Usage: node scripts/first-picks.mjs --data-server <url> [--api-key <key>] [--fact <text>] [--timeout <seconds>]');
  process.exit(2);
}
if (!fs.existsSync(cli)) {
  console.error('Run npm run build first.');
  process.exit(2);
}

// A plugin that adds the fact, then records the first pick and the reading state every two seconds.
const PROBE = `
const fs = require('node:fs');
exports.podApi = 2;
exports.name = 'probe';
exports.createPlugin = (ctx) => {
  const { fact, out } = ctx.config;
  let timer;
  const tick = async () => {
    let line;
    try {
      const reply = await ctx.services.suggestions.get({ since: 'all', limit: 1, peek: true });
      const status = await ctx.services.reading.status();
      line = { picks: reply.picks.length, state: reply.state, problems: status.problems.map((p) => p.code) };
    } catch (error) {
      line = { picks: 0, state: 'probe_error', problems: [] };
    }
    fs.appendFileSync(out, JSON.stringify(line) + '\\n');
    timer = setTimeout(tick, 2000);
  };
  return {
    async start() {
      await ctx.services.profile.addFacts([fact]);
      timer = setTimeout(tick, 2000);
    },
    async stop() {
      clearTimeout(timer);
    },
  };
};
`;

const { startFakeModel, defaultResponder } = createRequire(import.meta.url)('../build/testing/index.js');
const rating = (body) => {
  const user = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  return user.includes('===== Article ');
};
const responder = (body) => {
  const answer = defaultResponder(body);
  if (!rating(body)) return answer;
  try {
    const scores = JSON.parse(answer);
    if (Array.isArray(scores) && scores.every((s) => typeof s === 'number')) return JSON.stringify(scores.map(() => 0.9));
  } catch {
    // not a rating answer: leave it as it is
  }
  return answer;
};

const scrub = (text) => (apiKey ? text.split(apiKey).join('***') : text);
let model;
let home;
let pod;
let exited = false;
let lines = [];

const stopPod = async () => {
  if (!pod || exited) return;
  pod.kill('SIGTERM');
  await Promise.race([new Promise((r) => pod.once('exit', r)), wait(5000)]);
  if (!exited) {
    pod.kill('SIGKILL');
    await Promise.race([new Promise((r) => pod.once('exit', r)), wait(2000)]);
  }
};
const cleanup = async () => {
  await stopPod();
  await Promise.race([model?.close(), wait(2000)]);
  if (home) fs.rmSync(home, { recursive: true, force: true });
};

const lastProbe = () => {
  const text = fs.existsSync(path.join(home, 'probe.jsonl')) ? fs.readFileSync(path.join(home, 'probe.jsonl'), 'utf8') : '';
  return text.split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
};

async function main() {
  model = await startFakeModel({ responder });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'first-picks-'));
  fs.chmodSync(home, 0o700);
  const probeFile = path.join(home, 'probe.js');
  fs.writeFileSync(probeFile, PROBE);
  fs.writeFileSync(
    path.join(home, 'pod.json'),
    JSON.stringify({
      dataServer: { url: dataServer },
      ai: { baseUrl: model.baseUrl, model: 'fake' },
      language: 'en',
      plugins: [{ package: probeFile, config: { fact, out: path.join(home, 'probe.jsonl') } }],
    }),
  );
  const env = { ...process.env, MERA_POD_HOME: home, MERA_POD_INTERVAL_SECONDS: '10' };
  delete env.NODE_OPTIONS;
  delete env.MERA_POD_DATA_API_KEY;
  if (apiKey) env.MERA_POD_DATA_API_KEY = apiKey;
  pod = spawn(process.execPath, [cli, 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (d) => {
    lines.push(...d.toString().split('\n').filter(Boolean));
    lines = lines.slice(-40);
  };
  pod.stdout.on('data', keep);
  pod.stderr.on('data', keep);
  pod.once('exit', () => (exited = true));

  const started = Date.now();
  while (Date.now() - started < timeoutSeconds * 1000 && !exited) {
    await wait(1000);
    if (lastProbe().some((l) => l.picks > 0)) {
      console.log(`First picks after ${Math.round((Date.now() - started) / 1000)} s.`);
      return 0;
    }
  }
  const last = lastProbe().at(-1);
  console.log(`No first picks after ${Math.round((Date.now() - started) / 1000)} s${exited ? ' (the pod stopped early)' : ''}.`);
  console.log(`Last state: ${last?.state ?? 'none yet'}. Problems: ${last?.problems?.join(', ') || 'none'}.`);
  console.log(scrub(lines.join('\n')));
  return 1;
}

const finish = async (code) => {
  await cleanup();
  process.exit(code);
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(1));
main().then(finish, async (error) => {
  console.error(scrub(String(error?.message ?? error)));
  await finish(1);
});
