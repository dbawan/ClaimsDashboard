import test from "node:test";
import assert from "node:assert/strict";
import { createIdempotencyStore, IdempotencyConflictError } from "./idempotencyStore.js";

test("idempotency store joins duplicate operations and rejects key reuse with different content", async () => {
  const store = createIdempotencyStore();
  let calls = 0;
  const operation = async () => {
    calls += 1;
    return { noteId: "note-1" };
  };

  const [first, second] = await Promise.all([
    store.run({ scope: "user:key", fingerprint: "claim:text" }, operation),
    store.run({ scope: "user:key", fingerprint: "claim:text" }, operation),
  ]);
  assert.deepEqual(first, { noteId: "note-1" });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  await assert.rejects(
    store.run({ scope: "user:key", fingerprint: "different" }, operation),
    IdempotencyConflictError,
  );
});

test("idempotency store retains uncertain write failures to block a blind retry", async () => {
  const store = createIdempotencyStore();
  let calls = 0;
  const uncertain = Object.assign(new Error("uncertain"), { retainIdempotency: true });
  const operation = async () => {
    calls += 1;
    throw uncertain;
  };

  await assert.rejects(store.run({ scope: "user:key", fingerprint: "same" }, operation), uncertain);
  await assert.rejects(store.run({ scope: "user:key", fingerprint: "same" }, operation), uncertain);
  assert.equal(calls, 1);
});
