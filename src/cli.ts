#!/usr/bin/env node
// The command line: init writes a starting config, check tries the two servers and the plugins,
// start runs the pod. Everything printed is for a person, so each problem is one sentence that
// says what to fix.
import './quiet-sqlite';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './boot';
import { ConfigError, loadConfig, podHome, type LoadedConfig } from './config';
import { installProcessHandlers } from './process';
import { loadPlugins, unavailableServices } from './plugins';
import { createServices } from './services';

const PROBE_TIMEOUT_MS = 15_000;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const USAGE = 'Usage: mera-news-pod init | check | start';

const oneLine = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0];

/** One request to each server. Returns one sentence per problem, none when both answer. */
export async function probe(cfg: LoadedConfig, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const problems: string[] = [];
  const host = (url: string) => new URL(url).host;

  try {
    const res = await fetchImpl(cfg.dataServer.graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.dataServer.apiKey ? { 'x-api-key': cfg.dataServer.apiKey } : {}) },
      body: JSON.stringify({ query: 'query RecentArticleCount { recentArticleCount }' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'error',
    });
    if (res.status === 401 || res.status === 403) problems.push(`The data server at ${host(cfg.dataServer.graphqlUrl)} refused the key. Set dataApiKey in secrets.json.`);
    else if (!res.ok) problems.push(`The data server at ${host(cfg.dataServer.graphqlUrl)} answered with an error (${res.status}). Check dataServer.url in pod.json.`);
  } catch {
    problems.push(`The data server at ${host(cfg.dataServer.graphqlUrl)} did not answer. Check dataServer.url in pod.json and that the server is running.`);
  }

  try {
    const res = await fetchImpl(`${cfg.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.ai.apiKey ? { authorization: `Bearer ${cfg.ai.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.ai.model, messages: [{ role: 'user', content: 'Say ok.' }], max_tokens: 4, stream: false }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'error',
    });
    if (res.status === 401 || res.status === 403) problems.push(`The model endpoint at ${host(cfg.ai.baseUrl)} refused the key. Set aiApiKey in secrets.json.`);
    else if (res.status === 404) problems.push(`The model endpoint at ${host(cfg.ai.baseUrl)} does not know the model ${cfg.ai.model}. Check ai.baseUrl and ai.model in pod.json.`);
    else if (!res.ok) problems.push(`The model endpoint at ${host(cfg.ai.baseUrl)} answered with an error (${res.status}). Check ai.baseUrl and ai.model in pod.json.`);
  } catch {
    problems.push(`The model endpoint at ${host(cfg.ai.baseUrl)} did not answer. Check ai.baseUrl in pod.json and that the model server is running.`);
  }
  return problems;
}

function init(home: string): number {
  const file = path.join(home, 'pod.json');
  if (fs.existsSync(file)) {
    console.error(`${file} already exists, so nothing was changed.`);
    return 1;
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale);
  const topic = `mera-${Array.from(randomBytes(24), (b) => BASE32[b % 32]).join('')}`;
  const template = {
    dataServer: { url: 'http://127.0.0.1:3002' },
    ai: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'your-model-name' },
    reading: { everyMinutes: 15 },
    language: locale.language,
    region: locale.region,
    notify: { ntfy: { enabled: false, url: `https://ntfy.sh/${topic}` } },
    plugins: [],
  };
  fs.writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
  const secrets = path.join(home, 'secrets.json');
  if (!fs.existsSync(secrets)) fs.writeFileSync(secrets, '{}\n', { mode: 0o600 });
  console.log(`Wrote ${file} and ${secrets}.`);
  console.log(`Set dataServer.url and ai.baseUrl, and put any keys in secrets.json. Language is ${locale.language}${locale.region ? ` and region is ${locale.region}` : ''}: change them in pod.json if they are wrong.`);
  return 0;
}

async function check(home: string): Promise<number> {
  const cfg = loadConfig(home);
  const problems = await probe(cfg);
  problems.forEach((line) => console.log(line));
  try {
    const plugins = await loadPlugins(cfg, { services: unavailableServices, write: (_l, line) => console.error(line), podRoot: path.resolve(__dirname, '..') });
    plugins.describe().forEach((line) => console.log(line));
  } catch (error) {
    problems.push(oneLine(error));
    console.log(oneLine(error));
  }
  if (problems.length === 0) console.log('Everything answered.');
  return problems.length === 0 ? 0 : 1;
}

async function start(home: string): Promise<number> {
  const cfg = loadConfig(home);
  const problems = await probe(cfg);
  if (problems.length) {
    problems.forEach((line) => console.error(line));
    return 1;
  }
  const pod = await boot({ home, createServices });
  installProcessHandlers({ log: (line) => console.error(pod.redact(line)), shutdown: pod.stop });
  console.log(`The pod is running and reads every ${pod.control.get().everyMinutes} minutes.${pod.control.get().paused ? ' Reading is paused.' : ''}`);
  return -1;
}

export async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  const home = podHome();
  try {
    if (command === 'init') return init(home);
    if (command === 'check') return await check(home);
    if (command === 'start') return await start(home);
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : oneLine(error));
    return 1;
  }
  console.error(USAGE);
  return 1;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    // -1 means the pod is running: the process stays up until a signal ends it.
    if (code >= 0) process.exit(code);
  });
}
