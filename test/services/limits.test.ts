// What the pod says a data server lacks, from the server's own description of its queries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchLimits } from '../../src/services/status';
import { startFakeDataServer } from '../../src/testing';
import type { LoadedConfig } from '../../src/config';

const STATUS_TYPE = 'type NewsServerStatus { placesSeeded: Boolean! headlineEditionsBuilt: Boolean! }';
const serverWith = async (queries: string, places: { city: string; countryCode: string }[] = []) => {
  const schemaPath = path.join(mkdtempSync(path.join(tmpdir(), 'limits-')), 'schema.gql');
  writeFileSync(schemaPath, `${STATUS_TYPE} type Place { _id: ID! city: String! } type Query { ${queries} }`);
  return startFakeDataServer({ schemaPath, articles: [], topics: {}, places });
};
const infoOf = (graphqlUrl: string) => fetchLimits({ dataServer: { graphqlUrl } } as LoadedConfig);
const limitsOf = async (graphqlUrl: string) => (await infoOf(graphqlUrl)).limits;

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

test('a server whose status says places are not loaded reports that, not a missing place lookup', async () => {
  const queries = 'placeSearch(query: String!, limit: Int! = 8): [Place!]! newsServerStatus: NewsServerStatus! articlesForStories: Int clusterMembershipsForArticles: Int topHeadlinesForCountry(windowHours: Int): Int worldHeadlines: Int';
  const empty = await serverWith(queries);
  const seeded = await serverWith(queries, [{ city: 'Utrecht', countryCode: 'NL' }]);
  try {
    assert.deepEqual(await infoOf(empty.graphqlUrl), { limits: [], placesNotLoaded: true });
    assert.deepEqual(await infoOf(seeded.graphqlUrl), { limits: [], placesNotLoaded: false });
  } finally {
    await empty.close();
    await seeded.close();
  }
});
