// Saves the person's AI service: the address and model into pod.json, the key into secrets.json.
// The pod reads both only at boot, so a saved service runs from the next start. A live switch would
// have to change the fetch allowlist, the model transport, the job queue, the held job types and the
// logger's list of secrets together; a pod caught halfway could send the profile to an address it
// does not yet allow, or print a key it does not yet blank out.
import fs from 'node:fs';
import path from 'node:path';
import type { PodPaths } from '../config';
import type { PodServices } from '../plugin-api';
import { PodError } from './ledger';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
// Printable characters only, so a key cannot break a header or hide another value.
const KEY = /^[\x21-\x7e]{1,2000}$/;
const MODEL = /^[^\p{Cc}\p{Cf}]{1,200}$/u;

const bad = (message: string, next: string) => new PodError('bad_input', `${message} Nothing was saved.`, next);

function address(value: unknown): URL {
  const next = 'Use the address your AI service gives for OpenAI-compatible requests, such as https://api.example.com/v1.';
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw bad('The AI service address is not a web address.', next);
  }
  const local = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw bad('The AI service address must start with https://, or http:// for a service on this computer.', next);
  }
  if (url.username || url.password || url.search || url.hash) throw bad('The AI service address must not hold a name, password, query or #.', next);
  return url;
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path.basename(file)} is not a JSON object`);
  return value as Record<string, unknown>;
}

/** Written whole, by temp file and rename, readable only by this user. */
function writeJson(file: string, value: unknown) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

export function createAiService(paths: Pick<PodPaths, 'configFile' | 'secretsFile'>) {
  let saved: { host: string; model: string } | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const service: PodServices['aiService'] = {
    set(change) {
      const run = chain.then(() => {
        const url = address(change?.baseUrl);
        const model = typeof change?.model === 'string' ? change.model.trim() : '';
        if (!MODEL.test(model)) throw bad('The model name must be 1 to 200 characters on one line.', 'Use the model name your AI service lists.');
        const apiKey = change?.apiKey;
        if (apiKey !== undefined && (typeof apiKey !== 'string' || !KEY.test(apiKey))) {
          throw bad('The key must be 1 to 2000 characters with no spaces.', 'Paste the key your AI service gave you, or leave it out to keep the saved one.');
        }
        let config: Record<string, unknown>;
        let secrets: Record<string, unknown>;
        try {
          config = readJson(paths.configFile);
          secrets = readJson(paths.secretsFile);
        } catch {
          throw new PodError('config_unreadable', 'pod.json or secrets.json could not be read, so nothing was saved.', 'Fix or remove the file, then try again.');
        }
        const before = config.ai && typeof config.ai === 'object' ? (config.ai as Record<string, unknown>) : {};
        let sameOrigin = false;
        try {
          sameOrigin = new URL(String(before.baseUrl)).origin === url.origin;
        } catch {
          // no address saved before
        }
        const baseUrl = url.href.replace(/\/+$/, '');
        // The old key never goes with a new address, and is gone before the address changes, so a
        // failure between the two writes leaves no key rather than a key at the wrong service.
        if (apiKey !== undefined || !sameOrigin) {
          const { aiApiKey: _dropped, ...rest } = secrets;
          secrets = rest;
          writeJson(paths.secretsFile, secrets);
        }
        writeJson(paths.configFile, { ...config, ai: { ...before, baseUrl, model } });
        if (apiKey !== undefined) writeJson(paths.secretsFile, { ...secrets, aiApiKey: apiKey });
        saved = { host: url.host, model };
        return { set: true as const };
      });
      chain = run.catch(() => {});
      return run;
    },
  };
  return { service, saved: () => saved };
}
