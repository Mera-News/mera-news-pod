// A plugin in plain JavaScript, so the pod that loads it runs with no loader at all. It speaks the
// newest contract: it adds one fact, listens for changes, runs one command the way a paired phone
// does, and writes what it saw to probe.json once a second.
const fs = require('node:fs');
const path = require('node:path');

exports.podApi = 2;
exports.name = 'probe';
exports.createPlugin = (ctx) => {
  const out = path.join(ctx.dataDir, 'probe.json');
  const seen = { changed: 0, command: null, factsAfterCommand: null, snapshotFacts: null };
  const write = (value) => fs.writeFileSync(out, JSON.stringify({ execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '', ...seen, ...value }));
  let timer;
  let off = () => {};
  const tick = async () => {
    try {
      const reply = await ctx.services.suggestions.get({ since: 'all', limit: 5 });
      const snapshot = await ctx.services.display.snapshot({});
      seen.snapshotFacts = (snapshot.tables.facts.rows ?? []).length;
      if (!seen.command) {
        // One command, with the versions a phone sends; the reply carries the tables after it.
        const done = await ctx.services.commands.run({
          schemaVersion: snapshot.schemaVersion,
          registry: snapshot.registry,
          commands: [{ name: 'addFact', args: ['Follows rowing'] }],
        });
        seen.command = done.results[0];
        seen.factsAfterCommand = (done.snapshot.tables.facts.rows ?? []).map((r) => r.statement).sort();
      }
      write({ state: reply.state, picks: reply.picks.map((p) => ({ title: p.title, reason: p.reason })) });
    } catch (error) {
      write({ error: String(error) });
    }
    timer = setTimeout(tick, 1000);
  };
  return {
    async start() {
      off = ctx.services.events.on('changed', () => {
        seen.changed += 1;
      });
      await ctx.services.profile.addFacts(['Follows sailing']);
      void tick();
    },
    async stop() {
      off();
      clearTimeout(timer);
    },
  };
};
