// Saves a large ledger over and over until it is killed, for the test that kills it mid-write.
import { createLedger } from '../../../src/services/ledger';

const file = process.argv[2];
const ledger = createLedger(file);
const live = new Set<string>();

async function main() {
  for (let i = 0; i < 2000; i++) live.add(`seed-${i}`);
  await ledger.run((tx) => tx.register([...live].map((id) => [id]), live));
  process.stdout.write('ready\n');
  for (let i = 0; ; i++) {
    live.add(`more-${i}`);
    await ledger.run((tx) => tx.register([[`more-${i}`]], live));
  }
}
void main();
