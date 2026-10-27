export function createTtlCache({ ttlMs, maxEntries = 500, now = () => Date.now() }) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Cache TTL must be a positive number.");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Cache capacity must be a positive integer.");
  }

  const entries = new Map();
  const pending = new Map();

  return Object.freeze({
    async getOrLoad(key, load, onEvent = () => {}) {
      const currentTime = now();
      for (const [entryKey, entry] of entries) {
        if (entry.expiresAt <= currentTime) entries.delete(entryKey);
      }
      const cached = entries.get(key);
      if (cached && cached.expiresAt > currentTime) {
        // Keep frequently accessed entries without extending their freshness window.
        entries.delete(key);
        entries.set(key, cached);
        onEvent("cache:hit", {
          ageMs: currentTime - cached.createdAt,
          expiresInMs: cached.expiresAt - currentTime,
        });
        return cached.value;
      }
      if (cached) entries.delete(key);

      const inFlight = pending.get(key);
      if (inFlight) {
        onEvent("cache:join", {});
        return inFlight;
      }

      onEvent("cache:miss", { ttlMs });
      const promise = Promise.resolve()
        .then(load)
        .then((value) => {
          // A clear during an in-flight load must not restore an invalidated value.
          if (pending.get(key) !== promise) return value;
          const createdAt = now();
          while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
          entries.set(key, {
            value,
            createdAt,
            expiresAt: createdAt + ttlMs,
          });
          onEvent("cache:store", { ttlMs });
          return value;
        })
        .finally(() => {
          if (pending.get(key) === promise) pending.delete(key);
        });
      pending.set(key, promise);
      return promise;
    },

    clear() {
      entries.clear();
      pending.clear();
    },
  });
}
