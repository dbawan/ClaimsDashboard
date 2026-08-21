import test from "node:test";
import assert from "node:assert/strict";
import { assertSelectOnly } from "./readOnlyPool.js";

test("read-only query guard permits one SELECT statement", () => {
  assert.doesNotThrow(() => assertSelectOnly("SELECT Claim835ID FROM claims WHERE Claim835ID = ?"));
  assert.doesNotThrow(() => assertSelectOnly(" SELECT 1; "));
});

test("read-only query guard rejects mutations and multiple statements", () => {
  for (const sql of [
    "UPDATE claims SET paid = 1",
    "INSERT INTO claims VALUES (1)",
    "DELETE FROM claims",
    "SELECT 1; DROP TABLE claims",
  ]) {
    assert.throws(() => assertSelectOnly(sql));
  }
});

