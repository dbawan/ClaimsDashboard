import { withReadOnlySession } from "../db/readOnlyPool.js";
import { normalizeIdentifier, submissionSuffix } from "../lib/claimIdentity.js";
import {
  readPatientClaimSources,
  searchPatientsByName,
} from "../repositories/claimRepository.js";
import { buildClaimLifecycle } from "./claimLifecycleService.js";
import { DATA_CACHE_TTL_MS } from "../lib/dataCache.js";
import { createTtlCache } from "../lib/ttlCache.js";

const patientNameCache = createTtlCache({ ttlMs: DATA_CACHE_TTL_MS });
const patientClaimsCache = createTtlCache({ ttlMs: DATA_CACHE_TTL_MS });

function invalidPatientSearch(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  error.expose = true;
  return error;
}

export function assertValidPatientNameSearch(value) {
  const query = String(value ?? "").trim().replace(/\s+/g, " ");
  const searchableCharacters = query.match(/[\p{L}\p{N}]/gu) || [];
  if (searchableCharacters.length < 2) {
    throw invalidPatientSearch(
      "Enter at least two letters of the patient's first or last name.",
      "PATIENT_NAME_TOO_SHORT",
    );
  }
  if (query.length > 80 || !/^[\p{L}\p{M}\p{N} .,'’-]+$/u.test(query)) {
    throw invalidPatientSearch(
      "Use a valid patient name containing letters, spaces, apostrophes, commas, periods, or hyphens.",
      "INVALID_PATIENT_NAME",
    );
  }
  return query;
}

export function assertValidPatientId(value) {
  const patientId = String(value ?? "").trim();
  if (!/^\d{1,20}$/.test(patientId)) {
    throw invalidPatientSearch("Select a patient from the recommendation list.", "INVALID_PATIENT_ID");
  }
  return patientId;
}

function validCalendarDate(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized
    ? null
    : normalized;
}

export function assertValidServiceDateRange({ startDate, endDate } = {}) {
  const normalizedStart = startDate == null || startDate === "" ? null : validCalendarDate(startDate);
  const normalizedEnd = endDate == null || endDate === "" ? null : validCalendarDate(endDate);
  if ((startDate && !normalizedStart) || (endDate && !normalizedEnd)) {
    throw invalidPatientSearch(
      "Use valid date-of-service boundaries in YYYY-MM-DD format.",
      "INVALID_SERVICE_DATE_RANGE",
    );
  }
  if (normalizedStart && normalizedEnd && normalizedStart > normalizedEnd) {
    throw invalidPatientSearch(
      "The date-of-service start date must be on or before the end date.",
      "INVALID_SERVICE_DATE_RANGE",
    );
  }
  return { startDate: normalizedStart, endDate: normalizedEnd };
}

export function assertValidPatientClaimOffset(value) {
  if (value == null || value === "") return 0;
  const normalized = String(value).trim();
  if (!/^\d{1,7}$/.test(normalized)) {
    throw invalidPatientSearch("Use a valid patient-claim page offset.", "INVALID_CLAIM_OFFSET");
  }
  return Number(normalized);
}

export function assertValidPatientProcedureQuery(value) {
  const query = String(value ?? "").trim().toUpperCase();
  if (!query) return null;
  if (query.length > 20 || !/^[A-Z0-9.-]+$/.test(query)) {
    throw invalidPatientSearch(
      "Use up to 20 letters or numbers for the CPT or HCPCS search.",
      "INVALID_PROCEDURE_QUERY",
    );
  }
  return query;
}

function groupTransactions(rows, claimIds) {
  const grouped = new Map(claimIds.map((claimId) => [claimId, []]));
  for (const row of rows) {
    const claimId = normalizeIdentifier(row.ENCOUNTERID);
    if (grouped.has(claimId)) grouped.get(claimId).push(row);
  }
  return grouped;
}

function groupEraRows(rows, field, claimIds) {
  const orderedIds = [...claimIds].sort((left, right) => right.length - left.length);
  const grouped = new Map(claimIds.map((claimId) => [claimId, []]));
  for (const row of rows) {
    const reference = row?.[field];
    const claimId = orderedIds.find((candidate) => submissionSuffix(candidate, reference) !== null);
    if (claimId) grouped.get(claimId).push(row);
  }
  return grouped;
}

function emptyInvoiceLookup() {
  return {
    status: "not_loaded",
    matchMethod: null,
    matchedCpts: [],
    matchedProducts: [],
    isAmbiguous: false,
    candidateClaimIds: [],
    candidateClaimsByServiceDate: [],
    message: "Invoice matching is not required for the patient claim selector.",
  };
}

export function buildPatientClaimsResponse(sources, { includeFinancials = false } = {}) {
  const claimIds = sources.claimRows.map(({ claimId }) => claimId);
  const transactionsByClaim = groupTransactions(sources.transactions || [], claimIds);
  const claimStatusByClaim = groupEraRows(
    sources.claimStatus || [],
    "PatientControlNumber",
    claimIds,
  );
  const ediByClaim = groupEraRows(
    sources.edi835 || [],
    "patient_control_number",
    claimIds,
  );

  const claims = sources.claimRows.map((row) => {
    if (!includeFinancials) return row;
    const lifecycle = buildClaimLifecycle({
      claimId: row.claimId,
      transactions: transactionsByClaim.get(row.claimId) || [],
      claimStatus: claimStatusByClaim.get(row.claimId) || [],
      edi835: ediByClaim.get(row.claimId) || [],
      advancedMdEra: (sources.advancedMdEra || []).filter((era) => submissionSuffix(row.claimId, era.reference) !== null),
      priorAuthorizations: [],
      patientInvoices: [],
      patientInvoiceLookup: emptyInvoiceLookup(),
    });
    return Object.freeze({
      ...row,
      serviceDate: lifecycle.claim.serviceDate || row.serviceDate,
      lastActivityDate: lifecycle.claim.lastActivityAt || row.lastActivityDate,
      status: lifecycle.claim.status || row.status,
      payer: lifecycle.claim.payer === "Not provided" ? row.payer : lifecycle.claim.payer,
      billed: lifecycle.summary.charges,
      latestCharge: lifecycle.summary.latestCharge,
      paidThresholdPercent: lifecycle.summary.paidThresholdPercent,
      paidThresholdDate: lifecycle.summary.paidThresholdDate,
      daysToPaid: lifecycle.summary.daysToPaid,
      paid: lifecycle.summary.totalPaid,
      received: lifecycle.summary.receivedPaid,
      balance: lifecycle.summary.balance,
    });
  });

  return Object.freeze({
    patient: sources.patient,
    total: sources.total,
    hasMore: sources.hasMore,
    nextOffset: sources.nextOffset ?? null,
    access: Object.freeze({ paymentsAndEra: includeFinancials }),
    claims: Object.freeze(claims),
  });
}

export async function findPatientsByName(value, options = {}) {
  const query = assertValidPatientNameSearch(value);
  const run = options.withReadOnlySession || withReadOnlySession;
  const search = options.searchPatientsByName || searchPatientsByName;
  return (options.cache || patientNameCache).getOrLoad(
    query.toLowerCase(),
    () => run((session) => search(session, query)),
  );
}

export async function getClaimsForPatient(value, {
  includeFinancials = false,
  startDate,
  endDate,
  offset,
  procedureQuery,
} = {}, options = {}) {
  const patientId = assertValidPatientId(value);
  const dateRange = assertValidServiceDateRange({ startDate, endDate });
  const pageOffset = assertValidPatientClaimOffset(offset);
  const validatedProcedureQuery = assertValidPatientProcedureQuery(procedureQuery);
  const run = options.withReadOnlySession || withReadOnlySession;
  const read = options.readPatientClaimSources || readPatientClaimSources;
  const financials = Boolean(includeFinancials);
  const cacheKey = JSON.stringify([patientId, financials, dateRange.startDate,
    dateRange.endDate, pageOffset, validatedProcedureQuery]);
  return (options.cache || patientClaimsCache).getOrLoad(cacheKey, async () => {
    const sources = await run((session) => read(session, patientId, {
      includeFinancials: financials,
      ...dateRange,
      offset: pageOffset,
      procedureQuery: validatedProcedureQuery,
    }));
    return buildPatientClaimsResponse(sources, { includeFinancials: financials });
  });
}
