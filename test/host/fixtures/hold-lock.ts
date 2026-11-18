// Takes the lock, says so, and holds it until the process ends. It also ends when the test that
// started it goes away (the IPC channel disconnects) or after a minute, so a failed run leaves no holder.
import { acquireLock } from '../../../src/host/lock';

process.on('disconnect', () => process.exit(0));
setTimeout(() => process.exit(0), 60_000);

try {
  // Kept reachable: a lock nothing refers to can be collected, and collecting it closes the
  // connection and drops the lock while this process still runs.
  (globalThis as { held?: unknown }).held = acquireLock(process.argv[2]);
  console.log('held');
} catch (error) {
  process.stdout.write(`refused: ${(error as Error).message}\n`, () => process.exit(0));
}
