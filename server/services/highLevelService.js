import { advancedMdEraRows, distinctEraRows } from "../lib/eraReconciliation.js";
import { withReadOnlySession } from "../db/readOnlyPool.js";
import { config } from "../config.js";
import {
  readClaimIcu,
  readClaimsWithoutResponse,
  readHighLevelDashboard,
  readHighLevelClaims,
  readUnsubmittedAppointments,
} from "../repositories/highLevelRepository.js";
import { listClaimWorklistOwners } from "../repositories/worklistRepository.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { DATA_CACHE_TTL_MS } from "../lib/dataCache.js";
import { claimPaymentTiming } from "../lib/claimPaymentTiming.js";
import { calculateExpectedReimbursement } from "./expectedReimbursementService.js";
import {
  encounterCandidateFromEraReference,
  normalizeDate,
  normalizeIdentifier,
  submissionOrder,
  submissionSuffixForOrder,
} from "../lib/claimIdentity.js";

const ALLOWED_LIMITS = new Set([10, 25, 50, 100]);
const ALLOWED_SORTS = new Set(["paid-percent", "youngest", "oldest", "billed"]);
const ALLOWED_QUEUE_ORDERS = new Set(["youngest", "oldest"]);
const ALLOWED_DASHBOARD_BILLING_MODES = new Set(["all", "latest", "original"]);
const ALLOWED_ICU_SORTS = new Set(["deadline", "cpt-charged", "charged"]);
export const MYSQL_HIGH_LEVEL_CACHE_TTL_MS = DATA_CACHE_TTL_MS;
const highLevelClaimsCache = createTtlCache({ ttlMs: MYSQL_HIGH_LEVEL_CACHE_TTL_MS });
const unsubmittedCache = createTtlCache({ ttlMs: MYSQL_HIGH_LEVEL_CACHE_TTL_MS });
const noResponseCache = createTtlCache({ ttlMs: MYSQL_HIGH_LEVEL_CACHE_TTL_MS });
const dashboardCache = createTtlCache({ ttlMs: MYSQL_HIGH_LEVEL_CACHE_TTL_MS });
const claimIcuCache = createTtlCache({ ttlMs: MYSQL_HIGH_LEVEL_CACHE_TTL_MS });

function cacheLogger(scope) {
  return (stage, details) => console.info(`[mysql-cache:${scope}] ${stage}`, details);
}

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "INVALID_HIGH_LEVEL_FILTER";
  return error;
}

function validDate(value, label) {
  const candidate = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate) || !Number.isFinite(Date.parse(`${candidate}T00:00:00Z`))) {
    throw inputError(`${label} must use YYYY-MM-DD.`);
  }
  return candidate;
}

function dashboardPayerSelection(value) {
  const values = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  if (values.length > 100) throw inputError("Choose no more than 100 payers.");
  const payers = [...new Set(values.map((payer) => normalizeIdentifier(payer)).filter(Boolean))];
  if (payers.some((payer) => payer.length > 120)) throw inputError("Choose a valid dashboard payer.");
  return payers;
}

export function highLevelProcedureQuery(value) {
  if (value == null) return "";
  if (typeof value !== "string") throw inputError("Enter one CPT or HCPCS search value.");
  const query = value.trim().toUpperCase();
  if (query && !/^[A-Z0-9.-]{1,20}$/.test(query)) {
    throw inputError("Use up to 20 letters, numbers, periods, or hyphens for the CPT / HCPCS search.");
  }
  return query;
}

function elapsedDays(date, today) {
  if (!date) return 0;
  return Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000));
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function calendarDaysBetween(start, end) {
  if (!start || !end) return null;
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return Math.round((endTime - startTime) / 86_400_000);
}

function queryBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") throw inputError("Choose whether to include past filing limits.");
  if (["true", "1"].includes(value.toLowerCase())) return true;
  if (["false", "0"].includes(value.toLowerCase())) return false;
  throw inputError("Choose whether to include past filing limits.");
}

function roundedMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function text(value) {
  return String(value ?? "").trim();
}

function denialReasons(value) {
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((entry) => {
        if (!entry || typeof entry !== "object") return text(entry);
        const group = text(entry.group || entry.group_code).toUpperCase();
        const reason = text(entry.reason || entry.reason_code || entry.code).toUpperCase();
        return [group, reason].filter(Boolean).join("-");
      }).filter(Boolean))];
    }
  } catch {
    // Plain-text adjustment codes are normalized below.
  }

  const codes = [...raw.toUpperCase().matchAll(/\b([A-Z]{1,3})[- :#]*(\d{1,4})\b/g)]
    .map((match) => `${match[1]}-${match[2]}`);
  if (codes.length) return [...new Set(codes)];
  return [raw.replace(/\s+/g, " ").slice(0, 80)];
}

function normalizeDashboardEraRow(row, source, sourceRank) {
  return {
    source,
    sourceRank,
    rowId: row.rowId,
    payerClaimControl: row.payerClaimControl,
    reference: normalizeIdentifier(row.reference),
    date: normalizeDate(row.eventDate),
    serviceDate: normalizeDate(row.serviceDate),
    procedure: normalizeIdentifier(row.procedureCode) || "UNCODED",
    modifier: normalizeIdentifier(row.modifier),
    lineNumber: normalizeIdentifier(row.lineNumber),
    charge: numberValue(row.charge),
    paid: numberValue(row.paid),
    allowed: numberValue(row.allowed),
    reasons: denialReasons(row.reason),
    payer: normalizeIdentifier(row.payer),
    payerLabel: text(row.payer) || null,
    traceNumber: normalizeIdentifier(row.traceNumber),
  };
}

function distinctDashboardEraRows(rows) {
  return distinctEraRows(rows.map((row, index) => ({
    ...row, sourceType: row.sourceType || row.source, rowId: row.rowId || String(index),
    claimReference: row.reference, eventDate: row.date, remitId: row.traceNumber,
    paidCents: Math.round(row.paid * 100), chargeCents: Math.round(row.charge * 100),
    allowedCents: Math.round(row.allowed * 100), adjustment: row.reasons.join(","), units: "",
  }))).rows;
}

function advancedMdDashboardRows(rows) {
  return advancedMdEraRows(rows).map((row) => ({
    ...row, source: "advancedmd", reference: normalizeIdentifier(row.claimReference),
    date: normalizeDate(row.eventDate), procedure: row.procedure || "UNCODED",
    charge: (row.chargeCents || 0) / 100, paid: row.paidCents / 100,
    allowed: (row.allowedCents || 0) / 100,
    reasons: row.claimLevelOnly ? [] : denialReasons(row.adjustment),
    payerLabel: row.payer, payer: normalizeIdentifier(row.payer), traceNumber: normalizeIdentifier(row.remitId),
  }));
}

function netDashboardPaymentGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.paid) continue;
    const paymentIdentity = row.reference || (row.traceNumber ? `TRACE:${row.traceNumber}` : "UNKNOWN");
    const key = [row.date, paymentIdentity, row.payer || "UNKNOWN"].join("|");
    const group = groups.get(key) || {
      date: row.date,
      reference: row.reference || "UNKNOWN",
      payer: row.payer || null,
      serviceDate: row.serviceDate,
      paid: 0,
      procedures: new Set(),
    };
    group.paid = Number((group.paid + row.paid).toFixed(2));
    group.payer ||= row.payer || null;
    group.serviceDate ||= row.serviceDate;
    group.procedures.add(row.procedure);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function normalizeDashboardBilledRow(row) {
  const sourceClaimId = normalizeIdentifier(row.claimId);
  const familyMatch = sourceClaimId.match(/^(\d+)([A-Z]*)$/);
  const familyId = normalizeIdentifier(row.familyId) || familyMatch?.[1] || sourceClaimId;
  const explicitOrder = row.submissionOrder == null ? null : Math.max(0, Math.round(numberValue(row.submissionOrder)));
  const normalizedSubmissionOrder = explicitOrder ?? (familyMatch ? submissionOrder(familyMatch[2]) : 0);
  const claimId = explicitOrder == null
    ? sourceClaimId
    : `${familyId}${submissionSuffixForOrder(normalizedSubmissionOrder)}`;
  return {
    date: normalizeDate(row.date),
    claimId,
    familyId,
    submissionOrder: normalizedSubmissionOrder,
    latestSubmissionOrder: row.latestSubmissionOrder == null
      ? null
      : Math.max(0, Math.round(numberValue(row.latestSubmissionOrder))),
    procedure: normalizeIdentifier(row.procedureCode) || "UNCODED",
    patientName: text(row.patientName) || null,
    payer: text(row.payer) || null,
    charge: numberValue(row.charge ?? row.billed),
  };
}

function dashboardBilledRowsForMode(result, billingMode) {
  if (billingMode === "original") {
    return (result.originalRows || []).map(normalizeDashboardBilledRow);
  }

  const normalized = (result.billedRows || []).map(normalizeDashboardBilledRow);
  if (billingMode === "all") return normalized;

  const latestOrderByFamily = new Map();
  for (const row of normalized) {
    const candidate = row.latestSubmissionOrder ?? row.submissionOrder;
    latestOrderByFamily.set(row.familyId, Math.max(candidate, latestOrderByFamily.get(row.familyId) ?? -1));
  }
  return normalized.filter((row) => row.submissionOrder === latestOrderByFamily.get(row.familyId));
}

function latestDeniedBilledLookup(rows) {
  const byClaimAndProcedure = new Map();
  const claimIds = new Set();
  for (const row of rows || []) {
    const claimId = normalizeIdentifier(row.claimId);
    const procedure = normalizeIdentifier(row.procedureCode) || "UNCODED";
    if (!claimId) continue;
    claimIds.add(claimId);
    byClaimAndProcedure.set(`${claimId}|${procedure}`, {
      claimId,
      billed: numberValue(row.charge),
      date: normalizeDate(row.date),
    });
  }
  return { byClaimAndProcedure, claimIds };
}

function latestDeniedBilledForReference(lookup, reference, procedure) {
  const normalizedReference = normalizeIdentifier(reference);
  const familyCandidate = encounterCandidateFromEraReference(normalizedReference);
  for (const claimId of [normalizedReference, familyCandidate]) {
    if (!claimId || !lookup.claimIds.has(claimId)) continue;
    const match = lookup.byClaimAndProcedure.get(`${claimId}|${procedure}`);
    if (match) return match;
  }
  return null;
}

function rankedCountEntries(map, keyName) {
  return [...map]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((left, right) => right.count - left.count
      || String(left[keyName]).localeCompare(String(right[keyName])));
}

function dashboardPayerKey(value) {
  return normalizeIdentifier(value) || "UNSPECIFIED";
}

function dashboardReferenceFamily(reference) {
  return reference.match(/^(\d+)[A-Z]+$/)?.[1]
    || encounterCandidateFromEraReference(reference)
    || reference;
}

function dashboardPayerContext(billedRows, eraRows) {
  const payerMap = new Map();
  const billedPayerByFamily = new Map();
  const addClaim = (key, label, claimId) => {
    const payer = payerMap.get(key) || {
      key,
      label: label || "Payer not provided",
      claims: new Set(),
    };
    if (payer.label === "Payer not provided" && label) payer.label = label;
    if (claimId) payer.claims.add(claimId);
    payerMap.set(key, payer);
  };

  for (const row of billedRows) {
    const familyId = row.familyId || row.claimId;
    const payerKey = dashboardPayerKey(row.payer);
    billedPayerByFamily.set(familyId, { key: payerKey, label: row.payer });
    addClaim(
      payerKey,
      row.payer,
      familyId,
    );
  }
  for (const row of eraRows) {
    const familyId = dashboardReferenceFamily(row.reference);
    const billedPayer = billedPayerByFamily.get(familyId);
    addClaim(
      billedPayer?.key || dashboardPayerKey(row.payer),
      billedPayer?.label || row.payerLabel,
      familyId,
    );
  }

  const options = [...payerMap.values()]
    .map((payer) => ({
      key: payer.key,
      label: payer.label,
      claimCount: payer.claims.size,
    }))
    .sort((left, right) => right.claimCount - left.claimCount
      || left.label.localeCompare(right.label));
  const eraPayerKey = (row) => billedPayerByFamily.get(dashboardReferenceFamily(row.reference))?.key
    || dashboardPayerKey(row.payer);
  return { options, eraPayerKey };
}

export function buildHighLevelDashboardResponse(result, {
  start,
  end,
  billingMode = "all",
  payers = [],
  procedureQuery = "",
}) {
  const normalizedProcedureQuery = highLevelProcedureQuery(procedureQuery);
  const includesProcedure = (row) => !normalizedProcedureQuery
    || row.procedure.includes(normalizedProcedureQuery);
  const daily = new Map();
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  for (let time = startTime; time <= endTime; time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    daily.set(date, {
      date,
      billed: 0,
      paid: 0,
      recouped: 0,
      posted: 0,
      postedClaimMap: new Map(),
      claimCount: 0,
      paymentLineCount: 0,
      deniedLineCount: 0,
      cptMap: new Map(),
      claimMap: new Map(),
      paymentClaimMap: new Map(),
      recoupmentClaimMap: new Map(),
    });
  }

  const billedRows = dashboardBilledRowsForMode(result, billingMode);
  const allEraRows = distinctDashboardEraRows([
    ...advancedMdDashboardRows(result.advancedMdEra),
    ...(result.claimStatusRows || []).map((row) => normalizeDashboardEraRow(row, "claim-status", 1)),
    ...(result.ediRows || []).map((row) => normalizeDashboardEraRow(row, "edi-835", 2)),
  ]).filter((row) => row.date && daily.has(row.date));
  const allPostedRows = (result.postedRows || []).map((row) => normalizeDashboardEraRow(row, "posted", 3))
    .filter((row) => row.date && daily.has(row.date));
  const payerContext = dashboardPayerContext(billedRows, [...allEraRows, ...allPostedRows]);
  const payerOptions = payerContext.options;
  const selectedPayers = [...new Set(
    payers.map(dashboardPayerKey).filter((payer) => payerOptions.some((option) => option.key === payer)),
  )];
  const payerFilter = new Set(selectedPayers);
  const includesBilledPayer = (payer) => !payerFilter.size || payerFilter.has(dashboardPayerKey(payer));
  const includesEraPayer = (row) => !payerFilter.size || payerFilter.has(payerContext.eraPayerKey(row));

  for (const row of billedRows.filter((row) => includesBilledPayer(row.payer) && includesProcedure(row))) {
    if (!row.date || !daily.has(row.date)) continue;
    const point = daily.get(row.date);
    point.billed = Number((point.billed + row.charge).toFixed(2));

    const cpt = point.cptMap.get(row.procedure) || { procedure: row.procedure, count: 0, billed: 0 };
    cpt.count += 1;
    cpt.billed = Number((cpt.billed + row.charge).toFixed(2));
    point.cptMap.set(row.procedure, cpt);

    const claimKey = row.claimId || "UNKNOWN";
    const claim = point.claimMap.get(claimKey) || {
      claimId: claimKey,
      patientName: row.patientName,
      payer: row.payer,
      billed: 0,
      procedures: new Set(),
    };
    claim.billed = Number((claim.billed + row.charge).toFixed(2));
    claim.patientName ||= row.patientName;
    claim.payer ||= row.payer;
    claim.procedures.add(row.procedure);
    point.claimMap.set(claimKey, claim);
  }

  const eraRows = allEraRows.filter((row) => includesEraPayer(row) && includesProcedure(row));
  const deniedCptStats = new Map();
  const denialReasonStats = new Map();
  const latestDeniedBilled = latestDeniedBilledLookup(result.latestDeniedBilledRows);

  for (const row of eraRows) {
    const point = daily.get(row.date);
    point.paymentLineCount += 1;
    if (row.paid !== 0 || row.charge <= 0 || !row.reasons.length) continue;
    point.deniedLineCount += 1;

    const latestBilled = latestDeniedBilledForReference(latestDeniedBilled, row.reference, row.procedure);
    const cpt = deniedCptStats.get(row.procedure) || {
      count: 0,
      totalBilled: 0,
      billedCount: 0,
      claims: new Map(),
    };
    cpt.count += 1;
    if (latestBilled) {
      cpt.totalBilled = Number((cpt.totalBilled + latestBilled.billed).toFixed(2));
      cpt.billedCount += 1;
    }
    const deniedClaimId = row.reference || latestBilled?.claimId || "UNKNOWN";
    if (!cpt.claims.has(deniedClaimId)) {
      cpt.claims.set(deniedClaimId, {
        claimId: deniedClaimId,
        billed: latestBilled?.billed ?? null,
        latestBillingDate: latestBilled?.date ?? null,
      });
    }
    deniedCptStats.set(row.procedure, cpt);

    for (const reason of row.reasons) {
      const reasonStats = denialReasonStats.get(reason) || { count: 0, cpts: new Map() };
      reasonStats.count += 1;
      reasonStats.cpts.set(row.procedure, (reasonStats.cpts.get(row.procedure) || 0) + 1);
      denialReasonStats.set(reason, reasonStats);
    }
  }

  for (const payment of netDashboardPaymentGroups(eraRows)) {
    const point = daily.get(payment.date);
    const claimKey = payment.reference || "UNKNOWN";
    if (payment.paid > 0) {
      point.paid = Number((point.paid + payment.paid).toFixed(2));
      const paidClaim = point.paymentClaimMap.get(claimKey) || {
        claimId: claimKey,
        payer: payment.payer,
        serviceDate: payment.serviceDate,
        paid: 0,
        procedures: new Set(),
      };
      paidClaim.paid = Number((paidClaim.paid + payment.paid).toFixed(2));
      paidClaim.payer ||= payment.payer;
      paidClaim.serviceDate ||= payment.serviceDate;
      for (const procedure of payment.procedures) paidClaim.procedures.add(procedure);
      point.paymentClaimMap.set(claimKey, paidClaim);
    } else if (payment.paid < 0) {
      point.recouped = Number((point.recouped + payment.paid).toFixed(2));
      const recoupedClaim = point.recoupmentClaimMap.get(claimKey) || {
        claimId: claimKey,
        payer: payment.payer,
        serviceDate: payment.serviceDate,
        recouped: 0,
        procedures: new Set(),
      };
      recoupedClaim.recouped = Number((recoupedClaim.recouped + payment.paid).toFixed(2));
      recoupedClaim.payer ||= payment.payer;
      recoupedClaim.serviceDate ||= payment.serviceDate;
      for (const procedure of payment.procedures) recoupedClaim.procedures.add(procedure);
      point.recoupmentClaimMap.set(claimKey, recoupedClaim);
    }
  }

  for (const payment of netDashboardPaymentGroups(allPostedRows.filter((row) => includesEraPayer(row) && includesProcedure(row)))) {
    const point = daily.get(payment.date);
    point.posted = Number((point.posted + payment.paid).toFixed(2));
    const key = payment.reference || "UNKNOWN";
    const claim = point.postedClaimMap.get(key) || {
      claimId: key, payer: payment.payer, serviceDate: payment.serviceDate, posted: 0, procedures: new Set(),
    };
    claim.posted = Number((claim.posted + payment.paid).toFixed(2));
    for (const procedure of payment.procedures) claim.procedures.add(procedure);
    point.postedClaimMap.set(key, claim);
  }

  const dailyPoints = [...daily.values()].map((point) => ({
    date: point.date,
    billed: point.billed,
    paid: point.paid,
    recouped: point.recouped,
    posted: point.posted,
    postedClaims: [...point.postedClaimMap.values()].map((claim) => ({ ...claim, procedures: [...claim.procedures].sort() }))
      .sort((a, b) => b.posted - a.posted || a.claimId.localeCompare(b.claimId)),
    claimCount: point.claimMap.size,
    paymentLineCount: point.paymentLineCount,
    deniedLineCount: point.deniedLineCount,
    cpts: [...point.cptMap.values()].sort((left, right) => right.count - left.count
      || right.billed - left.billed
      || left.procedure.localeCompare(right.procedure)),
    claims: [...point.claimMap.values()].map((claim) => ({
      ...claim,
      procedures: [...claim.procedures].sort(),
    })).sort((left, right) => right.billed - left.billed
      || left.claimId.localeCompare(right.claimId)),
    paidClaims: [...point.paymentClaimMap.values()].map((claim) => ({
      ...claim,
      procedures: [...claim.procedures].sort(),
    })).sort((left, right) => right.paid - left.paid
      || left.claimId.localeCompare(right.claimId)),
    recoupedClaims: [...point.recoupmentClaimMap.values()].map((claim) => ({
      ...claim,
      procedures: [...claim.procedures].sort(),
    })).sort((left, right) => left.recouped - right.recouped
      || left.claimId.localeCompare(right.claimId)),
  }));
  const deniedCpts = [...deniedCptStats]
    .map(([procedure, stats]) => ({
      procedure,
      count: stats.count,
      averageBilled: stats.billedCount
        ? Number((stats.totalBilled / stats.billedCount).toFixed(2))
        : null,
      claims: [...stats.claims.values()].sort((left, right) => (
        (right.billed ?? Number.NEGATIVE_INFINITY) - (left.billed ?? Number.NEGATIVE_INFINITY)
        || left.claimId.localeCompare(right.claimId)
      )),
    }))
    .sort((left, right) => right.count - left.count
      || right.averageBilled - left.averageBilled
      || left.procedure.localeCompare(right.procedure));
  const reasons = [...denialReasonStats]
    .map(([reason, stats]) => ({
      reason,
      count: stats.count,
      cpts: rankedCountEntries(stats.cpts, "procedure"),
    }))
    .sort((left, right) => right.count - left.count
      || left.reason.localeCompare(right.reason))
    .slice(0, 6);
  return {
    start,
    end,
    billingMode,
    procedureQuery: normalizedProcedureQuery,
    payerOptions,
    selectedPayers,
    totals: {
      billed: Number(dailyPoints.reduce((total, point) => total + point.billed, 0).toFixed(2)),
      paid: Number(dailyPoints.reduce((total, point) => total + point.paid, 0).toFixed(2)),
      posted: Number(dailyPoints.reduce((total, point) => total + point.posted, 0).toFixed(2)),
      recouped: Number(dailyPoints.reduce((total, point) => total + point.recouped, 0).toFixed(2)),
      claimsBilled: dailyPoints.reduce((total, point) => total + point.claimCount, 0),
      deniedLines: [...deniedCptStats.values()].reduce((total, stats) => total + stats.count, 0),
    },
    deniedCpts,
    denialReasons: reasons,
    daily: dailyPoints,
  };
}

function queueFilters(query, mode) {
  const order = String(query.order || "oldest");
  if (!ALLOWED_QUEUE_ORDERS.has(order)) throw inputError("Choose a valid queue order.");
  const allowedScopes = mode === "unsubmitted" ? new Set(["all", "recent"]) : new Set(["all", "overdue"]);
  const scope = String(query.scope || "all");
  if (!allowedScopes.has(scope)) throw inputError("Choose a valid queue age filter.");
  const start = validDate(query.start, "Start date");
  const end = validDate(query.end, "End date");
  if (start > end) throw inputError("Start date must be on or before end date.");
  const dayCount = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  if (dayCount > 3_650) throw inputError("Queue ranges cannot exceed 3,650 days.");
  return { order, scope, start, end };
}

function currentStatus(events) {
  return events.reduce((status, event) => {
    if (event.status === "submitted") return "pending";
    if (event.status === "reversed" || event.status === "action") return "action";
    if (event.status === "paid") return "paid";
    if (event.status === "received") return status === "paid" ? "paid" : "received";
    if (event.status === "receipt-reversed") return "action";
    if (event.status === "processed") return status === "paid" ? "paid" : "action";
    if (event.status === "created" && status === "created") return "created";
    return status;
  }, "created");
}

function currentIssue(events, status) {
  if (status !== "action") return null;
  return [...events].reverse().find((event) => (
    event.status === "action" || event.status === "reversed" || event.status === "processed"
  ))?.label || "Review needed";
}

const EVENT_PRIORITY = Object.freeze({
  created: 0,
  activity: 1,
  submitted: 2,
  action: 3,
  received: 3,
  "receipt-reversed": 5,
  paid: 4,
  reversed: 5,
  processed: 6,
});

function highLevelPaymentEvents(events) {
  const payments = events.filter((event) => (
    (event.status === "paid" || event.status === "reversed")
    && Number.isFinite(Number(event.amount))
    && Number(event.amount) !== 0
  ));
  return payments.filter((event) => event.source === "billing").map((event) => ({
    date: event.date, amount: Number(event.amount),
  }));
}

function claimCreationDate(claim, events) {
  const created = events
    .filter((event) => event.status === "created" && event.date)
    .map((event) => event.date)
    .sort()[0];
  if (created) return created;
  return [
    ...events.filter((event) => event.source === "billing").map((event) => event.date),
    claim.firstActivity,
    claim.serviceDate,
  ].filter(Boolean).sort()[0] || null;
}

function cptPaymentSummary(latestCharges, events) {
  const procedures = new Map();
  function getProcedure(code) {
    const procedure = normalizeIdentifier(code) || "UNCODED";
    if (!procedures.has(procedure)) {
      procedures.set(procedure, { procedure, latestCharge: null, postedCents: 0, receivedCents: 0 });
    }
    return procedures.get(procedure);
  }
  for (const charge of latestCharges || []) {
    const row = getProcedure(charge.procedure);
    row.latestCharge = Number(((row.latestCharge || 0) + numberValue(charge.latestCharge)).toFixed(2));
  }
  for (const event of events) {
    const posted = event.source === "billing" && ["paid", "reversed"].includes(event.status);
    const received = event.source === "payer";
    if ((!posted && !received) || !numberValue(event.amount)) continue;
    const row = getProcedure(event.procedure);
    row[posted ? "postedCents" : "receivedCents"] += Math.round(numberValue(event.amount) * 100);
  }
  return [...procedures.values()].map(({ postedCents, receivedCents, ...row }) => ({
    ...row, posted: postedCents / 100, received: receivedCents / 100,
  })).sort((a, b) => (b.latestCharge || 0) - (a.latestCharge || 0) || a.procedure.localeCompare(b.procedure));
}

export function buildHighLevelResponse(result, {
  start,
  end,
  limit,
  page = 1,
  sort = "youngest",
  paidThresholdPercent = config.claims.paidThresholdPercent,
  procedureQuery = "",
}) {
  const lifecycleEventsByClaim = new Map();
  for (const event of result.lifecycleEvents || result.events) {
    if (!lifecycleEventsByClaim.has(event.claimId)) lifecycleEventsByClaim.set(event.claimId, []);
    lifecycleEventsByClaim.get(event.claimId).push(event);
  }
  const claims = result.claims.map((claim) => {
    const lifecycleEvents = (lifecycleEventsByClaim.get(claim.claimId) || [])
      .sort((left, right) => left.date.localeCompare(right.date)
        || (EVENT_PRIORITY[left.status] ?? 99) - (EVENT_PRIORITY[right.status] ?? 99)
        || left.label.localeCompare(right.label));
    const events = lifecycleEvents.filter((event) => event.date >= start && event.date <= end);
    const status = currentStatus(events);
    const paymentTiming = claimPaymentTiming({
      createdAt: claimCreationDate(claim, lifecycleEvents),
      latestCharge: claim.latestChargeAmount,
      payments: highLevelPaymentEvents(lifecycleEvents),
      thresholdPercent: paidThresholdPercent,
    });
    const posted = Number(highLevelPaymentEvents(lifecycleEvents).reduce((total, event) => total + event.amount, 0).toFixed(2));
    const received = Number(lifecycleEvents.filter((event) => event.source === "payer").reduce((total, event) => total + numberValue(event.amount), 0).toFixed(2));
    return {
      ...claim,
      paidAmount: posted,
      receivedAmount: received,
      paidPercent: claim.billedAmount > 0 ? posted / claim.billedAmount : 0,
      cptPayments: cptPaymentSummary(claim.latestChargeByCpt, lifecycleEvents),
      ...paymentTiming,
      currentStatus: status,
      issueLabel: currentIssue(events, status),
      events,
    };
  });
  const totalPages = Math.max(1, Math.ceil(result.total / limit));
  return {
    start,
    end,
    limit,
    page,
    offset: (page - 1) * limit,
    totalPages,
    sort,
    procedureQuery,
    paidThresholdPercent,
    total: result.total,
    claims,
  };
}

export function buildClaimIcuResponse(result, {
  today = todayDate(),
  limit = 25,
  page = 1,
  sort = "deadline",
  includePastDeadline = false,
  procedureQuery = "",
  owners = [],
  ownerStatus = "ready",
  calculateExpected = calculateExpectedReimbursement,
} = {}) {
  const ownerByClaim = new Map();
  for (const owner of owners) {
    const key = normalizeIdentifier(owner.claimId);
    if (!key) continue;
    const current = ownerByClaim.get(key);
    if (!current) {
      ownerByClaim.set(key, {
        ...owner,
        worklistTypes: owner.worklistType ? [owner.worklistType] : [],
        worklistCount: 1,
      });
      continue;
    }
    const worklistTypes = [...new Set([
      ...current.worklistTypes,
      ...(owner.worklistType ? [owner.worklistType] : []),
    ])];
    ownerByClaim.set(key, {
      ...current,
      ownerId: current.ownerId === owner.ownerId ? current.ownerId : null,
      ownerName: current.ownerName === owner.ownerName ? current.ownerName : "Multiple owners",
      worklistType: worklistTypes.join(", ") || null,
      worklistTypes,
      worklistCount: current.worklistCount + 1,
    });
  }
  const claims = result.claims.map((claim) => {
    const expected = calculateExpected({
      payerNames: [claim.payer],
      cptFinancials: claim.cptFinancials,
    });
    const expectedRemaining = expected.total == null
      ? null
      : Math.max(0, expected.total - numberValue(claim.paidAmount));
    const recoveryAmount = expectedRemaining == null
      ? null
      : roundedMoney(Math.min(Math.max(0, numberValue(claim.outstandingArAmount)), expectedRemaining));
    const assignment = ownerByClaim.get(normalizeIdentifier(claim.claimId));
    const cptDetails = claim.cptFinancials.map((line, index) => {
      const reimbursement = expected.breakdown?.[index] || {};
      const postedAmount = roundedMoney(numberValue(line.postedAmount));
      const cptOutstandingArAmount = roundedMoney(numberValue(line.outstandingArAmount));
      const cptExpectedRemaining = reimbursement.expected == null
        ? null
        : Math.max(0, reimbursement.expected - postedAmount);
      const cptRecoveryAmount = cptExpectedRemaining == null
        ? null
        : roundedMoney(Math.min(Math.max(0, cptOutstandingArAmount), cptExpectedRemaining));
      return Object.freeze({
        procedure: line.procedure,
        units: line.units,
        chargedAmount: roundedMoney(numberValue(line.charged)),
        postedAmount,
        outstandingArAmount: cptOutstandingArAmount,
        expectedReimbursement: reimbursement.expected ?? null,
        ratePerUnit: reimbursement.ratePerUnit ?? null,
        recoveryAmount: cptRecoveryAmount,
      });
    });
    return {
      ...claim,
      ageDays: claim.serviceDate ? elapsedDays(claim.serviceDate, today) : null,
      daysToDeadline: calendarDaysBetween(today, claim.deadlineDate),
      expectedReimbursement: expected.total,
      expectedReimbursementComplete: expected.complete,
      recoveryAmount,
      cptDetails,
      ownerAssigned: Boolean(assignment),
      owner: assignment ? {
        id: assignment.ownerId || null,
        name: assignment.ownerName || null,
        worklistType: assignment.worklistType || null,
        worklistCount: assignment.worklistCount || 1,
      } : null,
    };
  });
  return {
    today,
    limit,
    page,
    offset: (page - 1) * limit,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / limit)),
    sort,
    includePastDeadline,
    procedureQuery,
    ownerStatus,
    claims,
  };
}

export async function getClaimIcu(query = {}, options = {}) {
  const limit = Number(query.limit || 25);
  if (!ALLOWED_LIMITS.has(limit)) throw inputError("Rows must be 10, 25, 50, or 100.");
  const page = Number(query.page || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) {
    throw inputError("Page must be a whole number from 1 to 100,000.");
  }
  const sort = String(query.sort || "deadline");
  if (!ALLOWED_ICU_SORTS.has(sort)) throw inputError("Choose a valid Claim ICU priority.");
  const includePastDeadline = queryBoolean(query.includePastDeadline);
  const procedureQuery = highLevelProcedureQuery(query.procedureQuery);
  const offset = (page - 1) * limit;
  const cache = options.cache || claimIcuCache;
  const runReadOnly = options.withReadOnlySession || withReadOnlySession;
  const readIcu = options.readClaimIcu || readClaimIcu;
  const cacheKey = `${limit}:${page}:${sort}:${includePastDeadline}:${procedureQuery}`;
  const result = await cache.getOrLoad(
    cacheKey,
    () => runReadOnly((session) => readIcu(session, {
      limit,
      offset,
      sort,
      includePastDeadline,
      procedureQuery,
    })),
    cacheLogger("claim-icu"),
  );

  let owners = [];
  let ownerStatus = "ready";
  try {
    const readOwners = options.listClaimWorklistOwners || listClaimWorklistOwners;
    owners = await readOwners(result.claims.map(({ claimId }) => claimId), options.repositoryOptions);
  } catch (error) {
    ownerStatus = "unavailable";
    console.error("[claim-icu:owners] lookup failed", {
      code: error?.code || error?.databaseCode || null,
      name: error?.name || "Error",
    });
  }

  return buildClaimIcuResponse(result, {
    today: (options.today || todayDate)(),
    limit,
    page,
    sort,
    includePastDeadline,
    procedureQuery,
    owners,
    ownerStatus,
    calculateExpected: options.calculateExpected || calculateExpectedReimbursement,
  });
}

export async function getHighLevelDashboard(query) {
  const start = validDate(query.start, "Start date");
  const end = validDate(query.end, "End date");
  if (start > end) throw inputError("Start date must be on or before end date.");
  const dayCount = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  if (dayCount > 3_650) throw inputError("Dashboard ranges cannot exceed 3,650 days.");
  const billingMode = String(query.billingMode || "all");
  if (!ALLOWED_DASHBOARD_BILLING_MODES.has(billingMode)) throw inputError("Choose a valid dashboard billing mode.");
  const payers = dashboardPayerSelection(query.payer);
  const procedureQuery = highLevelProcedureQuery(query.procedureQuery);
  const cacheKey = `${start}:${end}`;
  const result = await dashboardCache.getOrLoad(
    cacheKey,
    () => withReadOnlySession((session) => readHighLevelDashboard(session, { start, end })),
    cacheLogger("dashboard"),
  );
  return buildHighLevelDashboardResponse(result, { start, end, billingMode, payers, procedureQuery });
}

export async function getHighLevelClaims(query) {
  const start = validDate(query.start, "Start date");
  const end = validDate(query.end, "End date");
  if (start > end) throw inputError("Start date must be on or before end date.");
  const limit = Number(query.limit || 25);
  if (!ALLOWED_LIMITS.has(limit)) throw inputError("Rows must be 10, 25, 50, or 100.");
  const page = Number(query.page || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) {
    throw inputError("Page must be a whole number from 1 to 100,000.");
  }
  const offset = (page - 1) * limit;
  const sort = String(query.sort || "youngest");
  if (!ALLOWED_SORTS.has(sort)) throw inputError("Choose a valid claim sort.");
  const procedureQuery = highLevelProcedureQuery(query.procedureQuery);
  const cacheKey = `${start}:${end}:${limit}:${page}:${sort}:${procedureQuery}`;
  const result = await highLevelClaimsCache.getOrLoad(
    cacheKey,
    () => withReadOnlySession((session) => readHighLevelClaims(session, {
      start,
      end,
      limit,
      offset,
      sort,
      procedureQuery,
    })),
    cacheLogger("high-level-claims"),
  );
  return buildHighLevelResponse(result, { start, end, limit, page, sort, procedureQuery });
}

export function buildAgingResponse(result, mode, today = todayDate(), options = {}) {
  const anchor = mode === "unsubmitted" ? "serviceDate" : "submittedDate";
  const order = options.order || "oldest";
  return {
    mode,
    today,
    start: options.start || null,
    end: options.end || null,
    order,
    scope: options.scope || "all",
    truncated: result.truncated,
    scanned: result.scanned,
    items: result.items.map((item) => ({ ...item, elapsedDays: elapsedDays(item[anchor], today) }))
      .sort((left, right) => (order === "youngest"
        ? left.elapsedDays - right.elapsedDays
        : right.elapsedDays - left.elapsedDays) || left.claimId.localeCompare(right.claimId)),
  };
}

export async function getUnsubmittedAppointments(query = {}) {
  const filters = queueFilters(query, "unsubmitted");
  const cacheKey = `${filters.start}:${filters.end}:${filters.order}:${filters.scope}`;
  const result = await unsubmittedCache.getOrLoad(
    cacheKey,
    () => withReadOnlySession((session) => readUnsubmittedAppointments(session, filters)),
    cacheLogger("unsubmitted"),
  );
  return buildAgingResponse(result, "unsubmitted", todayDate(), filters);
}

export async function getClaimsWithoutResponse(query = {}) {
  const filters = queueFilters(query, "no-response");
  const startedAt = Date.now();
  let lastStage = "request:start";
  const logProgress = (stage, details = {}) => {
    lastStage = stage;
    console.info(`[high-level:no-response] ${stage}`, details);
  };

  logProgress("request:start", filters);
  try {
    const cacheKey = `${filters.start}:${filters.end}:${filters.order}:${filters.scope}`;
    const result = await noResponseCache.getOrLoad(
      cacheKey,
      () => withReadOnlySession((session) => (
        readClaimsWithoutResponse(session, filters, logProgress)
      )),
      (stage, details) => {
        logProgress(stage, details);
        if (stage.startsWith("cache:")) cacheLogger("no-response")(stage, details);
      },
    );
    const response = buildAgingResponse(result, "no-response", todayDate(), filters);
    logProgress("request:complete", {
      durationMs: Date.now() - startedAt,
      returnedCount: response.items.length,
      scannedCount: response.scanned,
      truncated: response.truncated,
    });
    return response;
  } catch (error) {
    console.error("[high-level:no-response] request:failed", {
      stage: lastStage,
      durationMs: Date.now() - startedAt,
      name: error?.name || "Error",
      code: error?.code || null,
      message: error?.message || "Unknown error",
    });
    throw error;
  }
}
