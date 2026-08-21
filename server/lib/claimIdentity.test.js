import test from "node:test";
import assert from "node:assert/strict";
import {
  assertValidClaimSearch,
  encounterCandidateFromEraReference,
  moneyToCents,
  normalizeDate,
  normalizePatientName,
  submissionOrder,
  submissionSuffixForOrder,
  submissionSuffix,
} from "./claimIdentity.js";

test("ERA references belong only to the exact ENCOUNTERID letter family", () => {
  assert.equal(submissionSuffix("78820", "78820A"), "A");
  assert.equal(submissionSuffix("78820", "78820AA"), "AA");
  assert.equal(submissionSuffix("78820", "78820"), "");
  assert.equal(submissionSuffix("78820", "788200"), null);
  assert.equal(submissionSuffix("78820", "78820A1"), null);
  assert.equal(submissionSuffix("78820", "178820A"), null);
  assert.equal(encounterCandidateFromEraReference("78820D"), "78820");
  assert.equal(encounterCandidateFromEraReference("788200"), "");
});

test("submission suffixes have spreadsheet-style logical ordering", () => {
  assert.ok(submissionOrder("A") < submissionOrder("B"));
  assert.ok(submissionOrder("Z") < submissionOrder("AA"));
  assert.equal(submissionOrder(""), 0);
  assert.equal(submissionSuffixForOrder(0), "");
  assert.equal(submissionSuffixForOrder(1), "A");
  assert.equal(submissionSuffixForOrder(26), "Z");
  assert.equal(submissionSuffixForOrder(27), "AA");
});

test("patient name normalization is deterministic and not fuzzy", () => {
  assert.equal(normalizePatientName("Doe, Jane"), "JANEDOE");
  assert.equal(normalizePatientName("Jane Doe"), "JANEDOE");
  assert.notEqual(normalizePatientName("Jane Doe"), normalizePatientName("Janet Doe"));
});

test("claim search validation accepts operational identifiers and rejects SQL syntax", () => {
  assert.equal(assertValidClaimSearch(" 80751Z70886 "), "80751Z70886");
  assert.throws(() => assertValidClaimSearch("80751'; DROP TABLE claims"));
  assert.throws(() => assertValidClaimSearch(""));
});

test("date and money normalization preserve exact operational values", () => {
  assert.equal(normalizeDate("20260129"), "2026-01-29");
  assert.equal(normalizeDate("2026-01-29 12:30:00"), "2026-01-29");
  assert.equal(normalizeDate(new Date(2026, 0, 29, 12)), "2026-01-29");
  assert.equal(moneyToCents("-1,025.44"), -102544);
});
