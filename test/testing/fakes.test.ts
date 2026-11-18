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

  it('serves the four operations from the real schema', async () => {
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

  it('rejects a document the real schema rejects', async () => {
    const res = await query(data, 'query($ids: [ID!]!){ articlesForStories(articleIds: $ids){ articles { _id } } }', { ids: ['a1'] });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).errors[0].extensions.code, 'GRAPHQL_VALIDATION_FAILED');
  });

  it('answers 501 for a real operation it does not serve', async () => {
    const res = await query(data, '{ allCountries }');
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

  it('lists only the origins that were contacted', () => {
    assert.deepEqual(recordedOrigins(data), [data.origin]);
  });
});
