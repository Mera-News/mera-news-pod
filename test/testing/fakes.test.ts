import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { defaultSchemaPath, recordedOrigins, startFakeDataServer, startFakeModel, type FakeDataServer, type FakeModel } from '../../src/testing/index';

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('fake model', () => {
  let model: FakeModel;
  before(async () => {
    model = await startFakeModel();
  });
  after(() => model.close());

  const ask = (messages: { role: string; content: string }[]) =>
    post(`${model.baseUrl}/chat/completions`, { model: 'm', messages }, { authorization: 'Bearer secret' }).then((r) => r.json() as Promise<any>);

  it('answers deterministically and records the request without credentials', async () => {
    const user = '===== Article 1 =====\n<<ARTICLE aaaaaaaaaaaa>>News Title: One<</ARTICLE aaaaaaaaaaaa>>\n===== Article 2 =====\n<<ARTICLE bbbbbbbbbbbb>>News Title: Two<</ARTICLE bbbbbbbbbbbb>>';
    const messages = [{ role: 'system', content: 'Score news relevance' }, { role: 'user', content: user }];
    const a = await ask(messages);
    const b = await ask(messages);
    const scores = JSON.parse(a.choices[0].message.content) as number[];
    assert.equal(scores.length, 2);
    assert.ok(scores.every((s) => s >= 0.05 && s <= 0.95));
    assert.deepEqual(a.choices[0].message.content, b.choices[0].message.content);
    assert.equal(model.bodies.length, 2);
    assert.equal(model.requests[0].headers.authorization, undefined);
  });

  it('answers reason, topic and other prompts', async () => {
    const reason = await ask([{ role: 'user', content: '<<ARTICLE cccccccccccc>>News Title: Rail strike\nRelated User Fact: Lives in Utrecht<</ARTICLE cccccccccccc>>' }]);
    assert.equal(reason.choices[0].message.content, 'Rail strike, which ties to Lives in Utrecht.');
    const topics = await ask([{ role: 'user', content: 'Fact: "Follows Formula 1 racing"' }]);
    assert.equal(JSON.parse(topics.choices[0].message.content).length, 3);
    assert.equal((await ask([{ role: 'user', content: 'hello' }])).choices[0].message.content, 'ok');
  });

  it('streams the same reply as server-sent events when asked to stream', async () => {
    const messages = [{ role: 'user', content: 'Fact: "Follows Formula 1 racing"' }];
    const whole = (await ask(messages)).choices[0].message.content as string;
    const res = await post(`${model.baseUrl}/chat/completions`, { model: 'm', messages, stream: true });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const lines = (await res.text()).split('\n').filter((l) => l.startsWith('data: '));
    assert.equal(lines.at(-1), 'data: [DONE]');
    const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)).choices[0]);
    assert.ok(chunks.length > 2, 'more than one delta');
    assert.equal(chunks.map((c) => c.delta.content ?? '').join(''), whole);
    assert.equal(chunks.at(-1).finish_reason, 'stop');
  });

  it('makes an unknown path visible', async () => {
    const res = await post(`${model.origin}/v1/other`, {});
    assert.equal(res.status, 404);
    assert.equal(model.requests.at(-1)?.path, '/v1/other');
  });
});

describe('fake data server', () => {
  let data: FakeDataServer;
  let keyed: FakeDataServer;
  const articles = [
    { _id: 'a1', title: 'One', country_code: 'NL' },
    { _id: 'a2', title: 'Two', country_code: 'US' },
  ];
  before(async () => {
    const base = { schemaPath: defaultSchemaPath(), articles, topics: { 'formula 1': ['a1', 'a2'] } };
    data = await startFakeDataServer(base);
    keyed = await startFakeDataServer({ ...base, apiKey: 'k' });
  });
  after(async () => {
    await data.close();
    await keyed.close();
  });

  const query = (server: FakeDataServer, q: string, variables?: unknown, headers?: Record<string, string>) =>
    post(server.graphqlUrl, { query: q, variables }, headers);

  it('serves the persona, hydrate, count and headline operations from the real schema', async () => {
    const persona = (await (await query(data, 'query($q: PersonaQueryInput!){ articleIdsForPersona(query: $q){ topicResults { topicText articleIds } headlineResults { scope articleIds } } }', {
      q: { limitPerTopic: 1, topics: [{ text: 'Formula  1' }], topHeadlines: { limitPerScope: 5, scopes: [{ scope: 'COUNTRY', countryCode: 'nl' }] } },
    })).json()) as any;
    assert.deepEqual(persona.data.articleIdsForPersona.topicResults, [{ topicText: 'Formula  1', articleIds: ['a1'] }]);
    assert.deepEqual(persona.data.articleIdsForPersona.headlineResults, [{ scope: 'COUNTRY', articleIds: ['a1'] }]);

    const hydrated = (await (await query(data, 'query($ids: [ID!]!){ articlesForTopicsByIds(articleIds: $ids){ dailyLimitReached articles { _id title_en clusters { clusterId } } } }', { ids: ['a2', 'zz'] })).json()) as any;
    assert.deepEqual(hydrated.data.articlesForTopicsByIds.articles.map((a: any) => a._id), ['a2']);

    const count = (await (await query(data, '{ recentArticleCount }')).json()) as any;
    assert.equal(count.data.recentArticleCount, 2);

    const top = (await (await query(data, '{ topHeadlinesForCountry(countryCode: "US", first: 5){ headlines { stableClusterId article { _id title } } pageInfo { hasNextPage } } }')).json()) as any;
    assert.equal(top.data.topHeadlinesForCountry.headlines[0].article._id, 'a2');
  });

  it('serves followed stories, cluster memberships, publishers and windowed headlines', async () => {
    const stories = (await (await query(data, 'query($ids: [ID!]!){ articlesForStories(articleIds: $ids){ dailyLimitReached articles { _id } } }', { ids: ['a1', 'zz'] })).json()) as any;
    assert.deepEqual(stories.data.articlesForStories, { dailyLimitReached: false, articles: [{ _id: 'a1' }] });

    const memberships = (await (await query(data, 'query($ids: [ID!]!){ clusterMembershipsForArticles(articleIds: $ids){ articleId clusters { stableClusterId } } }', { ids: ['a2', 'zz'] })).json()) as any;
    assert.deepEqual(memberships.data.clusterMembershipsForArticles, [{ articleId: 'a2', clusters: [{ stableClusterId: 'stable-a2' }] }]);

    const search = (await (await query(data, '{ searchPublishers(query: "pub a1"){ publishers { _id name matchingSources { feed_url last_fetch_error } } } }')).json()) as any;
    const [hit] = search.data.searchPublishers.publishers;
    assert.equal(hit.name, 'Pub a1');
    // As the public server sends them: an address is origin plus path, and no fetch error.
    assert.deepEqual(hit.matchingSources, [{ feed_url: 'https://example.com/feeds/pub-a1.xml', last_fetch_error: null }]);
    const sources = (await (await query(data, 'query($id: ID!){ publicationSourcesForNewsPublisher(publisherId: $id){ publicationSources { publication_name } } }', { id: hit._id })).json()) as any;
    assert.deepEqual(sources.data.publicationSourcesForNewsPublisher.publicationSources, [{ publication_name: 'Pub a1' }]);

    const windowed = (await (await query(data, '{ topHeadlinesForCountry(countryCode: "GLOBAL", windowHours: 6){ headlines { article { _id } } } }')).json()) as any;
    assert.equal(windowed.data.topHeadlinesForCountry.headlines.length, 2);
    const bad = (await (await query(data, '{ topHeadlinesForCountry(windowHours: 5){ headlines { stableClusterId } } }')).json()) as any;
    assert.equal(bad.errors[0].extensions.code, 'BAD_WINDOW');
  });

  it('groups articles that share a story_key into one story: one headline, pages by cursor, every report in the story', async () => {
    const server = await startFakeDataServer({
      schemaPath: defaultSchemaPath(),
      articles: [
        { _id: 's1', title: 'Storm one', story_key: 'storm', publication_name: 'Paper A' },
        { _id: 'x1', title: 'Alone' },
        { _id: 's2', title: 'Storm two', story_key: 'storm', publication_name: 'Paper B', language_code: 'nl' },
        { _id: 's3', title: 'Storm three', story_key: 'storm', publication_name: 'Paper C' },
      ],
      topics: { storms: ['s1', 'x1', 's3'] },
    });
    try {
      const top = (after?: string) =>
        query(server, 'query($a: String){ topHeadlinesForCountry(first: 1, after: $a){ headlines { clusterSize stableClusterId article { _id original_language_code publicationSource { publication_name } } } pageInfo { endCursor hasNextPage } } }', { a: after }).then((r) => r.json() as Promise<any>);
      const first = (await top()).data.topHeadlinesForCountry;
      assert.deepEqual(first.headlines, [{ clusterSize: 3, stableClusterId: 'stable-storm', article: { _id: 's1', original_language_code: 'en', publicationSource: { publication_name: 'Paper A' } } }]);
      assert.deepEqual(first.pageInfo, { endCursor: 's1', hasNextPage: true });
      const second = (await top('s1')).data.topHeadlinesForCountry;
      assert.deepEqual(second.headlines.map((h: any) => [h.clusterSize, h.stableClusterId, h.article._id]), [[1, 'stable-x1', 'x1']]);
      assert.equal(second.pageInfo.hasNextPage, false);
      assert.equal((await top('nope')).errors[0].extensions.code, 'BAD_USER_INPUT');

      const story = (after?: string) =>
        query(server, 'query($id: ID!, $a: String){ newsClusterForArticle(articleId: $id){ clusterSize articles(first: 2, after: $a){ articles { _id original_language_code publicationSource { publication_name } } pageInfo { endCursor hasNextPage } } } }', { id: 's2', a: after }).then((r) => r.json() as Promise<any>);
      const reports = (await story()).data.newsClusterForArticle;
      assert.equal(reports.clusterSize, 3);
      assert.deepEqual(reports.articles.articles.map((a: any) => [a._id, a.publicationSource.publication_name, a.original_language_code]), [['s1', 'Paper A', 'en'], ['s2', 'Paper B', 'nl']]);
      assert.deepEqual(reports.articles.pageInfo, { endCursor: 's2', hasNextPage: true });
      assert.deepEqual((await story('s2')).data.newsClusterForArticle.articles.articles.map((a: any) => a._id), ['s3']);
      const none = (await (await query(server, '{ newsClusterForArticle(articleId: "zz"){ _id } }')).json()) as any;
      assert.equal(none.data.newsClusterForArticle, null);

      const sizes = (await (await query(server, 'query($ids: [ID!]!){ articlesForTopicsByIds(articleIds: $ids){ articles { _id maxClusterSize } } }', { ids: ['s2', 'x1'] })).json()) as any;
      assert.deepEqual(sizes.data.articlesForTopicsByIds.articles, [{ _id: 's2', maxClusterSize: 3 }, { _id: 'x1', maxClusterSize: 1 }]);

      const memberships = (await (await query(server, 'query($ids: [ID!]!){ clusterMembershipsForArticles(articleIds: $ids){ articleId clusters { stableClusterId } } }', { ids: ['s1', 's3', 'x1'] })).json()) as any;
      assert.deepEqual(memberships.data.clusterMembershipsForArticles.map((m: any) => m.clusters[0].stableClusterId), ['stable-storm', 'stable-storm', 'stable-x1']);

      const persona = (await (await query(server, 'query($q: PersonaQueryInput!){ articleIdsForPersona(query: $q){ topicResults { matchMeta { articleId stableClusterId } } } }', { q: { limitPerTopic: 20, topics: [{ text: 'storms' }] } })).json()) as any;
      assert.deepEqual(persona.data.articleIdsForPersona.topicResults[0].matchMeta.map((m: any) => m.stableClusterId), ['stable-storm', 'stable-x1', 'stable-storm']);
    } finally {
      await server.close();
    }
  });

  it('searchNews finds planted articles by every query word, newest first, capped at 25', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ _id: `m${i}`, title: `Rail strike ${i}`, pubDate: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    const server = await startFakeDataServer({ schemaPath: defaultSchemaPath(), articles: [{ _id: 'x', title: 'Rail only' }, ...many], topics: {} });
    try {
      const q = (text: string, limit?: number) =>
        query(server, 'query($q: String!, $l: Int){ searchNews(query: $q, limit: $l){ _id title_en pubDate image_url score } }', { q: text, l: limit }).then((r) => r.json() as Promise<any>);
      const two = (await q('STRIKE  rail', 2)).data.searchNews;
      assert.deepEqual(two.map((h: any) => h._id), ['m29', 'm28']);
      assert.equal(two[0].score, 1 - 0 / 3);
      assert.ok(two[0].score > two[1].score);
      assert.equal(two[0].image_url, null);
      assert.equal((await q('rail', 99)).data.searchNews.length, 25);
      assert.equal((await q('rail')).data.searchNews.length, 10);
      assert.equal((await q('rail 3')).data.searchNews.length, 3);
      assert.deepEqual((await q('   ')).data.searchNews, []);
    } finally {
      await server.close();
    }
  });

  it('articlesForCountry pages newest first, filters by country, and refuses an unknown cursor', async () => {
    const planted = [
      { _id: 'n1', title: 'Old', country_code: 'NL', pubDate: '2026-01-01T00:00:00.000Z' },
      { _id: 'n2', title: 'New', country_code: 'NL', pubDate: '2026-01-03T00:00:00.000Z' },
      { _id: 'n3', title: 'Mid', country_code: 'NL', pubDate: '2026-01-02T00:00:00.000Z', language_code: 'nl' },
      { _id: 'u1', title: 'US', country_code: 'US', pubDate: '2026-01-05T00:00:00.000Z' },
    ];
    const server = await startFakeDataServer({ schemaPath: defaultSchemaPath(), articles: planted, topics: {} });
    try {
      const page = (v: unknown) =>
        query(server, 'query($c: String, $f: Int, $a: String){ articlesForCountry(countryCode: $c, first: $f, after: $a){ articles { _id title_en article_url pubDate original_language_code publicationSource { publication_name } } pageInfo { endCursor hasNextPage pageSize } } }', v).then((r) => r.json() as Promise<any>);
      const one = (await page({ c: 'nl', f: 2 })).data.articlesForCountry;
      assert.deepEqual(one.articles.map((a: any) => a._id), ['n2', 'n3']);
      assert.deepEqual(one.pageInfo, { endCursor: 'n3', hasNextPage: true, pageSize: 2 });
      assert.equal(one.articles[1].original_language_code, 'nl');
      assert.equal(one.articles[0].publicationSource.publication_name, 'Pub n2');
      const two = (await page({ c: 'NL', f: 2, a: 'n3' })).data.articlesForCountry;
      assert.deepEqual(two.articles.map((a: any) => a._id), ['n1']);
      assert.equal(two.pageInfo.hasNextPage, false);
      const all = (await page({})).data.articlesForCountry;
      assert.deepEqual(all.articles.map((a: any) => a._id), ['u1', 'n2', 'n3', 'n1']);
      assert.equal((await page({ c: 'GLOBAL' })).data.articlesForCountry.articles.length, 4);
      const bad = await page({ a: 'nope' });
      assert.equal(bad.errors[0].extensions.code, 'BAD_USER_INPUT');
    } finally {
      await server.close();
    }
  });

  it('allCountries lists the planted countries', async () => {
    const res = (await (await query(data, '{ allCountries }')).json()) as any;
    assert.deepEqual(res.data.allCountries, ['NL', 'US']);
  });

  it('searches places by prefix and says in its status whether any are loaded', async () => {
    const places = await startFakeDataServer({ schemaPath: defaultSchemaPath(), articles, topics: {}, places: [
      { city: 'Utrecht', countryCode: 'NL', population: 360000 },
      { city: 'Utica', countryCode: 'US', population: 60000 },
      { city: 'Amsterdam', countryCode: 'NL', population: 900000 },
    ] });
    try {
      const found = (await (await query(places, '{ placeSearch(query: "ut") { city countryCode } }')).json()) as any;
      assert.deepEqual(found.data.placeSearch, [{ city: 'Utrecht', countryCode: 'NL' }, { city: 'Utica', countryCode: 'US' }]);
      const short = (await (await query(places, '{ placeSearch(query: "u") { city } }')).json()) as any;
      assert.deepEqual(short.data.placeSearch, []);
      const status = (await (await query(places, '{ newsServerStatus { placesSeeded lastArticleAt lastClusteringAt vectorIndexState } }')).json()) as any;
      assert.equal(status.data.newsServerStatus.placesSeeded, true);
      assert.equal(status.data.newsServerStatus.lastClusteringAt, null);
      assert.equal(status.data.newsServerStatus.vectorIndexState, null);
      assert.ok(Date.parse(status.data.newsServerStatus.lastArticleAt) > 0);
    } finally {
      await places.close();
    }
    const unseeded = (await (await query(data, '{ newsServerStatus { placesSeeded } }')).json()) as any;
    assert.equal(unseeded.data.newsServerStatus.placesSeeded, false);
  });

  it('rejects a document the real schema rejects', async () => {
    const res = await query(data, 'query($ids: [ID!]!){ articlesForStories(articleIds: $ids){ nothingHere } }', { ids: ['a1'] });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).errors[0].extensions.code, 'GRAPHQL_VALIDATION_FAILED');
  });

  it('refuses a query over the public server\'s limits, and counts no introspection', async () => {
    const fields = (n: number) => Array.from({ length: n }, (_, i) => `f${i}: __typename`).join(' ');
    assert.equal((await query(data, `{ ${fields(1000)} }`)).status, 200);
    const res = await query(data, `{ ${fields(1001)} }`);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).errors[0].extensions.code, 'QUERY_TOO_COMPLEX');
    assert.equal((await query(data, `{ ${fields(1000)} __type(name: "Query") { name } }`)).status, 200);
  });


  it('answers 501 for a real operation it does not serve', async () => {
    const res = await query(data, '{ articleById(id: "a1") { _id } }');
    assert.equal(res.status, 501);
    assert.equal(((await res.json()) as any).errors[0].extensions.code, 'NOT_IMPLEMENTED');
  });

  it('makes an unknown path visible', async () => {
    const res = await post(`${data.origin}/elsewhere`, {});
    assert.equal(res.status, 404);
    assert.equal(data.requests.at(-1)?.path, '/elsewhere');
  });

  it('enforces the key only in keyed mode, and never records it', async () => {
    assert.equal((await query(keyed, '{ recentArticleCount }')).status, 401);
    assert.equal((await query(keyed, '{ recentArticleCount }', undefined, { 'x-api-key': 'wrong' })).status, 401);
    assert.equal((await query(keyed, '{ recentArticleCount }', undefined, { 'x-api-key': 'k' })).status, 200);
    assert.equal(keyed.requests.at(-1)?.headers['x-api-key'], undefined);
  });

  it('enforces the real caps and serves the new fields over 1000 articles', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      _id: `n${String(i).padStart(4, '0')}`,
      title: `Big story ${i}`,
      country_code: 'NL',
      pubDate: new Date(Date.now() - i * 1000).toISOString(),
      story_key: i < 3 ? 'one' : null,
      publication_name: `Pub ${i}`,
    }));
    const big = await startFakeDataServer({ schemaPath: defaultSchemaPath(), articles: many, topics: {} });
    try {
      const ask = async (q: string, variables?: unknown) => (await (await query(big, q, variables)).json()) as any;
      const ids = (n: number) => many.slice(0, n).map((a) => a._id);
      const byIds = 'query($ids: [ID!]!){ articlesForTopicsByIds(articleIds: $ids){ articles { _id } } }';
      assert.equal((await ask(byIds, { ids: ids(50) })).data.articlesForTopicsByIds.articles.length, 50);
      assert.equal((await ask(byIds, { ids: ids(51) })).errors[0].extensions.code, 'BAD_REQUEST');
      const members = 'query($ids: [ID!]!){ clusterMembershipsForArticles(articleIds: $ids){ articleId } }';
      assert.equal((await ask(members, { ids: ids(500) })).data.clusterMembershipsForArticles.length, 500);
      assert.equal((await ask(members, { ids: ids(501) })).errors[0].extensions.code, 'BAD_REQUEST');

      // Newest page max 50, with one cursor per article that continues right after it.
      const newest = await ask('{ articlesForCountry(countryCode: "NL", first: 500, order: NEWEST){ articles { _id } itemCursors } }').then((r) => r.data.articlesForCountry);
      assert.equal(newest.articles.length, 50);
      assert.deepEqual(newest.itemCursors, newest.articles.map((a: any) => a._id));

      // Search pages clamp at 100 and walk every hit once.
      const seen: string[] = [];
      let after: string | null = null;
      do {
        const page: any = (await ask('query($a: String){ searchNewsPage(query: "big story", limit: 5000, after: $a){ hits { _id } nextCursor } }', { a: after })).data.searchNewsPage;
        assert.ok(page.hits.length <= 100);
        seen.push(...page.hits.map((h: any) => h._id));
        after = page.nextCursor;
      } while (after);
      assert.equal(new Set(seen).size, 1000);

      // Headlines clamp first to 1..200; the story of three reports counts three publishers.
      const top = (first: number) => ask(`{ topHeadlinesForCountry(countryCode: "NL", first: ${first}, windowHours: 48){ headlines { cursor publisherCount } } }`).then((r) => r.data.topHeadlinesForCountry.headlines);
      assert.equal((await top(5000)).length, 200);
      assert.equal((await top(0)).length, 1);
      const [lead, single] = await top(2);
      assert.equal(lead.publisherCount, 3);
      assert.equal(single.publisherCount, 0);
      assert.equal(typeof lead.cursor, 'string');
    } finally {
      await big.close();
    }
  });

  it('lists only the origins that were contacted', () => {
    assert.deepEqual(recordedOrigins(data), [data.origin]);
  });
});
