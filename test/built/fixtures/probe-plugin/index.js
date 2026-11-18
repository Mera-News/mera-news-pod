// A plugin in plain JavaScript, so the pod that loads it runs with no loader at all. It adds one fact
// through the pod's services and writes what suggestions.get returns to probe.json once a second.
const fs = require('node:fs');
const path = require('node:path');

exports.podApi = 1;
exports.name = 'probe';
exports.createPlugin = (ctx) => {
  const out = path.join(ctx.dataDir, 'probe.json');
  const write = (value) => fs.writeFileSync(out, JSON.stringify({ execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '', ...value }));
  let timer;
  const tick = async () => {
    try {
      const reply = await ctx.services.suggestions.get({ since: 'all', limit: 5 });
      write({ state: reply.state, picks: reply.picks.map((p) => ({ title: p.title, reason: p.reason })) });
    } catch (error) {
      write({ error: String(error) });
    }
    timer = setTimeout(tick, 1000);
  };
  return {
    async start() {
      await ctx.services.profile.addFacts(['Follows sailing']);
      void tick();
    },
    async stop() {
      clearTimeout(timer);
    },
  };
};
