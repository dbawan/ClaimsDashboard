import { centsToAmount, moneyToCents, normalizeDate } from "../lib/claimIdentity.js";
import { calculateExpectedReimbursement } from "./expectedReimbursementService.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const easternCalendar = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "America/New_York",
});

function calendarDate(value = new Date()) {
  if (typeof value === "string") return normalizeDate(value);
  const parts = Object.fromEntries(
    easternCalendar.formatToParts(value).map(({ type, value: part }) => [type, part]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateNumber(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  return Math.round((dateNumber(endDate) - dateNumber(startDate)) / DAY_MS);
}

function addDays(value, days) {
  if (!value) return null;
  return new Date(dateNumber(value) + days * DAY_MS).toISOString().slice(0, 10);
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function latestAppealResponse(comments = []) {
  return comments
    .filter(({ category }) => category === "appeal_follow_up_or_status")
    .map((comment) => normalizeDate(comment.createdAt || comment.date))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function latestTouch(lifecycle) {
  const transactionDate = normalizeDate(lifecycle.claimVitalSources?.lastTransactionDate);
  const commentDate = (lifecycle.comments || [])
    .map((comment) => normalizeDate(comment.createdAt || comment.date))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return [transactionDate, commentDate].filter(Boolean).sort().at(-1) || null;
}

function filingStart(lifecycle, serviceDate) {
  const latestReset = [
    normalizeDate(lifecycle.claimVitalSources?.latestAppealRebillDate),
    ...(lifecycle.comments || [])
      .filter(({ category }) => (
        category === "appeal_submitted" || category === "corrected_claim_or_rebill"
      ))
      .map((comment) => normalizeDate(comment.createdAt || comment.date)),
  ].filter(Boolean).sort().at(-1);

  if (latestReset && (!serviceDate || latestReset >= serviceDate)) {
    return { filingStartDate: latestReset, filingStartReason: "appeal_or_rebill" };
  }
  return { filingStartDate: serviceDate, filingStartReason: serviceDate ? "service_date" : null };
}

function outstandingAr(summary = {}) {
  // Flatten's Adjustments is the booked charge reduction, deduplicated per line
  // in summary; ERA reason amounts and comment text must not be counted again.
  const charges = moneyToCents(summary.charges);
  const paid = moneyToCents(summary.totalPaid);
  const writeOffs = moneyToCents(summary.adjustments);
  if (charges == null || paid == null || writeOffs == null) return null;
  return centsToAmount(charges - paid - writeOffs);
}

export function buildClaimVitals(lifecycle, { referenceDate = new Date() } = {}) {
  const asOfDate = calendarDate(referenceDate);
  const serviceDate = normalizeDate(lifecycle.claim?.serviceDate);
  const lastTouchDate = latestTouch(lifecycle);
  const originalCharge = finiteNumber(lifecycle.claimVitalSources?.originalCharge);
  const appealResponseDate = latestAppealResponse(lifecycle.comments);
  const filing = filingStart(lifecycle, serviceDate);
  const filingLimitDate = addDays(filing.filingStartDate, 90);
  const filingLimitDaysLeft = filingLimitDate ? daysBetween(asOfDate, filingLimitDate) : null;
  const appealDeadline = filingLimitDate;
  const expectedReimbursement = calculateExpectedReimbursement({
    payerNames: lifecycle.claimVitalSources?.payerNames,
    cptFinancials: lifecycle.cptFinancials,
  });

  return Object.freeze({
    asOfDate,
    claimAgeDays: serviceDate ? Math.max(0, daysBetween(serviceDate, asOfDate)) : null,
    daysSinceTouch: lastTouchDate ? Math.max(0, daysBetween(lastTouchDate, asOfDate)) : null,
    lastTouchDate,
    outstandingArAmount: outstandingAr(lifecycle.summary),
    originalCharge,
    expectedReimbursement: expectedReimbursement.total,
    expectedReimbursementBreakdown: expectedReimbursement.breakdown,
    expectedReimbursementMatchedCptCount: expectedReimbursement.matchedCptCount,
    expectedReimbursementTotalCptCount: expectedReimbursement.totalCptCount,
    expectedReimbursementComplete: expectedReimbursement.complete,
    expectedReimbursementPayer: expectedReimbursement.payer,
    paid: finiteNumber(lifecycle.summary?.totalPaid),
    attempts: finiteNumber(lifecycle.claimVitalSources?.attempts),
    ...filing,
    filingLimitDate,
    filingLimitDaysLeft,
    appealResponseDate,
    appealDeadline,
    appealDaysLeft: filingLimitDaysLeft,
  });
}

export function attachClaimVitals(lifecycle, options = {}) {
  return {
    ...lifecycle,
    claimVitals: buildClaimVitals(lifecycle, options),
  };
}
