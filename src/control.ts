// What a person can change while the pod runs: reading on or off, and how often it reads. The
// choice lives in control.json so it survives a restart, and it is applied to the client's
// scheduler, which skips a paused task on every path that starts it.
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, MAX_EVERY_MINUTES, MIN_EVERY_MINUTES, type LoadedConfig } from './config';
import type { ReadingState } from './plugin-api';

export const READING_TASKS = ['feed-sync', 'inference-recover', 'persona-geo', 'persona-hygiene', 'sanity-backfill', 'feedback-cycle'] as const;
/** Every inference job type except a profile edit's own topic generation, which a pause leaves running. */
export const BACKGROUND_JOB_TYPES = ['persona_summary', 'story_headline', 'tracked_story_migrate', 'topic_combo'] as const;

export interface ControlFile {
  paused: boolean;
  everyMinutes: number;
  notifiedSeq: number;
  /** The pick history the notifier position belongs to; null while no notifier is on. */
  notifyEpoch: string | null;
}

// Each client module is typed here as the part this file calls, and loaded only when it is called,
// which is always after the host is registered.
type SchedulerApi = {
  pauseTask(name: string): void;
  resumeTask(name: string): void;
  configureTask(name: string, change: { frequency?: number; timeout?: number }): void;
};
const scheduler = () => (require('mera-news-client/dist/lib/scheduler/AppScheduler') as { AppScheduler: SchedulerApi }).AppScheduler;
const taskRunning = (name: string) =>
  (require('mera-news-client/dist/lib/scheduler/scheduler-store') as { useSchedulerStore: { getState(): { isRunning(name: string): boolean } } }).useSchedulerStore.getState().isRunning(name);
type QueueApi = { hold(types: readonly string[]): void; runningType(): string | null };
const queue = () => (require('mera-news-client/dist/lib/inference/InferenceQueue') as { inferenceQueue: QueueApi }).inferenceQueue;
const deviceProcessing = () =>
  (require('mera-news-client/dist/lib/stores/for-you-store') as { useForYouStore: { getState(): { isDeviceProcessing: boolean } } }).useForYouStore.getState().isDeviceProcessing;

function readFile(file: string): Partial<ControlFile> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(text) as Partial<ControlFile>;
  } catch {
    throw new ConfigError(`${file} is not valid JSON. Fix it or delete it.`);
  }
}

export function createControl(cfg: LoadedConfig, env: NodeJS.ProcessEnv = process.env) {
  const file = cfg.paths.controlFile;
  const saved = readFile(file);
  const state: ControlFile = { paused: false, everyMinutes: cfg.reading.everyMinutes, notifiedSeq: 0, notifyEpoch: null, ...saved };
  // The interval is kept here only once it was set through the services: until then pod.json's
  // reading.everyMinutes stays in charge, whatever else (a pause, a notifier) writes this file.
  let everyChosen = saved.everyMinutes !== undefined;
  // For tests only: the read interval in seconds, so a test need not wait minutes.
  const testSeconds = Number(env.MERA_POD_INTERVAL_SECONDS) || 0;

  const save = () => {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(everyChosen ? state : { ...state, everyMinutes: undefined }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  // A pause stops every read and every model call the pod starts on its own: the reading tasks and
  // the queued background jobs. A topic run for a fact the person just added still goes ahead.
  const applyPaused = () => {
    for (const name of READING_TASKS) (state.paused ? scheduler().pauseTask(name) : scheduler().resumeTask(name));
    queue().hold(state.paused ? BACKGROUND_JOB_TYPES : []);
  };
  const applyEvery = () => {
    const frequency = testSeconds ? testSeconds * 1000 : state.everyMinutes * 60_000;
    scheduler().configureTask('feed-sync', { frequency, timeout: cfg.reading.runTimeoutMs });
  };

  return {
    get: (): Readonly<ControlFile> => state,
    /** Puts the saved choice into effect. Boot calls it once the client's tasks are registered. */
    apply() {
      applyPaused();
      applyEvery();
    },
    setPaused(paused: boolean) {
      state.paused = paused;
      save();
      applyPaused();
    },
    setEvery(minutes: number) {
      if (!Number.isInteger(minutes) || minutes < MIN_EVERY_MINUTES || minutes > MAX_EVERY_MINUTES) {
        throw new Error(`everyMinutes must be a whole number between ${MIN_EVERY_MINUTES} and ${MAX_EVERY_MINUTES}.`);
      }
      state.everyMinutes = minutes;
      everyChosen = true;
      save();
      applyEvery();
    },
    setNotifiedSeq(seq: number) {
      state.notifiedSeq = seq;
      save();
    },
    /** Where a notifier starts: the history it belongs to and the last pick it counts as sent. */
    setNotifyPosition(epoch: string | null, seq: number) {
      state.notifyEpoch = epoch;
      state.notifiedSeq = seq;
      save();
    },
    /** 'pausing' while work that began before the pause is still finishing, then 'paused'. */
    readingState(): ReadingState {
      if (!state.paused) return 'on';
      const running = queue().runningType();
      const finishing =
        READING_TASKS.some((name) => taskRunning(name)) ||
        deviceProcessing() ||
        (running !== null && (BACKGROUND_JOB_TYPES as readonly string[]).includes(running));
      return finishing ? 'pausing' : 'paused';
    },
  };
}

export type Control = ReturnType<typeof createControl>;
