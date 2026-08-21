export function createTtlCache({ ttlMs, now = () => Date.now() }) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Cache TTL must be a positive number.");
  }

  const entries = new Map();
  const pending = new Map();

  return Object.freeze({
    async getOrLoad(key, load, onEvent = () => {}) {
      const currentTime = now();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > currentTime) {
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
          const createdAt = now();
          entries.set(key, {
            value,
            createdAt,
            expiresAt: createdAt + ttlMs,
          });
          onEvent("cache:store", { ttlMs });
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, promise);
      return promise;
    },

    clear() {
      entries.clear();
    },
  });
}
