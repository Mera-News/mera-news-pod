// Runs a paired phone's batch of named changes through the client's own registered writers, so a
// change made here is treated exactly like one made in the app. Arguments hold the person's facts:
// they are never logged, and an error names a code and a plain sentence only.
import type { Level } from '../host/telemetry';
import type { CommandResult, PodServices } from '../plugin-api';
import { PodError } from './ledger';

type Model = { id: string };
type Returns = { table: string; many?: boolean; path?: string };
type Registry = {
  COMMANDS: Record<string, (...args: unknown[]) => Promise<unknown>>;
  COMMAND_REGISTRY_VERSION: number;
};
const client = <T>(file: string) => require(`mera-news-client/dist/lib/${file}`) as T;

/** The caller runs another schema or command registry than the pod; `which` is the side that is older. */
export class VersionMismatch extends PodError {
  constructor(readonly which: 'phone' | 'pod') {
    super('version_mismatch', `The ${which} is older than the ${which === 'phone' ? 'pod' : 'phone'}. Both sides must run the same version to share data.`, `update the ${which}`);
  }
}

// A model does not survive JSON, so a writer that returns one declares it and it crosses as ids.
// An undeclared model makes JSON throw, and the command is reported as failed: the registry needs a
// `returns` entry for it.
function wire(name: string, value: unknown): unknown {
  const returns = client<{ commandReturns(name: string): Returns | undefined }>('sync/command').commandReturns(name);
  let shaped = value;
  if (returns?.many) shaped = { ids: (value as Model[]).map((m) => m.id) };
  else if (returns?.path) {
    const at = value as Record<string, Model | null>;
    shaped = { ...at, [returns.path]: at[returns.path] ? { id: at[returns.path]!.id } : at[returns.path] };
  } else if (returns) shaped = { id: (value as Model).id };
  const text = JSON.stringify(shaped);
  return text === undefined ? null : JSON.parse(text);
}

export function createCommands(log: (level: Level, line: string) => void, display: PodServices['display']): PodServices['commands'] {
  return {
    async run({ schemaVersion, registry: version, hashes, commands }) {
      const { COMMANDS, COMMAND_REGISTRY_VERSION } = client<Registry>('sync/commands');
      const { default: schema } = client<{ default: { version: number } }>('database/schema');
      // Refused before anything runs: a phone on another version would write rows this pod reads differently.
      for (const [theirs, ours] of [[schemaVersion, schema.version], [version, COMMAND_REGISTRY_VERSION]]) {
        if (theirs !== ours) throw new VersionMismatch(Number(theirs) < ours ? 'phone' : 'pod');
      }
      const results: CommandResult[] = [];
      let stopped = false;
      for (const { name, args } of commands) {
        if (stopped) {
          results.push({ error: { code: 'earlier_change_failed', message: 'An earlier change failed, so this one did not run.' } });
          continue;
        }
        if (!Object.hasOwn(COMMANDS, name)) {
          stopped = true;
          results.push({ error: { code: 'unknown_command', message: 'This pod does not know that command.' } });
          continue;
        }
        try {
          results.push({ ok: wire(name, await COMMANDS[name](...(args ?? []))) });
        } catch (error) {
          stopped = true;
          // Only an error that carries its own code is described by its own words: any other message can quote an argument.
          const code = (error as { code?: unknown }).code;
          const coded = typeof code === 'string';
          results.push({ error: { code: coded ? code : 'failed', message: coded ? (error as Error).message : 'The change could not be applied.' } });
          log('warning', `The command ${name} failed${coded ? ` with ${code}` : ''}.`);
        }
      }
      // The same snapshot `display.snapshot` serves, so the two can never differ.
      return { results, snapshot: await display.snapshot({ hashes: hashes ?? {}, peer: { schemaVersion, registry: version } }) };
    },
  };
}
