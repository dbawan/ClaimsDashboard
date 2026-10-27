import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySessionStore } from "./sessionStore.js";

function sessionStore({ ttlMs = 1_000, maxSessions = 2 } = {}) {
  let now = 10_000;
  let sequence = 0;
  const store = new InMemorySessionStore({
    ttlMs,
    maxSessions,
    now: () => now,
    createId: () => `session-${++sequence}`,
  });
  return { store, advance: (milliseconds) => { now += milliseconds; } };
}

test("server sessions expose only an opaque identifier", () => {
  const { store } = sessionStore();
  const id = store.create({ idToken: "large-id-token", refreshToken: "large-refresh-token" });

  assert.equal(id, "session-1");
  assert.deepEqual(store.get(id), {
    idToken: "large-id-token",
    refreshToken: "large-refresh-token",
  });
});

test("server sessions expire and are removed", () => {
  const { store, advance } = sessionStore();
  const id = store.create({ idToken: "id-token" });

  advance(1_000);

  assert.equal(store.get(id), null);
  assert.equal(store.size, 0);
});

test("session refresh updates tokens without extending the fixed lifetime", () => {
  const { store, advance } = sessionStore();
  const id = store.create({ idToken: "old", refreshToken: "refresh" });

  advance(900);
  assert.equal(store.update(id, { idToken: "new", refreshToken: "refresh" }), true);
  assert.equal(store.get(id).idToken, "new");

  advance(100);
  assert.equal(store.get(id), null);
});

test("the oldest session is evicted when the configured capacity is reached", () => {
  const { store } = sessionStore({ maxSessions: 2 });
  const first = store.create({ idToken: "first" });
  const second = store.create({ idToken: "second" });
  const third = store.create({ idToken: "third" });

  assert.equal(store.get(first), null);
  assert.equal(store.get(second).idToken, "second");
  assert.equal(store.get(third).idToken, "third");
});
