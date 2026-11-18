// Loads one client module before the pod boots, the mistake the boot guard exists to catch.
import { boot } from '../../../src/boot';

process.on('disconnect', () => process.exit(0));
setTimeout(() => process.exit(0), 60_000).unref();
require('mera-news-client/dist/lib/stores/database-store');
boot().then(
  () => process.send?.({ ready: true }),
  (error) => process.send?.({ error: error.message }, undefined, undefined, () => process.exit(1)),
);
