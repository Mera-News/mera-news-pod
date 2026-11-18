// What the pod says a data server lacks, from the server's own description of its queries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchLimits } from '../../src/services/status';
import { startFakeDataServer } from '../../src/testing';
import type { LoadedConfig } from '../../src/config';

const serverWith = async (queries: string) => {
  const schemaPath = path.join(mkdtempSync(path.join(tmpdir(), 'limits-')), 'schema.gql');
  writeFileSync(schemaPath, `type Query { ${queries} }`);
  return startFakeDataServer({ schemaPath, articles: [], topics: {} });
};
const limitsOf = (graphqlUrl: string) => fetchLimits({ dataServer: { graphqlUrl } } as LoadedConfig);

test('headlines without a time window count as missing windowed headlines', async () => {
  const old = await serverWith('topHeadlinesForCountry(first: Int): Int articlesForStories: Int clusterMembershipsForArticles: Int');
  const current = await serverWith('topHeadlinesForCountry(first: Int, windowHours: Int): Int articlesForStories: Int clusterMembershipsForArticles: Int');
  try {
    assert.deepEqual(await limitsOf(old.graphqlUrl), ['place lookup', 'windowed headlines', 'world headlines']);
    assert.deepEqual(await limitsOf(current.graphqlUrl), ['place lookup', 'world headlines']);
  } finally {
    await old.close();
    await current.close();
  }
});
