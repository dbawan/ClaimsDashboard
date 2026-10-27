import test from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "./ttlCache.js";

test("TTL cache reuses successful values, coalesces loads, and expires entries", async () => {
  let currentTime = 1_000;
  let loadCount = 0;
  let releaseFirstLoad;
  const cache = createTtlCache({ ttlMs: 3_600_000, now: () => currentTime });
  const events = [];
  const load = () => {
    loadCount += 1;
    return new Promise((resolve) => {
      releaseFirstLoad = () => resolve({ version: loadCount });
    });
  };

  const first = cache.getOrLoad("queue", load, (stage) => events.push(stage));
  const joined = cache.getOrLoad("queue", load, (stage) => events.push(stage));
  await Promise.resolve();
  releaseFirstLoad();
  assert.deepEqual(await Promise.all([first, joined]), [{ version: 1 }, { version: 1 }]);
  assert.equal(loadCount, 1);

  assert.deepEqual(await cache.getOrLoad("queue", load, (stage) => events.push(stage)), { version: 1 });
  assert.equal(loadCount, 1);

  currentTime += 3_600_001;
  const expired = cache.getOrLoad("queue", load, (stage) => events.push(stage));
  await Promise.resolve();
  releaseFirstLoad();
  assert.deepEqual(await expired, { version: 2 });
  assert.equal(loadCount, 2);
  assert.deepEqual(events, ["cache:miss", "cache:join", "cache:store", "cache:hit", "cache:miss", "cache:store"]);
});

test("TTL cache does not retain failed loads", async () => {
  const cache = createTtlCache({ ttlMs: 3_600_000 });
  let loadCount = 0;
  const load = async () => {
    loadCount += 1;
    if (loadCount === 1) throw new Error("temporary failure");
    return "recovered";
  };

  await assert.rejects(cache.getOrLoad("queue", load), /temporary failure/);
  assert.equal(await cache.getOrLoad("queue", load), "recovered");
  assert.equal(loadCount, 2);
});

test("cache capacity evicts least recently used entries without extending expiry", async () => {
  let time = 0;
  let loads = 0;
  const cache = createTtlCache({ ttlMs: 100, maxEntries: 2, now: () => time });
  const load = () => ++loads;
  assert.equal(await cache.getOrLoad("a", load), 1);
  await cache.getOrLoad("b", load);
  time = 90;
  assert.equal(await cache.getOrLoad("a", load), 1);
  await cache.getOrLoad("c", load);
  assert.equal(await cache.getOrLoad("b", load), 4);
  time = 100;
  assert.equal(await cache.getOrLoad("c", load), 3);
  assert.equal(await cache.getOrLoad("a", load), 5);
});

test("clearing a cache prevents in-flight loads from repopulating it", async () => {
  const cache = createTtlCache({ ttlMs: 100 });
  let finishOld;
  let finishNew;
  const old = cache.getOrLoad("claim", () => new Promise((resolve) => { finishOld = resolve; }));
  await Promise.resolve();
  cache.clear();
  const fresh = cache.getOrLoad("claim", () => new Promise((resolve) => { finishNew = resolve; }));
  await Promise.resolve();
  finishOld("old");
  assert.equal(await old, "old");
  const joined = cache.getOrLoad("claim", () => { throw new Error("should share fresh load"); });
  finishNew("fresh");
  assert.deepEqual(await Promise.all([fresh, joined]), ["fresh", "fresh"]);
  assert.equal(await cache.getOrLoad("claim", () => "unexpected"), "fresh");
});
