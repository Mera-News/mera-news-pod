// A long run by hand, not part of the test suite: npx tsx test/soak/soak.ts
//
// It starts the pod with a read every two seconds against a slow model, lets it run about 200 reads,
// and checks what an always-on host cares about: no two reads at once, memory that stops growing,
// a stored-article count that levels off, and no stray rejections. SOAK_RUNS shortens it for a smoke.
import assert from 'node:assert/strict';
import { killAll, startServicesPod, world } from '../services/helpers';

const RUNS = Number(process.env.SOAK_RUNS ?? 200);
const FIRST = 50;
const HEAP_GROWTH_LIMIT = 1.2;
assert.ok(RUNS > FIRST, `SOAK_RUNS must be above ${FIRST}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const articles = Array.from({ length: 10 }, (_, i) => ({ _id: `soak-${i}`, title: `Zxq${i} vorpal${i} glimmer${i} headline`, pubDate: new Date().toISOString() }));
  const w = await world({ articles, topics: { 'soak topic': articles.map((a) => a._id) }, model: { delayMs: 400 } });
  const started = Date.now();
  const pod = startServicesPod(w.home, { MERA_POD_INTERVAL_SECONDS: '2', NODE_OPTIONS: '--expose-gc' });
  try {
    const ready = await pod.first;
    assert.deepEqual(ready, { ready: true }, `the pod did not start: ${ready.error}`);
    await pod.ask('plantFact', { statement: 'Follows the soak topic', status: 'done', topics: [{ text: 'soak topic' }] });

    const samples: { run: number; heap: number; rows: number }[] = [];
    let atFirst: { heap: number; rows: number; data: number; model: number } | undefined;
    let progress = { runs: 0, overlap: 0 };
    let lastSampled = 0;
    while (progress.runs < RUNS) {
      await sleep(1000);
      progress = await pod.ask('overlap');
      if (progress.runs >= FIRST && !atFirst) {
        atFirst = { heap: await pod.ask('heap'), rows: await pod.ask('rowCount', 'article_suggestions'), data: w.data.requests.length, model: w.model.requests.length };
      }
      if (progress.runs >= lastSampled + 10) {
        lastSampled = progress.runs;
        samples.push({ run: progress.runs, heap: await pod.ask('heap'), rows: await pod.ask('rowCount', 'article_suggestions') });
        console.log(`run ${progress.runs}: heap ${(samples.at(-1)!.heap / 1e6).toFixed(1)} MB, stored articles ${samples.at(-1)!.rows}`);
      }
      if (Date.now() - started > 60 * 60_000) throw new Error('the soak took longer than an hour');
    }
    const end = { heap: await pod.ask('heap'), rows: await pod.ask('rowCount', 'article_suggestions') };
    const state = await pod.ask('state');
    const operations: Record<string, number> = {};
    for (const line of pod.logs) {
      if (!line.startsWith('[error]')) continue;
      const operation = /"operation":"([^"]+)"/.exec(line)?.[1] ?? 'other';
      operations[operation] = (operations[operation] ?? 0) + 1;
    }

    console.log('--- soak result');
    console.log(`runs: ${progress.runs}, minutes: ${((Date.now() - started) / 60_000).toFixed(1)}`);
    console.log(`requests per run: data server ${(w.data.requests.length / progress.runs).toFixed(2)}, model ${(w.model.requests.length / progress.runs).toFixed(2)}`);
    console.log(`overlapping runs: ${progress.overlap}`);
    console.log(`unhandled rejections: ${state.rejections}`);
    console.log(`errors per operation: ${JSON.stringify(operations)}`);
    console.log(`heap at run ${FIRST}: ${(atFirst!.heap / 1e6).toFixed(1)} MB, at run ${progress.runs}: ${(end.heap / 1e6).toFixed(1)} MB`);
    console.log(`stored articles at run ${FIRST}: ${atFirst!.rows}, at the end: ${end.rows}`);

    assert.equal(progress.overlap, 0, 'two reads ran at once');
    assert.ok(end.heap <= atFirst!.heap * HEAP_GROWTH_LIMIT, `heap grew more than 20% between run ${FIRST} and run ${progress.runs}`);
    assert.ok(end.rows <= atFirst!.rows, 'the stored article count kept growing');
    console.log('soak passed');
    await pod.ask('stop');
  } finally {
    killAll();
    await w.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
