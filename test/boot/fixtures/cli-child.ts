// Runs the command line the way a person would, and ends if the test that started it goes away.
import { main } from '../../../src/cli';

process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
setTimeout(() => process.exit(0), 90_000).unref();
void main(process.argv.slice(2)).then((code) => {
  if (code >= 0) process.exit(code);
});
