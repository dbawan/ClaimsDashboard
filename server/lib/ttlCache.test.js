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
