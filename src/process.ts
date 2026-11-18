// How the pod behaves as a process: a stray rejected promise is logged once and the pod goes on, an
// uncaught exception ends it, and a stop signal shuts it down in order.
import { createHash } from 'node:crypto';

export interface ProcessOptions {
  log(line: string): void;
  /** Stops plugins, the scheduler and the queue, then releases the lock. */
  shutdown(): Promise<void>;
  /** Replaceable so a test can see the code. Default: process.exit. */
  exit?: (code: number) => never | void;
}

export function installProcessHandlers(options: ProcessOptions) {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const seen = new Set<string>();
  let rejections = 0;
  let stopping: Promise<void> | undefined;

  const onRejection = (reason: unknown) => {
    rejections++;
    const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    const hash = createHash('sha1').update(text).digest('hex');
    if (seen.has(hash)) return;
    seen.add(hash);
    options.log(`A background task failed and the pod went on: ${text}`);
  };
  const onException = (error: Error) => {
    options.log(`The pod hit an unexpected error and is stopping: ${error.stack ?? error.message}`);
    exit(1);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    options.log(`Received ${signal}, stopping the pod.`);
    stopping = options.shutdown().then(
      () => exit(0),
      (error) => {
        options.log(`The pod could not stop cleanly: ${(error as Error).message}`);
        exit(1);
      },
    );
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    /** How many rejections were seen, repeats included. */
    rejections: () => rejections,
    remove() {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}
