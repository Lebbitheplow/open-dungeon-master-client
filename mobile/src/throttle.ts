// Two small rate limiters for the bridge.
//
// createTransitionDebounce: the home feed refreshes when the world or the
// tunnel changes state. Those events come in bursts (a start announces
// "starting" then "running", and every start() call announces again even
// when nothing changed), and each refresh asks every saved host for its
// campaigns. Only a change to a settled state counts, and a burst of them
// becomes one trailing refresh.
//
// createShortCache: the plugin's status() walks the network interfaces on
// every call, and the native game screens ask for it once per HostClient.
// A second or two of memory is enough to fold those into one call.

const SETTLED = new Set(["running", "stopped", "error", "unavailable"]);

export interface TransitionDebounceDeps {
  delayMs: number;
  fire(): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export function createTransitionDebounce(deps: TransitionDebounceDeps): {
  // Reports a source's state; true when it will lead to a refresh.
  notice(source: string, state: string): boolean;
} {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const lastFired = new Map<string, string>();
  let timer: unknown = null;
  return {
    notice(source, state) {
      if (!SETTLED.has(state) || lastFired.get(source) === state) return false;
      lastFired.set(source, state);
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        deps.fire();
      }, deps.delayMs);
      return true;
    },
  };
}

export function createShortCache<T>(
  ttlMs: number,
  load: () => Promise<T>,
  now: () => number = () => Date.now(),
): { get(): Promise<T>; clear(): void } {
  let held: Promise<T> | null = null;
  let heldAt = 0;
  return {
    get() {
      if (held && now() - heldAt < ttlMs) return held;
      heldAt = now();
      const loading = load();
      held = loading;
      // A failure is not worth remembering.
      loading.catch(() => {
        if (held === loading) held = null;
      });
      return loading;
    },
    clear() {
      held = null;
    },
  };
}
