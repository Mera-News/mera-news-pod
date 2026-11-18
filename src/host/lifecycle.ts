// The app state the client watches to know when to run its background work. A server is always
// in the foreground, so the pod cycles through background and back on a timer to wake that work.
type State = 'active' | 'background';
type Listener = (state: State) => void;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function createLifecycle() {
  const listeners = new Set<Listener>();
  let timer: NodeJS.Timeout | undefined;

  const lifecycle = {
    currentState: 'active' as State,
    addEventListener(_type: 'change', listener: Listener) {
      listeners.add(listener);
      return { remove: () => void listeners.delete(listener) };
    },
    /** Goes to the background, then back to active on the next macrotask. Resolves once it is active again. */
    cycle(): Promise<void> {
      const set = (state: State) => {
        lifecycle.currentState = state;
        for (const listener of [...listeners]) listener(state);
      };
      set('background');
      return new Promise((resolve) =>
        setTimeout(() => {
          set('active');
          resolve();
        }, 0),
      );
    },
    startCycle(everyMs = SIX_HOURS_MS, isPaused: () => boolean = () => false) {
      lifecycle.stop();
      timer = setInterval(() => {
        if (!isPaused()) void lifecycle.cycle();
      }, everyMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return lifecycle;
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
