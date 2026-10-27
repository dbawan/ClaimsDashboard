export class IdempotencyConflictError extends Error {
  constructor() {
    super("That request identifier was already used for different content.");
    this.name = "IdempotencyConflictError";
    this.code = "IDEMPOTENCY_CONFLICT";
    this.statusCode = 409;
    this.expose = true;
  }
}

export function createIdempotencyStore({ ttlMs = 10 * 60 * 1_000, maxEntries = 2_000 } = {}) {
  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
  }

  return {
    async run({ scope, fingerprint }, operation) {
      const now = Date.now();
      prune(now);
      const existing = entries.get(scope);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
        return existing.promise;
      }

      const entry = {
        fingerprint,
        expiresAt: now + ttlMs,
        promise: Promise.resolve().then(operation),
      };
      entries.set(scope, entry);
      try {
        return await entry.promise;
      } catch (error) {
        if (!error?.retainIdempotency) entries.delete(scope);
        throw error;
      }
    },
  };
}
