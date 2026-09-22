// Object URLs for protected media (docs/vtt-parity-implementation-plan.md
// 18.3): each token-fetched path becomes a blob URL once, kept in a
// least-recently-used ring bounded by a count and by bytes, so a crit sting
// is fetched once per session and a long evening does not hoard every
// picture it ever showed. Dropping an entry hands its URL to `retire`, which
// decides when it is safe to revoke (createRevokePool below).

export interface ObjectUrlEntry {
  url: string;
  bytes: number;
}

export interface ObjectUrlCache {
  get(key: string, load: () => Promise<string | ObjectUrlEntry>): Promise<string>;
  size(): number;
  bytes(): number;
  clear(): void;
}

export interface ObjectUrlCacheOptions {
  maxEntries: number;
  // No byte cap when omitted. A single blob over the cap still stays: the
  // ring is never emptied just to make room.
  maxBytes?: number;
  retire: (url: string) => void;
}

interface Slot {
  pending: Promise<string>;
  url: string;
  bytes: number;
}

export function createObjectUrlCache(options: ObjectUrlCacheOptions): ObjectUrlCache {
  const { maxEntries, maxBytes = Infinity, retire } = options;
  const entries = new Map<string, Slot>();
  let total = 0;

  function drop(key: string, slot: Slot): void {
    entries.delete(key);
    total -= slot.bytes;
    void slot.pending.then((url) => {
      if (url) retire(url);
    });
  }

  function trim(): void {
    for (const [key, slot] of entries) {
      if (entries.size <= maxEntries && total <= maxBytes) break;
      if (entries.size === 1) break;
      drop(key, slot);
    }
  }

  function touch(key: string, slot: Slot): void {
    // Re-inserting moves the key to the newest end of the map's order.
    entries.delete(key);
    entries.set(key, slot);
    trim();
  }

  return {
    get(key, load) {
      const known = entries.get(key);
      if (known) {
        touch(key, known);
        return known.pending;
      }
      const slot: Slot = { pending: Promise.resolve(""), url: "", bytes: 0 };
      slot.pending = load()
        .then((loaded) => (typeof loaded === "string" ? { url: loaded, bytes: 0 } : loaded))
        .catch(() => ({ url: "", bytes: 0 }))
        .then(({ url, bytes }) => {
          if (entries.get(key) !== slot) return url;
          // A failed fetch must not pin an empty answer; the next ask retries.
          if (!url) {
            entries.delete(key);
            return "";
          }
          slot.url = url;
          slot.bytes = bytes;
          total += bytes;
          trim();
          return url;
        });
      touch(key, slot);
      return slot.pending;
    },
    size: () => entries.size,
    bytes: () => total,
    clear() {
      for (const [key, slot] of entries) drop(key, slot);
    },
  };
}

// Revocation deferred until nothing shows the URL. An entry the ring drops
// may still be on an element (the table alone asks for more than a hundred
// pictures) or about to be handed to one; revoking it then left a broken
// portrait. Such URLs wait in a pending set that is swept on every later
// retirement and on a timer, and each is revoked once `inUse` says no.
export interface RevokePool {
  retire(url: string): void;
  // Revokes every pending URL no longer in use; returns how many still wait.
  sweep(): number;
  pending(): number;
  // Drops the timer and revokes whatever is not in use.
  dispose(): void;
}

export interface RevokePoolOptions {
  inUse: (url: string) => boolean;
  revoke: (url: string) => void;
  sweepMs?: number;
}

export function createRevokePool(options: RevokePoolOptions): RevokePool {
  const { inUse, revoke, sweepMs = 30_000 } = options;
  const waiting = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function sweep(): number {
    for (const url of waiting) {
      if (inUse(url)) continue;
      waiting.delete(url);
      revoke(url);
    }
    if (waiting.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    return waiting.size;
  }

  return {
    retire(url) {
      sweep();
      if (!inUse(url)) {
        revoke(url);
        return;
      }
      waiting.add(url);
      if (timer === null) {
        timer = setInterval(sweep, sweepMs);
        // Under Node (tests) the timer must not hold the process open.
        (timer as { unref?: () => void }).unref?.();
      }
    },
    sweep,
    pending: () => waiting.size,
    dispose() {
      sweep();
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
