import test from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "../lib/ttlCache.js";
import { CLAIM_CACHE_TTL_MS, DATA_CACHE_TTL_MS } from "../lib/dataCache.js";
import { findPatientsByName, getClaimsForPatient } from "./patientSearchService.js";
import { getPatientClaimsByProcedure } from "./patientClaimLookupService.js";
import {
  getBaseClaimLifecycle,
  getCachedClaimLifecycle,
  getClaimLifecycle,
  invalidateClaimEnrichments,
} from "./claimLifecycleService.js";
import { filterClaimLifecycleByPermissions } from "../permissions/claimAccess.js";

const sixHours = 6 * 60 * 60 * 1_000;
const twentyFourHours = 24 * 60 * 60 * 1_000;
const runReadOnly = async (work) => work({ readOnly: true });
const sources = () => ({
  claimId: "80751", claimStatus: [], edi835: [], transactions: [{
    ENCOUNTERID: "80751", CLAIMTRANSACTIONID: "1", CLAIMTRANSACTIONTYPENAME: "Claim created",
    POSTINGDATE: "2026-09-01", DATEOFSERVICE: "2026-09-01", PROCEDURECODE: "99213", Charges: 200,
  }],
});

test("patient name searches share loads and expire exactly six hours after loading", async () => {
  let time = 0;
  let loads = 0;
  const options = {
    cache: createTtlCache({ ttlMs: DATA_CACHE_TTL_MS, now: () => time }),
    withReadOnlySession: runReadOnly,
    searchPatientsByName: async () => ({ version: ++loads }),
  };
  const results = await Promise.all([
    findPatientsByName(" Jane  Doe ", options), findPatientsByName("jane doe", options),
  ]);
  assert.deepEqual(results, [{ version: 1 }, { version: 1 }]);
  time = sixHours - 1;
  assert.equal((await findPatientsByName("Jane Doe", options)).version, 1);
  time = sixHours;
  assert.equal((await findPatientsByName("Jane Doe", options)).version, 2);
  assert.equal((await findPatientsByName("Janet Doe", options)).version, 3);
});

test("patient-list cache separates financial access and every search filter", async () => {
  let loads = 0;
  const options = {
    cache: createTtlCache({ ttlMs: DATA_CACHE_TTL_MS }),
    withReadOnlySession: runReadOnly,
    readPatientClaimSources: async (session, patientId) => {
      loads += 1;
      return { ...sources(), patient: { patientId }, total: 1,
        claimRows: [{ claimId: "80751" }] };
    },
  };
  const financial = await getClaimsForPatient("31631", { includeFinancials: true }, options);
  assert.equal(financial.claims[0].billed, 200);
  const basic = await getClaimsForPatient("31631", {}, options);
  assert.equal("billed" in basic.claims[0], false);
  assert.equal(basic.access.paymentsAndEra, false);
  await getClaimsForPatient("31631", { offset: 0, procedureQuery: "" }, options);
  assert.equal(loads, 2);
  for (const filter of [
    { startDate: "2026-01-01" }, { endDate: "2026-09-01" }, { offset: 25 }, { procedureQuery: "992" },
  ]) await getClaimsForPatient("31631", filter, options);
  await getClaimsForPatient("31632", {}, options);
  assert.equal(loads, 7);
});

test("CPT lookups cache equivalent codes and keep claims and codes separate", async () => {
  let loads = 0;
  const options = {
    cache: createTtlCache({ ttlMs: DATA_CACHE_TTL_MS }),
    withReadOnlySession: runReadOnly,
    searchPatientClaimsByProcedure: async () => ({ version: ++loads }),
  };
  assert.equal((await getPatientClaimsByProcedure("80751", "a9607", options)).version, 1);
  assert.equal((await getPatientClaimsByProcedure(" 80751 ", "A9607", options)).version, 1);
  assert.equal((await getPatientClaimsByProcedure("80751", "78815", options)).version, 2);
  assert.equal((await getPatientClaimsByProcedure("80752", "A9607", options)).version, 3);
  await assert.rejects(getPatientClaimsByProcedure("80751", "A96", options));
  assert.equal(loads, 3);
});

function claimOptions(now = () => 0) {
  const counts = { database: 0, comments: 0, categorization: 0 };
  const baseOptions = {
    cache: createTtlCache({ ttlMs: CLAIM_CACHE_TTL_MS, now }),
    withReadOnlySession: runReadOnly,
    readClaimSources: async () => { counts.database += 1; return sources(); },
  };
  const options = {
    getBaseClaimLifecycle: (id) => getBaseClaimLifecycle(id, baseOptions),
    enrichClaimWithComments: async (base) => {
      counts.comments += 1;
      return { ...base, comments: [], commentIntegration: { status: "ready", geminiStatus: "ready" } };
    },
    enrichClaimWithCategorization: async (base) => {
      counts.categorization += 1;
      return { ...base, categorization: null, categorizationIntegration: { status: "ready", source: "RCM Claims API" } };
    },
  };
  return { counts, options };
}

test("claim database snapshots last 24 hours while Salesforce comments load on every search", async () => {
  let time = 0;
  const { counts, options } = claimOptions(() => time);
  await Promise.all([getClaimLifecycle("80751", options), getClaimLifecycle("80751", options)]);
  assert.deepEqual(counts, { database: 1, comments: 2, categorization: 1 });
  time = twentyFourHours - 1;
  const cached = await getClaimLifecycle("80751", options);
  const basic = filterClaimLifecycleByPermissions(cached, { claimOverview: true });
  assert.equal("totalPaid" in basic.summary, false);
  assert.equal("eras" in basic, false);
  const financial = filterClaimLifecycleByPermissions(cached, { claimOverview: true, paymentsAndEra: true });
  assert.equal(financial.summary.charges, 200);
  assert.deepEqual(counts, { database: 1, comments: 3, categorization: 1 });
  time = twentyFourHours;
  await getClaimLifecycle("80751", options);
  assert.deepEqual(counts, { database: 2, comments: 4, categorization: 2 });
});

test("the fast claim response skips live integrations", async () => {
  const { counts, options } = claimOptions();
  const result = await getCachedClaimLifecycle("80751", options);
  assert.equal(result.claim.claimId, "80751");
  assert.deepEqual(counts, { database: 1, comments: 0, categorization: 0 });
});

test("clearing claim enrichment reloads categorization without another database read", async () => {
  const { counts, options } = claimOptions();
  await getClaimLifecycle("80751", options);
  invalidateClaimEnrichments();
  await getClaimLifecycle("80751", options);
  assert.deepEqual(counts, { database: 1, comments: 2, categorization: 2 });
});

test("temporary categorized-claim integration errors remain retryable during the 24-hour claim cache", async () => {
  const { counts, options } = claimOptions();
  const success = options.enrichClaimWithCategorization;
  let attempts = 0;
  options.enrichClaimWithCategorization = async (base) => {
    const result = await success(base);
    if (++attempts === 1) result.categorizationIntegration.status = "timeout";
    return result;
  };
  await getClaimLifecycle("80751", options);
  await getClaimLifecycle("80751", options);
  await getClaimLifecycle("80751", options);
  assert.deepEqual(counts, { database: 1, comments: 3, categorization: 2 });
});
