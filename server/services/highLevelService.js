import { withReadOnlySession } from "../db/readOnlyPool.js";
import {
  readClaimsWithoutResponse,
  readHighLevelDashboard,
  readHighLevelClaims,
  readUnsubmittedAppointments,
} from "../repositories/highLevelRepository.js";
import { createTtlCache } from "../lib/ttlCache.js";
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
export const MYSQL_HIGH_LEVEL_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const highLevelClaimsCache = createTtlCache({ ttlMs: MYSQL_HIGH_LEVEL_CACHE_TTL_MS });
const unsubmittedCache = createTtlCache({ ttlMs: MYSQL_HIGH_LEVEL_CACHE_TTL_MS });
const noResponseCache = createTtlCache({ ttlMs: MYSQL_HIGH_LEVEL_CACHE_TTL_MS });
const dashboardCache = createTtlCache({ ttlMs: MYSQL_HIGH_LEVEL_CACHE_TTL_MS });

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

function elapsedDays(date, today) {
  if (!date) return 0;
  return Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000));
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
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

function dashboardEraSignature(row) {
  return [
    row.source,
    row.reference,
    row.date,
    row.serviceDate,
    row.procedure,
    row.modifier,
    row.lineNumber,
    row.charge,
    row.paid,
    row.allowed,
    row.reasons.join(","),
    row.payer,
    row.traceNumber,
  ].join("|");
}

function distinctDashboardEraRows(rows) {
  const seenWithinSource = new Set();
  const result = [];

  for (const row of [...rows].sort((left, right) => left.sourceRank - right.sourceRank)) {
    const signature = dashboardEraSignature(row);
    if (seenWithinSource.has(signature)) continue;
    seenWithinSource.add(signature);

    const duplicate = result.some((other) => {
      if (other.source === row.source || other.paid !== row.paid) return false;
      if (other.procedure !== row.procedure) return false;
      if (other.serviceDate && row.serviceDate && other.serviceDate !== row.serviceDate) return false;
      const sameTrace = Boolean(other.traceNumber && row.traceNumber && other.traceNumber === row.traceNumber);
      const sameReference = Boolean(other.reference && row.reference && other.reference === row.reference);
      const sameDateAndReason = other.date === row.date
        && other.payer === row.payer
        && other.reasons.join(",") === row.reasons.join(",");
      return sameTrace || (sameReference && sameDateAndReason);
    });
    if (!duplicate) result.push(row);
  }
  return result;
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
}) {
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
    ...(result.claimStatusRows || []).map((row) => normalizeDashboardEraRow(row, "claim-status", 0)),
    ...(result.ediRows || []).map((row) => normalizeDashboardEraRow(row, "edi-835", 1)),
  ]).filter((row) => row.date && daily.has(row.date));
  const payerContext = dashboardPayerContext(billedRows, allEraRows);
  const payerOptions = payerContext.options;
  const selectedPayers = [...new Set(
    payers.map(dashboardPayerKey).filter((payer) => payerOptions.some((option) => option.key === payer)),
  )];
  const payerFilter = new Set(selectedPayers);
  const includesBilledPayer = (payer) => !payerFilter.size || payerFilter.has(dashboardPayerKey(payer));
  const includesEraPayer = (row) => !payerFilter.size || payerFilter.has(payerContext.eraPayerKey(row));

  for (const row of billedRows.filter((row) => includesBilledPayer(row.payer))) {
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

  const eraRows = allEraRows.filter(includesEraPayer);
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

  const dailyPoints = [...daily.values()].map((point) => ({
    date: point.date,
    billed: point.billed,
    paid: point.paid,
    recouped: point.recouped,
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
    payerOptions,
    selectedPayers,
    totals: {
      billed: Number(dailyPoints.reduce((total, point) => total + point.billed, 0).toFixed(2)),
      paid: Number(dailyPoints.reduce((total, point) => total + point.paid, 0).toFixed(2)),
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
  paid: 4,
  reversed: 5,
  processed: 6,
});

export function buildHighLevelResponse(result, { start, end, limit, sort = "youngest" }) {
  const eventsByClaim = new Map();
  for (const event of result.events) {
    if (!eventsByClaim.has(event.claimId)) eventsByClaim.set(event.claimId, []);
    eventsByClaim.get(event.claimId).push(event);
  }
  const claims = result.claims.map((claim) => {
    const events = (eventsByClaim.get(claim.claimId) || [])
      .sort((left, right) => left.date.localeCompare(right.date)
        || (EVENT_PRIORITY[left.status] ?? 99) - (EVENT_PRIORITY[right.status] ?? 99)
        || left.label.localeCompare(right.label));
    const status = currentStatus(events);
    return { ...claim, currentStatus: status, issueLabel: currentIssue(events, status), events };
  });
  return { start, end, limit, sort, total: result.total, claims };
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
  const cacheKey = `${start}:${end}`;
  const result = await dashboardCache.getOrLoad(
    cacheKey,
    () => withReadOnlySession((session) => readHighLevelDashboard(session, { start, end })),
    cacheLogger("dashboard"),
  );
  return buildHighLevelDashboardResponse(result, { start, end, billingMode, payers });
}

export async function getHighLevelClaims(query) {
  const start = validDate(query.start, "Start date");
  const end = validDate(query.end, "End date");
  if (start > end) throw inputError("Start date must be on or before end date.");
  const limit = Number(query.limit || 25);
  if (!ALLOWED_LIMITS.has(limit)) throw inputError("Rows must be 10, 25, 50, or 100.");
  const sort = String(query.sort || "youngest");
  if (!ALLOWED_SORTS.has(sort)) throw inputError("Choose a valid claim sort.");
  const cacheKey = `${start}:${end}:${limit}:${sort}`;
  const result = await highLevelClaimsCache.getOrLoad(
    cacheKey,
    () => withReadOnlySession((session) => readHighLevelClaims(session, {
      start,
      end,
      limit,
      sort,
    })),
    cacheLogger("high-level-claims"),
  );
  return buildHighLevelResponse(result, { start, end, limit, sort });
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
