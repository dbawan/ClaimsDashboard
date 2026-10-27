import { moneyToCents, normalizeDate, normalizeIdentifier } from "./claimIdentity.js";
const SOURCE_LABELS = { claimStatus: "ClaimStatus ERA", edi835: "EDI 835 ERA" };
const SOURCE_RANK = { advancedMd: 0, claimStatus: 1, edi835: 2 };
const text = (value) => String(value ?? "").trim() || null;
const compact = (values) => [...new Set(values.map(text).filter(Boolean))];
const dateTime = (value) => normalizeDate(value);
const normalizedUnits = (value) => value == null || value === "" ? "" : String(Number(value));
const stableKey = (parts) => parts.map((part) => String(part ?? "").trim().toUpperCase()).join("|");

export const ADVANCED_MD_CLAIM_OFFSET = 40_000;

export function advancedMdEraRows(rows = []) {
  const claims = new Map();
  for (const row of rows) {
    const key = stableKey([row.licenseKey, row.eraClaimId]);
    if (!claims.has(key)) claims.set(key, new Map());
    claims.get(key).set(String(row.detailId ?? "claim-only"), row);
  }
  const result = [];
  for (const [key, details] of claims) {
    const first = details.values().next().value;
    const base = {
      sourceType: "advancedMd", source: "AdvancedMD ERA", sourceRank: 0,
      claimReference: text(first.reference), payerClaimControl: text(first.payerClaimControl),
      eventDate: normalizeDate(first.eventDate), createdAt: normalizeDate(first.receivedAt),
      receivedAt: first.receivedAt, payer: text(first.payer), remitId: text(first.traceNumber),
      remittanceKey: key, postFailed: Boolean(first.postFailed), dismissedAt: first.dismissedAt,
      claimStatus: text(first.claimStatus), primaryPaidCents: null,
    };
    let lineTotal = 0;
    for (const row of details.values()) {
      if (row.detailId == null) continue;
      const paidCents = moneyToCents(row.paid) || 0;
      lineTotal += paidCents;
      const chargeId = /^\d+$/.test(String(row.chargeId)) && Number(row.chargeId) > 0
        ? String(row.chargeId) : null;
      result.push({ ...base, rowId: `${key}:${row.detailId}`,
        serviceDate: normalizeDate(row.serviceDate), procedure: normalizeIdentifier(row.procedureCode),
        modifier: "", units: "", lineNumber: chargeId, chargeId,
        flattenedClaimId: chargeId ? String(Number(chargeId) + ADVANCED_MD_CLAIM_OFFSET) : null,
        chargeCents: moneyToCents(row.charge), allowedCents: moneyToCents(row.allowed),
        patientResponsibilityCents: moneyToCents(row.patientResponsibility),
        adjustedCents: moneyToCents(row.adjusted), paidCents, adjustment: text(row.reason) || "",
      });
    }
    const claimTotal = moneyToCents(first.claimPaid);
    // Preserve claim-only remittances and any header/line difference without
    // assigning it to a CPT or counting the claim header again for every line.
    if (first.detailId == null || (claimTotal != null && claimTotal !== lineTotal)) {
      result.push({ ...base, rowId: `${key}:claim-balance`, serviceDate: null,
        procedure: "", modifier: "", units: "", lineNumber: null, chargeCents: null,
        allowedCents: null, paidCents: (claimTotal ?? lineTotal) - lineTotal,
        adjustment: first.detailId == null ? "Claim-level remittance; service lines unavailable"
          : "Claim payment differs from service-line total; unallocated difference",
        claimLevelOnly: true,
      });
    }
  }
  return result;
}

function parseAdjustmentCodes(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [String(value)];
    return parsed.map((item) =>
      [item.group, item.reason, item.amount].filter((entry) => entry != null).join(" "),
    );
  } catch {
    return String(value).split(",").map((item) => item.trim()).filter(Boolean);
  }
}


function adjustmentText(value) {
  return parseAdjustmentCodes(value).join(", ");
}


export function claimStatusEraRows(rows) {
  return rows.map((row, index) => ({
    rowId: text(row.ClaimStatusId) || String(index),
    sourceType: "claimStatus",
    source: SOURCE_LABELS.claimStatus,
    sourceRank: SOURCE_RANK.claimStatus,
    claimReference: text(row.PatientControlNumber),
    payerClaimControl: text(row.ClaimNumber),
    patientName: text(row.PatientName),
    createdAt: dateTime(row.ImportedAtUtc),
    eventDate: dateTime(row.CheckEftDate) || dateTime(row.EobTransactionDate)
      || dateTime(row.ImportedAtUtc) || normalizeDate(row.DateOfServiceStart),
    serviceDate: normalizeDate(row.DateOfServiceStart),
    procedure: normalizeIdentifier(row.AdjudProcedure || row.SubProcedure),
    modifier: normalizeIdentifier(row.AdjudModifier || row.SubModifier),
    units: normalizedUnits(row.AdjudUnits || row.SubUnits),
    lineNumber: text(row.LineControlNumber),
    chargeCents: moneyToCents(row.ChargeAmount),
    paidCents: moneyToCents(row.Payment) || 0,
    primaryPaidCents: null,
    allowedCents: moneyToCents(row.AllowedAmount),
    adjustment: text(row.AdjustmentCodes) || text(row.ChargeAdjustments) || "",
    payer: text(row.PayerName),
    remitId: text(row.CheckEftTraceNumber),
  }));
}

export function ediEraRows(rows) {
  return rows.map((row, index) => ({
    rowId: text(row.id) || String(index),
    sourceType: "edi835",
    source: SOURCE_LABELS.edi835,
    sourceRank: SOURCE_RANK.edi835,
    claimReference: text(row.patient_control_number),
    payerClaimControl: text(row.payer_claim_control),
    patientName: compact([row.patient_first, row.patient_last]).join(" ") || null,
    createdAt: normalizeDate(row.claim_received_date),
    eventDate: normalizeDate(row.payment_date) || normalizeDate(row.claim_received_date)
      || normalizeDate(row.service_date || row.statement_from_date),
    serviceDate: normalizeDate(row.service_date || row.statement_from_date),
    procedure: normalizeIdentifier(row.service_code),
    modifier: normalizeIdentifier(row.modifiers),
    units: normalizedUnits(row.units),
    lineNumber: text(row.reference_id),
    chargeCents: moneyToCents(row.charge_amount),
    paidCents: moneyToCents(row.paid_amount) || 0,
    primaryPaidCents: null,
    allowedCents: moneyToCents(row.allowed_amount),
    adjustment: adjustmentText(row.service_adjustments),
    payer: text(row.payer_name),
    remitId: text(row.trace_number),
  }));
}

function lineKey(row) {
  return stableKey([
    row.serviceDate,
    row.procedure,
    row.modifier,
    row.units,
  ]);
}

function lineCompatible(left, right) {
  if (left.serviceDate && right.serviceDate && left.serviceDate !== right.serviceDate) return false;
  if (left.procedure && right.procedure && left.procedure !== right.procedure) return false;
  if (left.modifier && right.modifier && left.modifier !== right.modifier) return false;
  if (left.units && right.units && left.units !== right.units) return false;
  if (left.procedure && right.procedure) return true;
  return Boolean(
    left.lineNumber
    && right.lineNumber
    && normalizeIdentifier(left.lineNumber) === normalizeIdentifier(right.lineNumber),
  );
}

function eraSignature(row) {
  return stableKey([
    row.sourceType,
    row.claimReference,
    row.sourceType === "advancedMd" ? row.rowId : "",
    row.eventDate,
    lineKey(row),
    normalizeIdentifier(row.lineNumber),
    row.chargeCents,
    row.paidCents,
    row.primaryPaidCents,
    row.allowedCents,
    normalizeIdentifier(row.payer),
    normalizeIdentifier(row.remitId),
    row.adjustment,
  ]);
}

// Deduplicate complete remittance copies first, then match remaining service lines
// one-to-one across sources. Claim identity is required even when a check is shared.
export function distinctEraRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = stableKey([row.sourceType, row.remittanceKey || "", row.claimReference,
      row.payerClaimControl, row.remitId, normalizeDate(row.eventDate)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const chosenGroups = [];
  const groupsByClaim = new Map();
  let duplicateCount = 0;
  for (const group of [...groups.values()].sort((a, b) => a[0].sourceRank - b[0].sourceRank)) {
    const first = group[0];
    const total = group.reduce((sum, row) => sum + row.paidCents, 0);
    const claimKey = normalizeIdentifier(first.claimReference);
    const candidates = groupsByClaim.get(claimKey) || [];
    const duplicate = candidates.find((other) => other[0].sourceType !== first.sourceType
      && sameRemittance(other[0], first)
      && other.reduce((sum, row) => sum + row.paidCents, 0) === total);
    if (duplicate) {
      duplicateCount += group.length;
      for (const row of duplicate) row.observedSources = compact([
        ...(row.observedSources || [row.source]), first.source,
      ]);
    } else {
      const copy = group.map((row) => ({ ...row }));
      chosenGroups.push(copy);
      candidates.push(copy);
      groupsByClaim.set(claimKey, candidates);
    }
  }
  const result = [];
  const linesByClaim = new Map();
  const seen = new Set();
  for (const row of chosenGroups.flat()) {
    const signature = eraSignature(row);
    if (seen.has(signature)) { duplicateCount += 1; continue; }
    seen.add(signature);
    const claimKey = normalizeIdentifier(row.claimReference);
    const candidates = linesByClaim.get(claimKey) || [];
    const duplicate = candidates.find((other) => other.sourceType !== row.sourceType
      && !other.matchedSources.has(row.sourceType)
      && sameRemittance(other, row) && lineCompatible(other, row)
      && other.paidCents === row.paidCents);
    if (duplicate) {
      duplicateCount += 1;
      duplicate.matchedSources.add(row.sourceType);
      duplicate.observedSources = compact([...duplicate.observedSources, row.source]);
    } else {
      const copy = { ...row, observedSources: row.observedSources || [row.source],
        matchedSources: new Set([row.sourceType]) };
      result.push(copy);
      candidates.push(copy);
      linesByClaim.set(claimKey, candidates);
    }
  }
  return { rows: result.map(({ matchedSources, ...row }) => row), duplicateCount };
}

function sameRemittance(left, right) {
  if (normalizeIdentifier(left.claimReference) !== normalizeIdentifier(right.claimReference)) return false;
  if (left.payerClaimControl && right.payerClaimControl
    && normalizeIdentifier(left.payerClaimControl) !== normalizeIdentifier(right.payerClaimControl)) return false;
  if (left.remitId && right.remitId) return normalizeIdentifier(left.remitId) === normalizeIdentifier(right.remitId);
  return Boolean(left.eventDate && right.eventDate && left.payer && right.payer)
    && normalizeDate(left.eventDate) === normalizeDate(right.eventDate)
    && normalizeIdentifier(left.payer) === normalizeIdentifier(right.payer)
    && left.adjustment === right.adjustment;
}
