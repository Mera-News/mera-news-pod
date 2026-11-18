// Runs the pod in its own process so a test can start, stop and kill it. It answers commands from
// the test over the IPC channel, and it ends when that channel closes, as it does when the test dies.
import { boot, type Pod } from '../../../src/boot';
import { installProcessHandlers } from '../../../src/process';
import type { PodServices } from '../../../src/plugin-api';

const send = (message: unknown, done?: () => void) => process.send?.(message, undefined, undefined, () => done?.());
process.on('disconnect', () => process.exit(0));

const client = <T>(file: string) => require(`mera-news-client/dist/lib/${file}`) as T;
const noServices: PodServices = {
  profile: { get: async () => ({ facts: [] }), addFacts: async () => ({ added: [], already: [], refused: [] }), removeFacts: async () => ({ removed: [], notFound: [] }), editTopics: async () => ({ results: [] }) },
  suggestions: { get: async () => ({ state: 'ok', hint: '', nextReadAt: null, picks: [], cursor: '', more: false }) },
  reading: { status: async () => ({}) as never, set: async () => ({}) as never },
};

async function main() {
  let pod: Pod;
  try {
    pod = await boot({ createServices: () => ({ services: noServices }) });
  } catch (error) {
    send({ error: (error as Error).message }, () => process.exit(1));
    return;
  }
  const handlers = installProcessHandlers({
    log: (line) => send({ log: line }),
    shutdown: pod.stop,
    exit: (code) => send({ exit: code }, () => process.exit(code)),
  });
  send({ ready: true });

  process.on('message', async (msg: { id: number; cmd: string; arg?: unknown }) => {
    const reply = (value: unknown) => send({ id: msg.id, value });
    switch (msg.cmd) {
      case 'state': return reply({ ...pod.control.get(), reading: pod.control.readingState(), rejections: handlers.rejections() });
      case 'pause': pod.control.setPaused(true); return reply(null);
      case 'resume': pod.control.setPaused(false); return reply(null);
      case 'every':
        try {
          pod.control.setEvery(msg.arg as number);
          return reply(null);
        } catch (error) {
          return reply({ error: (error as Error).message });
        }
      case 'cycle': await pod.cycle(); return reply(null);
      case 'plant': { // a background job that calls the model, left in the queue as if from before a pause
        const { addFact } = client<{ addFact(s: string): Promise<{ id: string }> }>('database/services/fact-service');
        const { enqueueJob } = client<{ enqueueJob(t: string, p: object): Promise<string> }>('database/services/inference-job-service');
        await addFact('Lives in Utrecht');
        const id = await enqueueJob('persona_summary', { useCloud: true });
        client<{ inferenceQueue: { notify(): void } }>('inference/InferenceQueue').inferenceQueue.notify();
        return reply(id);
      }
      case 'job': {
        const { default: database } = client<{ default: { get(t: string): { find(id: string): Promise<{ status: string }> } } }>('database/index');
        return reply((await database.get('inference_jobs').find(msg.arg as string)).status);
      }
      case 'web': {
        const { useMeraProtocolStore } = client<{ useMeraProtocolStore: { getState(): { webSearchInChat: boolean } } }>('stores/mera-protocol-store');
        const { getSetting } = client<{ getSetting(k: string): Promise<string | null> }>('database/services/setting-service');
        return reply({ store: useMeraProtocolStore.getState().webSearchInChat, row: await getSetting('mera_web_search_in_chat') });
      }
      case 'trigger': return reply(await client<{ AppScheduler: { trigger(name: string): Promise<string> } }>('scheduler/AppScheduler').AppScheduler.trigger('feed-sync'));
      case 'frequency': return reply((client<{ AppScheduler: { tasks: Map<string, { frequency: number }> } }>('scheduler/AppScheduler').AppScheduler.tasks.get('feed-sync'))!.frequency);
      case 'hold': // makes the reading task look like it is mid-run, as it is during a real read
        client<{ useSchedulerStore: { getState(): { reserveTask(n: string): void; clearTaskReservation(n: string): void } } }>('scheduler/scheduler-store').useSchedulerStore.getState()[msg.arg ? 'reserveTask' : 'clearTaskReservation']('feed-sync');
        return reply(null);
      case 'reject': { const same = new Error('background failure'); void Promise.reject(same); void Promise.reject(same); void Promise.reject(new Error('another failure')); return reply(null); }
      case 'throw': setTimeout(() => { throw new Error('unexpected'); }, 0); return reply(null);
      case 'stop': await pod.stop(); return send({ id: msg.id, value: null }, () => process.exit(0));
    }
  });
}
void main();
