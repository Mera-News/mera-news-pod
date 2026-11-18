// What a plugin may read to show the person's data: the same tables a phone is sent, as plain rows.
// A plugin gets this one function and never the database behind it.
import type { PodServices, Snapshot } from '../plugin-api';
import { PodError } from './ledger';

const client = <T>(file: string) => require(`mera-news-client/dist/lib/${file}`) as T;

const isHashes = (v: unknown): v is Record<string, string> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((h) => typeof h === 'string');
const isVersions = (v: unknown): v is { schemaVersion: number; registry: number } =>
  !!v && typeof v === 'object' && Number.isInteger((v as any).schemaVersion) && Number.isInteger((v as any).registry);

export function createDisplayService(): PodServices['display'] {
  return {
    versions() {
      return {
        schemaVersion: client<{ default: { version: number } }>('database/schema').default.version,
        registry: client<{ COMMAND_REGISTRY_VERSION: number }>('sync/command').COMMAND_REGISTRY_VERSION,
      };
    },
    async snapshot(options = {}) {
      const { hashes = {}, peer } = options;
      if (!isHashes(hashes)) throw new PodError('bad_request', 'hashes must map table names to hash strings.', 'pass the hashes you hold, or none');
      if (peer !== undefined && !isVersions(peer)) throw new PodError('bad_request', 'peer must hold whole-number schemaVersion and registry.', 'pass both versions, or omit peer');
      const { buildSnapshot } = client<{ buildSnapshot(o: { hashes: Record<string, string>; registry: number; peer?: object }): Promise<Snapshot> }>('sync/snapshot');
      const { COMMAND_REGISTRY_VERSION } = client<{ COMMAND_REGISTRY_VERSION: number }>('sync/command');
      const { SyncVersionError } = client<{ SyncVersionError: new (which: 'phone' | 'server') => Error & { which: 'phone' | 'server' } }>('sync/tables');
      try {
        return await buildSnapshot({ hashes, registry: COMMAND_REGISTRY_VERSION, peer });
      } catch (error) {
        if (!(error instanceof SyncVersionError)) throw error;
        // The pod is the server side, so `phone` is the caller.
        const older = error.which === 'phone' ? 'phone' : 'pod';
        throw new PodError(
          'version_mismatch',
          `The ${older} is older than the ${older === 'phone' ? 'pod' : 'phone'}. Both sides must run the same version to share data.`,
          `update the ${older}`,
        );
      }
    },
  };
}
