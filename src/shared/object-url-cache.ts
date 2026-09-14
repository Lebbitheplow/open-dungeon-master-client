// Object URLs for protected media (docs/vtt-parity-implementation-plan.md
// 18.3): each token-fetched path becomes a blob URL once, kept in a small
// least-recently-used ring so a crit sting is fetched once per session and
// a long evening does not hoard every picture it ever showed.

export interface ObjectUrlCache {
  get(key: string, load: () => Promise<string>): Promise<string>;
  size(): number;
  clear(): void;
}

export function createObjectUrlCache(cap: number, revoke: (url: string) => void): ObjectUrlCache {
  const entries = new Map<string, Promise<string>>();
  function touch(key: string, pending: Promise<string>) {
    // Re-inserting moves the key to the newest end of the map's order.
    entries.delete(key);
    entries.set(key, pending);
    while (entries.size > cap) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = entries.get(oldest);
      entries.delete(oldest);
      void evicted?.then((url) => {
        if (url) revoke(url);
      });
    }
  }
  return {
    get(key, load) {
      const known = entries.get(key);
      if (known) {
        touch(key, known);
        return known;
      }
      const pending = load().catch(() => "");
      touch(key, pending);
      void pending.then((url) => {
        // A failed fetch must not pin an empty answer; the next ask retries.
        if (!url && entries.get(key) === pending) entries.delete(key);
      });
      return pending;
    },
    size: () => entries.size,
    clear() {
      for (const pending of entries.values()) {
        void pending.then((url) => {
          if (url) revoke(url);
        });
      }
      entries.clear();
    },
  };
}
