import test from "node:test";
import assert from "node:assert/strict";
import {
  filterAndSortPatientClaims,
  patientClaimDateRange,
} from "./patientClaimListModel.js";

const claims = Object.freeze([
  Object.freeze({
    claimId: "100",
    serviceDate: "2026-01-02",
    procedureCodes: Object.freeze(["78815", "A9607"]),
    billed: 500,
    paid: 100,
  }),
  Object.freeze({
    claimId: "101",
    serviceDate: "2026-02-02",
    procedureCodes: Object.freeze(["J2405"]),
    billed: 200,
    paid: 175,
  }),
  Object.freeze({
    claimId: "102",
    serviceDate: "2026-03-02",
    procedureCodes: Object.freeze(["A9607"]),
    billed: 900,
    paid: 25,
  }),
]);

test("patient claims search partial numeric, A, and J codes before applying ordering", () => {
  assert.deepEqual(
    filterAndSortPatientClaims(claims, { procedureQuery: " a96 ", sortBy: "billed" })
      .map(({ claimId }) => claimId),
    ["102", "100"],
  );
  assert.deepEqual(
    filterAndSortPatientClaims(claims, { procedureQuery: "j24", sortBy: "paid" })
      .map(({ claimId }) => claimId),
    ["101"],
  );
  assert.deepEqual(
    filterAndSortPatientClaims(claims, { procedureQuery: "815" })
      .map(({ claimId }) => claimId),
    ["100"],
  );
  assert.deepEqual(
    filterAndSortPatientClaims(claims).map(({ claimId }) => claimId),
    ["102", "101", "100"],
  );
});

test("patient claim date presets create inclusive calendar ranges", () => {
  assert.deepEqual(
    patientClaimDateRange("30", { referenceDate: "2026-03-31" }),
    { startDate: "2026-03-02", endDate: "2026-03-31" },
  );
  assert.deepEqual(
    patientClaimDateRange("90", { referenceDate: "2026-03-31" }),
    { startDate: "2026-01-01", endDate: "2026-03-31" },
  );
  assert.deepEqual(
    patientClaimDateRange("custom", {
      customStartDate: "2025-10-15",
      customEndDate: "2025-12-20",
    }),
    { startDate: "2025-10-15", endDate: "2025-12-20" },
  );
});

test("patient claims filter by inclusive date of service and procedure code", () => {
  assert.deepEqual(
    filterAndSortPatientClaims(claims, {
      procedureQuery: "A9607",
      startDate: "2026-01-02",
      endDate: "2026-02-28",
    }).map(({ claimId }) => claimId),
    ["100"],
  );
  assert.deepEqual(
    filterAndSortPatientClaims(claims, {
      startDate: "2026-02-02",
      endDate: "2026-03-02",
    }).map(({ claimId }) => claimId),
    ["102", "101"],
  );
});
