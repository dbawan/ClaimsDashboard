import { randomBytes } from "node:crypto";

function defaultSessionId() {
  return randomBytes(32).toString("base64url");
}

export class InMemorySessionStore {
  #createId;
  #maxSessions;
  #now;
  #sessions = new Map();
  #ttlMs;

  constructor({
    ttlMs,
    maxSessions = 2_000,
    createId = defaultSessionId,
    now = Date.now,
  } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError("Session ttlMs must be a positive number");
    }
    if (!Number.isInteger(maxSessions) || maxSessions <= 0) {
      throw new TypeError("Session maxSessions must be a positive integer");
    }
    this.#ttlMs = ttlMs;
    this.#maxSessions = maxSessions;
    this.#createId = createId;
    this.#now = now;
  }

  #pruneExpired(now) {
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
  }

  create(value) {
    const now = this.#now();
    this.#pruneExpired(now);
    while (this.#sessions.size >= this.#maxSessions) {
      const oldestId = this.#sessions.keys().next().value;
      this.#sessions.delete(oldestId);
    }

    let id;
    do {
      id = String(this.#createId() || "");
    } while (!id || id.length > 128 || this.#sessions.has(id));

    this.#sessions.set(id, Object.freeze({
      value: Object.freeze({ ...value }),
      expiresAt: now + this.#ttlMs,
    }));
    return id;
  }

  get(id) {
    if (typeof id !== "string" || !id || id.length > 128) return null;
    const session = this.#sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.#now()) {
      this.#sessions.delete(id);
      return null;
    }
    return session.value;
  }

  update(id, value) {
    const session = this.#sessions.get(id);
    if (!session || session.expiresAt <= this.#now()) {
      this.#sessions.delete(id);
      return false;
    }
    this.#sessions.set(id, Object.freeze({
      value: Object.freeze({ ...value }),
      expiresAt: session.expiresAt,
    }));
    return true;
  }

  delete(id) {
    if (typeof id !== "string") return false;
    return this.#sessions.delete(id);
  }

  clear() {
    this.#sessions.clear();
  }

  get size() {
    return this.#sessions.size;
  }
}
