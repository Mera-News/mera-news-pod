import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, killAll, ok, startServicesPod, until, world } from './helpers';

after(killAll);

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

test('followed stories: follow by text, grow with reads, fold copies, page, mark seen, remove an article and unfollow', async () => {
  const articles = [
    // Two reports of one story, in two languages other than the pod's, so the older one leads.
    { _id: 't1', title: 'Tramlijn Utrecht gaat eindelijk open', title_en: 'Utrecht tram line finally opens', language_code: 'nl', story_key: 'tram', pubDate: at(-120) },
    { _id: 't2', title: 'Utrecht oeffnet die neue Strassenbahnlinie', title_en: 'Utrecht opens its new tram line', language_code: 'de', story_key: 'tram', pubDate: at(-60) },
    // Published after the follow, so it counts as new.
    { _id: 't3', title: 'Tram line delays expected all week', pubDate: at(5) },
    // Not held by the pod and with no topic, so its snapshot has the English headline only.
    { _id: 'n1', title: 'Verpleegkundigen leggen het werk neer', title_en: 'Hospital nurses walk out over pay', language_code: 'nl' },
  ];
  const w = await world({ articles, topics: { 'utrecht tram line': ['t1', 't2', 't3'] } });
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });

    assert.equal((await call(pod, 'followed.follow', { text: '' })).error?.code, 'bad_input');
    assert.equal((await call(pod, 'followed.follow', { text: 'x'.repeat(81) })).error?.code, 'bad_input');
    assert.equal((await call(pod, 'followed.follow', { text: 'Utrecht tram line', label: ' ' })).error?.code, 'bad_input');
    assert.equal((await call(pod, 'followed.follow', { text: 'Utrecht tram line', label: 'x'.repeat(81) })).error?.code, 'bad_input');
    assert.deepEqual(await ok(pod, 'followed.list'), { stories: [] }, 'a refused follow saves nothing');

    const followed = await ok(pod, 'followed.follow', { text: 'Utrecht tram line' });
    assert.equal(followed.state, 'followed');
    assert.match(followed.hint, /grows each time Mera News reads the news/);
    assert.deepEqual(await ok(pod, 'followed.follow', { text: 'Utrecht tram line' }), { ...followed, state: 'already', hint: followed.hint.replace('Following this story.', 'This story was already followed.') });

    // The follow starts a read, and the read grows the story.
    const grown = await until(() => ok(pod, 'followed.list'), (r: any) => r.stories[0]?.articles === 3, 'the story to grow');
    const [story] = grown.stories;
    assert.deepEqual(
      { id: story.id, title: story.title, titleIsAi: story.titleIsAi, newCount: story.newCount, status: story.status, latest: story.latest?.id },
      { id: followed.id, title: 'Utrecht tram line', titleIsAi: true, newCount: 1, status: 'active', latest: 't3' },
      'the search keeps its case and only the article published after the follow is new',
    );
    assert.equal(story.latest.url, 'https://example.com/t3', 'the list row links its latest article');

    // Following from an article the pod does not hold seeds the story with it.
    const fromArticle = await ok(pod, 'followed.follow', { text: 'Nurse strikes', label: 'Nurses walk out', fromArticleId: 'n1' });
    assert.equal(fromArticle.state, 'followed');
    const nurses = (await ok(pod, 'followed.list')).stories.find((s: any) => s.id === fromArticle.id);
    assert.deepEqual([nurses.title, nurses.articles, nurses.latest?.id], ['Nurses walk out', 1, 'n1']);
    // A snapshot from before the original headline was kept has the English one only, so it is not labelled Dutch.
    await pod.ask('patchRow', { table: 'tracked_stories', id: fromArticle.id, raw: { member_snapshots_json: JSON.stringify([{ articleId: 'n1', title: 'Hospital nurses walk out over pay', pubDateMs: Date.now() - 60_000, languageCode: 'nl', publicationName: 'Pub n1' }]) } });
    const old = (await ok(pod, 'followed.list')).stories.find((s: any) => s.id === fromArticle.id).latest;
    assert.deepEqual([old.title, old.lang, old.titleEn], ['Hospital nurses walk out over pay', 'en', undefined]);
    assert.equal((await call(pod, 'followed.follow', { text: 'Anything', fromArticleId: 'gone' })).error?.code, 'unknown_article');
    // New articles first, then the most recently updated.
    assert.deepEqual((await ok(pod, 'followed.list')).stories.map((s: any) => [s.id, s.newCount]), [[followed.id, 1], [fromArticle.id, 0]]);

    // The link outlives the suggestion row through the kept row, whichever reason keeps it.
    await pod.ask('patchRow', { table: 'saved_article_suggestions', id: 't3', raw: { origin: 'fact_check' } });
    await pod.ask('patchRow', { id: 't3', raw: { created_at: Date.now() - 72 * 3600_000 } });

    const one = await ok(pod, 'followed.get', followed.id, { limit: 1 });
    assert.deepEqual(one.entries.map((e: any) => [e.head.id, e.copies]), [['t3', 0]]);
    assert.equal(one.entries[0].head.url, 'https://example.com/t3');
    assert.equal(one.more, true);
    const two = await ok(pod, 'followed.get', followed.id, { limit: 1, after: one.cursor });
    assert.deepEqual(two.entries.map((e: any) => [e.head.id, e.copies]), [['t1', 1]], 'two reports of one story are one entry');
    assert.deepEqual(
      { title: two.entries[0].head.title, titleEn: two.entries[0].head.titleEn, lang: two.entries[0].head.lang, url: two.entries[0].head.url },
      { title: 'Tramlijn Utrecht gaat eindelijk open', titleEn: 'Utrecht tram line finally opens', lang: 'nl', url: 'https://example.com/t1' },
    );
    assert.equal(two.cursor, null);
    assert.equal(two.more, false);
    assert.equal((await call(pod, 'followed.get', followed.id, { after: 'nonsense' })).error?.code, 'bad_input');
    assert.doesNotMatch(JSON.stringify(two), /Details of/, 'no article text');

    // Reading without markSeen leaves the shared new count; markSeen clears it after answering with it.
    assert.equal((await ok(pod, 'followed.list')).stories[0].newCount, 1);
    assert.equal((await ok(pod, 'followed.get', followed.id, { markSeen: true })).story.newCount, 1);
    assert.deepEqual((await ok(pod, 'followed.list')).stories.map((s: any) => [s.id, s.newCount]), [[fromArticle.id, 0], [followed.id, 0]]);

    // Removing one report takes the whole entry off for good, even after another read.
    assert.deepEqual(await ok(pod, 'followed.removeArticle', followed.id, 't2'), { removed: true });
    assert.equal((await call(pod, 'followed.removeArticle', followed.id, 'nope')).error?.code, 'unknown_article');
    // A read the follow started may still be going, so this one can answer busy; wait for both to end.
    await pod.ask('trigger');
    await until(() => pod.ask('readsRunning'), (r) => r === false, 'reads to finish');
    assert.deepEqual((await ok(pod, 'followed.get', followed.id)).entries.map((e: any) => e.head.id), ['t3']);

    const asked = w.data.requests.length;
    assert.deepEqual(await ok(pod, 'followed.unfollow', followed.id), { removed: true });
    assert.deepEqual((await ok(pod, 'followed.list')).stories.map((s: any) => s.id), [fromArticle.id]);
    assert.equal((await call(pod, 'followed.get', followed.id)).error?.code, 'unknown_story');
    assert.equal((await call(pod, 'followed.unfollow', followed.id)).error?.code, 'unknown_story');
    // Its search stops: the next read asks for the other story's search only.
    const searched = () => w.data.requests.slice(asked).filter((r: any) => r.body?.operationName === 'GetArticleIdsForPersona').flatMap((r: any) => r.body.variables.query.topics.map((t: any) => t.text));
    await until(async () => (await pod.ask('trigger'), searched()), (t) => t.length > 0, 'a read after the unfollow');
    assert.deepEqual([...new Set(searched())], ['Nurse strikes']);

    // Following from an article the pod holds, once; the same search again is the same story.
    await until(() => pod.ask('readsRunning'), (r) => r === false, 'reads to finish');
    const fromLocal = await ok(pod, 'followed.follow', { text: 'Utrecht tram opening', fromArticleId: 't1' });
    assert.equal(fromLocal.state, 'followed');
    const tram = (await ok(pod, 'followed.list')).stories.find((s: any) => s.id === fromLocal.id);
    assert.deepEqual([tram.latest.id, tram.latest.title], ['t1', 'Tramlijn Utrecht gaat eindelijk open']);
    assert.equal((await ok(pod, 'followed.follow', { text: 'Utrecht tram opening', fromArticleId: 't1' })).state, 'already');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('followed stories without an AI service: the follow is saved and the hint says it needs one to grow', async () => {
  const w = await world({ config: { ai: undefined } });
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const followed = await ok(pod, 'followed.follow', { text: 'Utrecht tram line' });
    assert.equal(followed.state, 'followed');
    assert.match(followed.hint, /reading needs an AI service/);
    assert.doesNotMatch(followed.hint, /—/);
    assert.deepEqual((await ok(pod, 'followed.list')).stories.map((s: any) => [s.id, s.articles, s.latest]), [[followed.id, 0, null]]);

    // Two follows of one search at once make one story.
    const both = await Promise.all([ok(pod, 'followed.follow', { text: 'Rent cap' }), ok(pod, 'followed.follow', { text: 'Rent cap' })]);
    assert.deepEqual(both.map((f: any) => f.state).sort(), ['already', 'followed']);
    assert.equal(both[0].id, both[1].id);
    // Persian keeps its zero-width non-joiner, as a topic does.
    assert.equal((await ok(pod, 'followed.follow', { text: '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 \u0645\u0633\u06a9\u0646' })).state, 'followed');
    assert.equal((await ok(pod, 'followed.list')).stories.length, 3);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});
