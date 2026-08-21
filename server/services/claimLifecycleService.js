import { withReadOnlySession } from "../db/readOnlyPool.js";
import {
  assertValidClaimSearch,
  centsToAmount,
  moneyToCents,
  normalizeDate,
  normalizeIdentifier,
  normalizePatientName,
  submissionOrder,
  submissionSuffix,
} from "../lib/claimIdentity.js";
import { PATIENT_INVOICE_CPT_MAPPINGS } from "../lib/patientInvoiceMatching.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { readClaimSources } from "../repositories/claimRepository.js";
import {
  attachClaimCategorization,
  enrichClaimWithCategorization,
} from "./claimCategorizationService.js";
import { enrichClaimWithComments } from "./claimCommentService.js";

export const MYSQL_CLAIM_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const mysqlClaimCache = createTtlCache({ ttlMs: MYSQL_CLAIM_CACHE_TTL_MS });

const SOURCE_LABELS = Object.freeze({
  transaction: "FlattenTransctions2",
  claimStatus: "ClaimStatus ERA",
  edi835: "EDI 835 ERA",
  priorAuthorization: "EHR prior authorization",
  patientInvoices: "Patient invoices",
  combined: "Combined sources",
});

const SOURCE_RANK = Object.freeze({ claimStatus: 0, edi835: 1, transaction: 2 });

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function dateTime(value) {
  if (value == null || value === "") return null;
  const stringValue = String(value).trim();
  const date = normalizeDate(stringValue);
  if (!date) return null;
  const time = stringValue.match(/[T ](\d{2}:\d{2}:\d{2})/)?.[1];
  return time && time !== "00:00:00" ? `${date}T${time}` : date;
}

function compact(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function stableKey(parts) {
  return parts
    .map((part) => String(part ?? "").trim().toUpperCase() || "-")
    .join("|");
}

function firstDate(values) {
  return compact(values).sort()[0] || null;
}

function normalizedMoney(value) {
  const cents = moneyToCents(value);
  return cents == null ? "" : String(cents);
}

function normalizedUnits(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "";
}

function aggregateLineMoney(rows, field) {
  const lines = new Map();
  for (const row of rows) {
    const key = stableKey([
      normalizeDate(row.DATEOFSERVICE),
      row.PROCEDURECODE,
      row.MOD1,
      row.MOD2,
      row.MOD3,
      row.MOD4,
      normalizedUnits(row.UNIT),
      normalizedMoney(row.Charges),
    ]);
    if (!lines.has(key)) lines.set(key, moneyToCents(row[field]) || 0);
  }
  return [...lines.values()].reduce((total, cents) => total + cents, 0);
}

function cptChargeSummary(rows) {
  const serviceLines = new Map();
  for (const row of rows) {
    const procedure = normalizeIdentifier(row.PROCEDURECODE);
    if (!procedure) continue;
    const key = stableKey([
      normalizeDate(row.DATEOFSERVICE),
      procedure,
      row.MOD1,
      row.MOD2,
      row.MOD3,
      row.MOD4,
      normalizedUnits(row.UNIT),
      normalizedMoney(row.Charges),
    ]);
    if (!serviceLines.has(key)) {
      serviceLines.set(key, {
        procedure,
        chargeCents: moneyToCents(row.Charges) || 0,
      });
    }
  }

  const byProcedure = new Map();
  for (const line of serviceLines.values()) {
    byProcedure.set(
      line.procedure,
      (byProcedure.get(line.procedure) || 0) + line.chargeCents,
    );
  }
  return [...byProcedure]
    .map(([procedure, chargeCents]) => ({ procedure, charged: centsToAmount(chargeCents) }))
    .sort((left, right) => right.charged - left.charged
      || left.procedure.localeCompare(right.procedure));
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

function isPaymentEvent(eventType) {
  const value = String(eventType ?? "").toLowerCase();
  if (/patient responsibility|copay|coinsurance|deductible/.test(value)) return false;
  return /applied payment|payment applied|insurance payment|payment posted|payment received|remittance payment|paid transaction|receipt|payment/.test(value);
}

function isClaimCreatedEvent(eventType) {
  const normalized = String(eventType ?? "").toLowerCase().replaceAll("-", " ").trim().replace(/\s+/g, " ");
  return normalized === "claim created" || normalized === "created claim";
}

function eventStatus(title, amountCents = 0) {
  const normalized = normalizeIdentifier(title);
  if (amountCents < 0 || /DENI|REJECT|REVERS|VOID|UNRESOLVED/.test(normalized)) {
    return "danger";
  }
  if (/PAID|PAYMENT|SETTLED|ACCEPT|COMPLET/.test(normalized) && amountCents >= 0) {
    return "success";
  }
  if (/PENDING|RESPONSIBILITY|ADJUST|RESPONSE|REBILL|CORRECTION/.test(normalized)) {
    return "warning";
  }
  return "neutral";
}

function transactionSignature(row) {
  const transactionId = normalizeIdentifier(row.CLAIMTRANSACTIONID);
  if (transactionId) return stableKey(["id", transactionId]);
  return stableKey([
    "content",
    dateTime(row.POSTINGDATE),
    row.CLAIMTRANSACTIONTYPENAME,
    normalizedMoney(row.Amount),
    normalizeDate(row.DATEOFSERVICE),
    row.PROCEDURECODE,
    row.MOD1 || row.Modifiers,
    normalizedUnits(row.UNIT),
  ]);
}

function transactionEventKey(row, title, paymentEvent) {
  const eventDate = normalizeDate(row.POSTINGDATE) || normalizeDate(row.DATEOFSERVICE);
  const paymentId = normalizeIdentifier(row.PAYMENTID);
  if (paymentEvent && paymentId) {
    return stableKey([eventDate, title, "payment", paymentId]);
  }
  if (paymentEvent) {
    return stableKey([
      eventDate,
      title,
      "payment-without-id",
      row.PayerPlan1 || row.CompanyName1,
      row.PaymentNotes,
      row.NOTES,
    ]);
  }
  return stableKey([eventDate, title]);
}

function transactionEvents(rows) {
  const seen = new Set();
  const grouped = new Map();
  let duplicateCount = 0;

  for (const row of rows) {
    const signature = transactionSignature(row);
    if (seen.has(signature)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(signature);

    const title = text(row.CLAIMTRANSACTIONTYPENAME) || "Claim activity";
    const transactionType = normalizeIdentifier(title);
    const paymentEvent = isPaymentEvent(title);
    const amountCents = paymentEvent
      ? moneyToCents(row.Amount) ?? moneyToCents(row.Receipt) ?? moneyToCents(row.pay)
      : null;
    const procedure = normalizeIdentifier(row.PROCEDURECODE);
    const modifier = normalizeIdentifier(row.MOD1 || row.Modifiers);
    const key = transactionEventKey(row, title, paymentEvent);
    if (!grouped.has(key)) {
      grouped.set(key, {
        title,
        transactionType,
        paymentEvent,
        rows: [],
        lines: [],
      });
    }
    const group = grouped.get(key);
    group.rows.push(row);
    group.lines.push({
      amountCents,
      serviceDate: normalizeDate(row.DATEOFSERVICE),
      procedure,
      modifier,
      units: normalizedUnits(row.UNIT),
      lineNumber: text(row.PAYMENTCLAIMID),
      lineReferences: compact([row.CLAIMTRANSACTIONID, row.PAYMENTCLAIMID]),
    });
  }

  const events = [...grouped.values()].map((group, index) => {
    const first = group.rows[0];
    const payers = compact(group.rows.flatMap((row) => [row.PayerPlan1, row.CompanyName1]));
    const eobCodes = compact(group.rows.map((row) => row.EOB_INFO));
    const notes = compact(group.rows.flatMap((row) => [row.PaymentNotes, row.NOTES]));
    const serviceLineCount = group.lines.length;
    const details = compact([
      `${serviceLineCount} service line${serviceLineCount === 1 ? "" : "s"}`,
      payers.length ? `Payer ${payers.join(", ")}` : null,
      eobCodes.length ? `EOB ${eobCodes.join(", ")}` : null,
      ...notes,
    ]);
    const knownAmounts = group.lines
      .map((line) => line.amountCents)
      .filter((amount) => amount != null);
    const amountCents = group.paymentEvent && knownAmounts.length
      ? knownAmounts.reduce((total, amount) => total + amount, 0)
      : null;

    return {
      id: `transaction-event-${index}-${normalizeIdentifier(group.title)}`,
      date: dateTime(first.POSTINGDATE) || normalizeDate(first.DATEOFSERVICE),
      sortOrder: isClaimCreatedEvent(group.title) ? 0 : 30,
      title: isClaimCreatedEvent(group.title) ? "Claim created" : group.title,
      description: details.join(" · ") || "Activity recorded in FlattenTransctions2.",
      source: SOURCE_LABELS.transaction,
      sourceType: "transaction",
      status: eventStatus(group.title, amountCents || 0),
      amountCents,
      countedPaymentCents: 0,
      lineReferences: compact(group.lines.flatMap((line) => line.lineReferences)),
      transactionType: group.transactionType,
      paymentEvent: group.paymentEvent,
      lines: group.lines,
      paymentAuthority: "informational",
    };
  });

  return { events, duplicateCount };
}

function claimStatusEraRows(rows) {
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

function ediEraRows(rows) {
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

function distinctEraRows(rows) {
  const seenWithinSource = new Set();
  const result = [];
  let duplicateCount = 0;

  for (const row of [...rows].sort((left, right) => left.sourceRank - right.sourceRank)) {
    const signature = eraSignature(row);
    if (seenWithinSource.has(signature)) {
      duplicateCount += 1;
      continue;
    }
    seenWithinSource.add(signature);

    const crossDuplicate = result.find((other) => {
      if (other.sourceType === row.sourceType || !lineCompatible(other, row)) return false;
      const samePayment = other.paidCents === row.paidCents;
      const sameRemit = Boolean(
        other.remitId
        && row.remitId
        && normalizeIdentifier(other.remitId) === normalizeIdentifier(row.remitId),
      );
      const sameDate = Boolean(other.eventDate && row.eventDate && other.eventDate === row.eventDate);
      const samePayer = Boolean(
        other.payer
        && row.payer
        && normalizeIdentifier(other.payer) === normalizeIdentifier(row.payer),
      );
      const sameAdjustment = String(other.adjustment).toUpperCase() === String(row.adjustment).toUpperCase();
      return samePayment && (sameRemit || (sameDate && samePayer && sameAdjustment));
    });

    if (crossDuplicate) {
      duplicateCount += 1;
      crossDuplicate.observedSources = compact([
        ...(crossDuplicate.observedSources || [crossDuplicate.source]),
        row.source,
      ]);
    } else {
      result.push({ ...row, observedSources: [row.source] });
    }
  }

  return { rows: result, duplicateCount };
}

function formattedCents(cents) {
  return centsToAmount(cents).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function buildEraRecords(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = stableKey([
      row.sourceType,
      row.claimReference,
      row.payerClaimControl,
      row.remitId,
      normalizeDate(row.eventDate),
    ]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  return [...grouped.values()].map((groupRows, index) => {
    const first = groupRows[0];
    const paidCents = groupRows.reduce((total, row) => total + row.paidCents, 0);
    const chargeValues = groupRows
      .map((row) => row.chargeCents)
      .filter((amount) => amount != null);
    const chargeCents = chargeValues.length
      ? chargeValues.reduce((total, amount) => total + amount, 0)
      : null;
    const allowedValues = groupRows
      .map((row) => row.allowedCents)
      .filter((amount) => amount != null);
    const allowedCents = allowedValues.length
      ? allowedValues.reduce((total, amount) => total + amount, 0)
      : null;
    const payers = compact(groupRows.map((row) => row.payer));
    const observedSources = compact(groupRows.flatMap((row) => row.observedSources || [row.source]));
    const adjustments = compact(groupRows.map((row) => row.adjustment));
    const serviceDates = compact(groupRows.map((row) => row.serviceDate)).sort();
    const title = paidCents < 0
      ? "Payment reversed"
      : paidCents > 0
        ? "Payment received"
        : "Claim adjudicated";
    return {
      id: `era-record-${first.sourceType}-${index}`,
      date: first.eventDate,
      title,
      source: first.source,
      sourceType: first.sourceType,
      observedSources,
      status: eventStatus(title, paidCents),
      traceNumber: first.remitId,
      claimReference: first.claimReference,
      payerClaimControl: first.payerClaimControl,
      payers,
      serviceDates,
      adjustments,
      chargeCents,
      allowedCents,
      paidCents,
      lineReferences: compact(groupRows.map((row) => row.lineNumber)),
      serviceLines: groupRows.map((row) => ({
        id: `${row.sourceType}-${row.rowId}`,
        serviceDate: row.serviceDate,
        procedure: row.procedure,
        modifier: row.modifier,
        units: row.units || null,
        lineNumber: row.lineNumber,
        chargeCents: row.chargeCents,
        allowedCents: row.allowedCents,
        paidCents: row.paidCents,
        adjustment: row.adjustment || null,
      })),
    };
  }).sort((left, right) => compareEvents(
    { date: left.date, sortOrder: SOURCE_RANK[left.sourceType], id: left.id },
    { date: right.date, sortOrder: SOURCE_RANK[right.sourceType], id: right.id },
  ));
}

function eraEvents(records) {
  return records.map((record) => {
    const details = compact([
      record.claimReference ? `Submission/rebill ref ${record.claimReference}` : null,
      `${record.serviceLines.length} service line${record.serviceLines.length === 1 ? "" : "s"}`,
      record.serviceDates.length ? `DOS ${record.serviceDates.join(", ")}` : null,
      record.chargeCents != null ? `Billed ${formattedCents(record.chargeCents)}` : null,
      `Paid ${formattedCents(record.paidCents)}`,
      record.payers.length ? `Payer ${record.payers.join(", ")}` : null,
      record.adjustments.length ? `Codes/details ${record.adjustments.join("; ")}` : null,
      record.traceNumber ? `Trace ${record.traceNumber}` : null,
    ]);

    return {
      id: record.id.replace("era-record-", "era-event-"),
      date: record.date,
      sortOrder: 40,
      title: record.title,
      description: details.join(" · ") || "ERA adjudication received.",
      source: record.source,
      sourceType: record.sourceType,
      status: record.status,
      amountCents: record.paidCents,
      countedPaymentCents: record.paidCents,
      lineReferences: record.lineReferences,
      paymentAuthority: "era",
      traceNumber: record.traceNumber,
      claimReference: record.claimReference,
      cptPaymentLines: record.serviceLines.map((line) => ({
        procedure: line.procedure,
        countedPaymentCents: line.paidCents,
      })),
    };
  });
}

function paymentLineCompatible(transaction, era) {
  if (transaction.serviceDate && era.serviceDate && transaction.serviceDate !== era.serviceDate) {
    return false;
  }
  if (
    transaction.amountCents != null
    && transaction.amountCents !== 0
    && era.paidCents !== 0
    && transaction.amountCents === era.paidCents
  ) return true;
  if (!transaction.procedure || !era.procedure) return lineCompatible(transaction, era);
  if (transaction.procedure !== era.procedure) return false;
  if (transaction.modifier && era.modifier && transaction.modifier !== era.modifier) return false;
  return true;
}

function reconcilePayments(transactionTimeline, eraRows) {
  const nonzeroEraRows = eraRows.filter((row) => row.paidCents !== 0);
  let fallbackCents = 0;
  let matchedPostingCount = 0;

  for (const event of transactionTimeline) {
    if (!event.paymentEvent) continue;
    let matchedLineCount = 0;
    let fallbackLineCount = 0;
    let zeroLineCount = 0;
    let unavailableLineCount = 0;
    let eventFallbackCents = 0;

    for (const line of event.lines) {
      const authoritativeMatch = line.procedure || line.lineNumber
        ? nonzeroEraRows.some((era) => paymentLineCompatible(line, era))
        : nonzeroEraRows.length > 0;
      if (authoritativeMatch) matchedLineCount += 1;

      if (line.amountCents == null) {
        if (!authoritativeMatch) unavailableLineCount += 1;
      } else if (line.amountCents === 0) {
        zeroLineCount += 1;
      } else if (!authoritativeMatch) {
        fallbackLineCount += 1;
        eventFallbackCents += line.amountCents;
        line.countedPaymentCents = line.amountCents;
      }
    }

    if (matchedLineCount > 0) {
      matchedPostingCount += 1;
      event.paymentAuthority = "era-matched-posting";
      event.description += ` · ${matchedLineCount} service line${matchedLineCount === 1 ? "" : "s"} kept as posting-only because matching non-zero ERA data is authoritative.`;
    }
    if (fallbackLineCount > 0) {
      event.paymentAuthority = "transaction-fallback";
      fallbackCents += eventFallbackCents;
      event.countedPaymentCents = eventFallbackCents;
      event.description += ` · ${formattedCents(eventFallbackCents)} from ${fallbackLineCount} service line${fallbackLineCount === 1 ? "" : "s"} counted as payment fallback because no matching non-zero ERA was found.`;
    }
    if (zeroLineCount > 0) {
      event.description += ` · ${zeroLineCount} zero-dollar service line${zeroLineCount === 1 ? "" : "s"} not counted as payment.`;
    }
    if (unavailableLineCount > 0) {
      event.description += ` · ${unavailableLineCount} service line${unavailableLineCount === 1 ? " has" : "s have"} no available payment amount and no matching non-zero ERA.`;
    }
  }

  return { fallbackCents, matchedPostingCount };
}

function transactionPatientNames(rows) {
  return compact(rows.map((row) => compact([row.FIRSTNAME, row.LASTNAME]).join(" ")));
}

function sourcePatientNames(rows) {
  return compact(rows.map((row) => row.patientName));
}

function setDifference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

function buildSubmissionEvents(claimId, transactions, sourceEraRows) {
  const grouped = new Map();
  for (const row of sourceEraRows) {
    const reference = normalizeIdentifier(row.claimReference);
    if (submissionSuffix(claimId, reference) === null) continue;
    if (!grouped.has(reference)) grouped.set(reference, []);
    grouped.get(reference).push(row);
  }

  const anchorPatientValues = transactionPatientNames(transactions);
  const anchorPatientKeys = new Set(anchorPatientValues.map(normalizePatientName).filter(Boolean));
  const anchorDos = new Set(compact(transactions.map((row) => normalizeDate(row.DATEOFSERVICE))));
  const anchorCpts = new Set(compact(transactions.map((row) => normalizeIdentifier(row.PROCEDURECODE))));
  const warnings = [];

  const references = [...grouped.entries()].sort(([left], [right]) => {
    const leftSuffix = submissionSuffix(claimId, left) || "";
    const rightSuffix = submissionSuffix(claimId, right) || "";
    return submissionOrder(leftSuffix) - submissionOrder(rightSuffix) || left.localeCompare(right);
  });

  const events = references.map(([reference, rows], index) => {
    const suffix = submissionSuffix(claimId, reference) || "";
    const patientValues = sourcePatientNames(rows);
    const patientKeys = new Set(patientValues.map(normalizePatientName).filter(Boolean));
    const dos = new Set(compact(rows.map((row) => row.serviceDate)));
    const cpts = new Set(compact(rows.map((row) => row.procedure)));
    const sources = compact(rows.map((row) => row.source)).sort();
    const changes = [];

    if (stableKey([...patientKeys].sort()) !== stableKey([...anchorPatientKeys].sort())) {
      changes.push(
        `patient text differs (Flatten: ${anchorPatientValues.join(", ") || "missing"}; ERA: ${patientValues.join(", ") || "missing"})`,
      );
    }
    const addedDos = setDifference(dos, anchorDos);
    const absentDos = setDifference(anchorDos, dos);
    const addedCpts = setDifference(cpts, anchorCpts);
    const absentCpts = setDifference(anchorCpts, cpts);
    if (addedDos.length) changes.push(`DOS added ${addedDos.join(", ")}`);
    if (absentDos.length) changes.push(`DOS absent ${absentDos.join(", ")}`);
    if (addedCpts.length) changes.push(`CPT added ${addedCpts.join(", ")}`);
    if (absentCpts.length) changes.push(`CPT absent ${absentCpts.join(", ")}`);

    const logicalLabel = suffix
      ? `suffix ${suffix}, logical iteration ${submissionOrder(suffix)}`
      : "unsuffixed/original reference";
    let description = `Reference ${reference} first observed; ${logicalLabel}; source(s) ${sources.join(", ")}.`;
    if (changes.length) {
      const changeText = changes.join("; ");
      description += ` Informational changes versus Flatten: ${changeText}.`;
      warnings.push(
        `Reference ${reference} belongs to claim ${claimId} by ENCOUNTERID; informational differences: ${changeText}`,
      );
    }
    if (cpts.size) description += ` CPT set ${[...cpts].sort().join(", ")}.`;

    return {
      id: `submission-${reference}-${index}`,
      date: firstDate(rows.flatMap((row) => [row.eventDate, row.createdAt])),
      sortOrder: 10,
      title: "Submission/correction/rebill observed",
      description,
      source: SOURCE_LABELS.combined,
      sourceType: "combined",
      status: "warning",
      amountCents: null,
      paymentAuthority: "informational",
      submissionReference: reference,
      submissionSuffix: suffix,
    };
  });

  if (references.length === 0) {
    warnings.push("No ERA submission/rebill reference matched ENCOUNTERID; transaction payments are fallback data");
  } else if (references.length > 1) {
    warnings.push(`Linked ${references.length} ERA submission/rebill references to one ENCOUNTERID claim`);
  }

  return {
    events,
    warnings,
    references: references.map(([reference]) => reference),
  };
}

function serviceEvents(rows) {
  return compact(rows.map((row) => normalizeDate(row.DATEOFSERVICE))).sort().map((serviceDate) => ({
    id: `service-${serviceDate}`,
    date: serviceDate,
    sortOrder: 20,
    title: "Date of service",
    description: "Service date observed across the reconciled claim data.",
    source: SOURCE_LABELS.combined,
    sourceType: "combined",
    status: "neutral",
    amountCents: null,
    paymentAuthority: "informational",
  }));
}

function compareEvents(left, right) {
  const leftDate = left.date || "9999-12-31";
  const rightDate = right.date || "9999-12-31";
  return leftDate.localeCompare(rightDate)
    || left.sortOrder - right.sortOrder
    || left.id.localeCompare(right.id);
}

function publicEvent(event) {
  const cptPayments = (event.cptPaymentLines || event.lines || [])
    .filter((line) => line.procedure && line.countedPaymentCents)
    .map((line) => ({
      procedure: line.procedure,
      paid: centsToAmount(line.countedPaymentCents),
    }));
  return {
    id: event.id,
    date: event.date,
    title: event.title,
    description: event.description,
    source: event.source,
    status: event.status,
    amount: event.amountCents == null ? null : centsToAmount(event.amountCents),
    countedPayment: centsToAmount(event.countedPaymentCents || 0),
    paymentAuthority: event.paymentAuthority,
    submissionReference: event.submissionReference || null,
    cptPayments,
  };
}

function publicEraRecord(record) {
  return {
    id: record.id,
    date: record.date,
    title: record.title,
    source: record.source,
    sourceType: record.sourceType,
    observedSources: record.observedSources,
    status: record.status,
    submissionReference: record.claimReference,
    payerClaimNumber: record.payerClaimControl,
    traceNumber: record.traceNumber,
    payers: record.payers,
    serviceDates: record.serviceDates,
    lineCount: record.serviceLines.length,
    billed: record.chargeCents == null ? null : centsToAmount(record.chargeCents),
    allowed: record.allowedCents == null ? null : centsToAmount(record.allowedCents),
    paid: centsToAmount(record.paidCents),
    adjustments: record.adjustments,
    serviceLines: record.serviceLines.map((line) => ({
      id: line.id,
      serviceDate: line.serviceDate,
      procedure: line.procedure,
      modifier: line.modifier,
      units: line.units,
      lineReference: line.lineNumber,
      billed: line.chargeCents == null ? null : centsToAmount(line.chargeCents),
      allowed: line.allowedCents == null ? null : centsToAmount(line.allowedCents),
      paid: centsToAmount(line.paidCents),
      adjustment: line.adjustment,
    })),
  };
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicPriorAuthorizations(rows = []) {
  const authorizations = new Map();

  for (const row of rows) {
    const authorizationId = text(row.authorizationId);
    const appointmentId = text(row.appointmentId);
    const authorizationKey = stableKey([authorizationId, appointmentId]);
    if (!authorizations.has(authorizationKey)) {
      authorizations.set(authorizationKey, {
        id: authorizationId,
        number: text(row.authorizationNumber),
        description: text(row.authorizationDescription),
        status: text(row.authorizationStatus),
        effectiveDate: normalizeDate(row.effectiveDate),
        expirationDate: normalizeDate(row.expirationDate),
        appointment: {
          id: appointmentId,
          date: dateTime(row.appointmentDateTime),
          type: text(row.appointmentType),
          status: text(row.appointmentStatus),
          facility: text(row.facility),
        },
        counts: new Map(),
      });
    }

    const authorization = authorizations.get(authorizationKey);
    const countId = text(row.authorizationCountId);
    const countKey = countId || "unassigned";
    if (!authorization.counts.has(countKey)) {
      authorization.counts.set(countKey, {
        id: countId,
        authorizedVisits: numberOrNull(row.authorizedVisits),
        authorizedUnits: numberOrNull(row.authorizedUnits),
        remainingVisits: numberOrNull(row.remainingVisits),
        remainingUnits: numberOrNull(row.remainingUnits),
        procedureCodes: [],
      });
    }
    const count = authorization.counts.get(countKey);
    count.procedureCodes = compact([...count.procedureCodes, row.procedureCode]).sort();
  }

  return [...authorizations.values()].map((authorization) => ({
    ...authorization,
    counts: [...authorization.counts.values()],
  }));
}

function safeDocumentUrl(value) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function publicPatientInvoices(rows = []) {
  const invoices = new Map();
  for (const row of rows) {
    const invoiceNumber = text(row.InvoiceNumber);
    const vendor = text(row.vendor);
    const serviceDate = normalizeDate(row.DateOfService);
    const key = stableKey([vendor, invoiceNumber, serviceDate]);
    if (!invoices.has(key)) {
      invoices.set(key, {
        id: key,
        invoiceNumber,
        vendor,
        dateOfService: serviceDate,
        patientName: compact([row.pt_FirstName, row.pt_LastName]).join(" ") || null,
        shipToAddress: text(row.ShipToAddr),
        createdAt: dateTime(row.created_at),
        redactedPdfUrl: safeDocumentUrl(row.RedactedInvoicePDF),
        totalCents: 0,
        lineTotalKnown: false,
        lines: [],
      });
    }
    const invoice = invoices.get(key);
    const extPriceCents = moneyToCents(row.ExtPrice);
    const priceCents = moneyToCents(row.Price);
    const taxCents = moneyToCents(row.Tax);
    const lineTotalCents = extPriceCents ?? priceCents;
    if (lineTotalCents != null) {
      invoice.totalCents += lineTotalCents + (taxCents || 0);
      invoice.lineTotalKnown = true;
    }
    invoice.lines.push({
      id: text(row.id) || `${key}-${invoice.lines.length + 1}`,
      lineIndex: numberOrNull(row.LineIndex),
      rx: text(row.RX),
      description: text(row.Description),
      procedureName: text(row.ProcedureName),
      productName: text(row.ProductName),
      productNumber: text(row.ProductNumber),
      amount: text(row.Amount),
      quantity: numberOrNull(row.Quantity),
      quantityType: text(row.QuantityType),
      quantityUsed: numberOrNull(row.QuantityUsed),
      price: priceCents == null ? null : centsToAmount(priceCents),
      extendedPrice: extPriceCents == null ? null : centsToAmount(extPriceCents),
      tax: taxCents == null ? null : centsToAmount(taxCents),
      batchNumber: text(row.BatchNum),
      prn: text(row.PRN),
      injectionDate: normalizeDate(row.InjectionDate),
      injectionTime: text(row.InjectionTime),
      deliveryNumber: text(row.DeliveryNumber),
      batchExpiryDate: normalizeDate(row.BatchExpiryDate),
      customerPoNumber: text(row.RLTCustomerPONumber),
      referenceInvoiceNumber: text(row.ReferenceInvoiceNumber),
    });
  }

  return [...invoices.values()].map(({ totalCents, lineTotalKnown, ...invoice }) => ({
    ...invoice,
    total: lineTotalKnown ? centsToAmount(totalCents) : null,
  })).sort((left, right) => (right.dateOfService || "").localeCompare(left.dateOfService || "")
    || (left.invoiceNumber || "").localeCompare(right.invoiceNumber || ""));
}

function recognizedInvoiceProducts(invoice) {
  const invoiceText = normalizeIdentifier(invoice.lines.flatMap((line) => [
    line.productName,
    line.description,
    line.procedureName,
  ]).filter(Boolean).join(" "));
  return PATIENT_INVOICE_CPT_MAPPINGS
    .map(({ product }) => product)
    .filter((product) => invoiceText.includes(normalizeIdentifier(product)));
}

function invoicePoolAllocations(patientInvoices, invoiceLookup) {
  if (!invoiceLookup.isAmbiguous) return [];

  return (invoiceLookup.candidateClaimsByServiceDate || []).flatMap((candidateGroup) => {
    const serviceDate = normalizeDate(candidateGroup.serviceDate);
    const candidateClaimIds = compact(candidateGroup.candidateClaimIds || []);
    if (!serviceDate || candidateClaimIds.length < 2) return [];

    const invoices = patientInvoices.filter((invoice) => invoice.dateOfService === serviceDate);
    if (!invoices.length) return [];
    const totals = invoices.map((invoice) => moneyToCents(invoice.total));
    const totalsKnown = totals.every((total) => total != null);
    const poolTotalCents = totalsKnown ? totals.reduce((sum, total) => sum + total, 0) : null;
    const equalPrices = totalsKnown && new Set(totals).size === 1;
    const vendors = compact(invoices.map((invoice) => normalizeIdentifier(invoice.vendor)));
    const productSets = invoices.map(recognizedInvoiceProducts);
    const sharedProducts = productSets[0]?.filter((product) => (
      productSets.every((products) => products.includes(product))
    )) || [];
    const preferredProduct = (invoiceLookup.matchedProducts || []).find((product) => (
      sharedProducts.includes(product)
    ));
    const product = preferredProduct || sharedProducts[0] || null;
    const equalCardinality = invoices.length === candidateClaimIds.length;
    const canEstimate = equalCardinality && equalPrices && vendors.length === 1 && Boolean(product);
    const reason = canEstimate
      ? `${invoices.length} indistinguishable ${product} invoices match ${candidateClaimIds.length} claims. The exact invoice-to-claim assignment is unknown.`
      : !equalCardinality
        ? `${invoices.length} candidate invoices match ${candidateClaimIds.length} claims, so no per-claim allocation was estimated.`
        : !equalPrices
          ? "Candidate invoice totals are not identical, so no per-claim allocation was estimated."
          : vendors.length !== 1
            ? "Candidate invoices come from different vendors, so no per-claim allocation was estimated."
            : "The candidate invoices do not share one recognized radiopharmaceutical, so no per-claim allocation was estimated.";

    return [{
      id: stableKey([serviceDate, product || "unresolved", candidateClaimIds.join(",")]),
      status: canEstimate ? "estimated_equal_pool" : "unresolved_pool",
      serviceDate,
      product,
      vendor: vendors.length === 1 ? invoices[0].vendor : null,
      invoiceCount: invoices.length,
      claimCount: candidateClaimIds.length,
      shareNumerator: canEstimate ? 1 : null,
      shareDenominator: canEstimate ? candidateClaimIds.length : null,
      poolTotal: poolTotalCents == null ? null : centsToAmount(poolTotalCents),
      estimatedAmount: canEstimate ? centsToAmount(poolTotalCents / candidateClaimIds.length) : null,
      candidateClaimIds,
      candidateInvoiceNumbers: compact(invoices.map((invoice) => invoice.invoiceNumber)),
      reason,
    }];
  });
}

function buildClaimProgress({ sources, claim, summary, eraRecords, priorAuthorizations }) {
  const transactionTypes = new Set(
    sources.transactions.map((row) => normalizeIdentifier(row.CLAIMTRANSACTIONTYPENAME)),
  );
  const hasType = (...types) => types.some((type) => transactionTypes.has(normalizeIdentifier(type)));
  const hasEra = eraRecords.length > 0;
  const submitted = hasEra || hasType("Billed", "Re-billed claim", "Re-billed");
  const denied = hasType("Denial", "Rejected") || eraRecords.some(
    (record) => record.paidCents === 0 && record.adjustments.length > 0,
  );
  const adjudicated = hasEra || hasType(
    "Response",
    "PROXYMED Response",
    "Settled",
    "Prior Settle Transaction Notation",
    "Denial",
    "Rejected",
  );
  const paymentPosted = summary.totalPaid !== 0 || hasType("Applied payment");
  const visitCompleted = submitted || hasType("Claim created");
  const visitScheduled = visitCompleted || Boolean(
    claim.serviceDate || priorAuthorizations.some((authorization) => authorization.appointment.date),
  );
  const priorAuthReceived = priorAuthorizations.length > 0;
  const latestAuthorization = priorAuthorizations.at(-1);
  const latestEra = eraRecords.at(-1);

  const progress = [
    {
      key: "visit-scheduled",
      label: "Visit scheduled",
      achieved: visitScheduled,
      detail: latestAuthorization?.appointment.date || claim.serviceDate || null,
    },
    {
      key: "prior-auth",
      label: "Prior auth received",
      achieved: priorAuthReceived,
      detail: compact([
        latestAuthorization?.status,
        latestAuthorization?.number,
        latestAuthorization?.description,
      ]).join(" · ") || null,
    },
    {
      key: "visit-completed",
      label: "Visit completed",
      achieved: visitCompleted,
      detail: claim.serviceDate,
    },
    {
      key: "claim-submitted",
      label: "Claim submitted",
      achieved: submitted,
      detail: claim.submittedAt,
    },
    {
      key: "payer-pending",
      label: "Payer processing pending",
      achieved: adjudicated,
      detail: submitted && !adjudicated ? "Currently awaiting payer adjudication" : null,
    },
    {
      key: "adjudicated",
      label: "Adjudicated",
      achieved: adjudicated,
      detail: latestEra?.date || null,
    },
    {
      key: "payment-posting",
      label: "Payment posting",
      achieved: paymentPosted,
      detail: paymentPosted ? latestEra?.date || claim.lastActivityAt : null,
    },
    {
      key: "denied",
      label: "Denied",
      achieved: denied,
      detail: denied ? "Denial or rejection evidence recorded" : null,
      tone: "danger",
    },
  ];

  let currentKey = "visit-scheduled";
  if (priorAuthReceived) currentKey = "prior-auth";
  if (visitCompleted) currentKey = "visit-completed";
  if (submitted) currentKey = "payer-pending";
  if (adjudicated) currentKey = "adjudicated";
  if (paymentPosted) currentKey = "payment-posting";
  if (denied) currentKey = "denied";

  return progress.map((step) => ({
    ...step,
    state: step.key === currentKey
      ? step.tone === "danger" ? "alert" : "current"
      : step.achieved ? "complete" : "upcoming",
  }));
}

export function buildClaimLifecycle(sources) {
  const transactionResult = transactionEvents(sources.transactions);
  const sourceEraRows = [
    ...claimStatusEraRows(sources.claimStatus),
    ...ediEraRows(sources.edi835),
  ].filter((row) => submissionSuffix(sources.claimId, row.claimReference) !== null);
  const distinctEras = distinctEraRows(sourceEraRows);
  const eraRecords = buildEraRecords(distinctEras.rows);
  const eraTimeline = eraEvents(eraRecords);
  const reconciliation = reconcilePayments(transactionResult.events, distinctEras.rows);
  const submissions = buildSubmissionEvents(sources.claimId, sources.transactions, sourceEraRows);
  const eraCents = distinctEras.rows.reduce((total, row) => total + row.paidCents, 0);
  const totalPaidCents = eraCents + reconciliation.fallbackCents;
  const timeline = [
    ...transactionResult.events,
    ...serviceEvents(sources.transactions),
    ...submissions.events,
    ...eraTimeline,
  ].sort(compareEvents);
  const first = sources.transactions[0] || {};
  const created = transactionResult.events
    .filter((event) => event.sortOrder === 0 && event.date)
    .sort(compareEvents)[0];
  const transactionFirstDate = firstDate(transactionResult.events.map((event) => event.date));
  const allFirstDate = firstDate([
    ...timeline.map((event) => event.date),
    ...sources.transactions.map((row) => normalizeDate(row.DATEOFSERVICE)),
  ]);
  const firstKnown = created?.date || transactionFirstDate || allFirstDate;
  const firstKnownBasis = created
    ? "Claim created event from FlattenTransctions2"
    : transactionFirstDate
      ? "Earliest FlattenTransctions2 event (claim-created event unavailable)"
      : "Earliest available date (FlattenTransctions2 origin unavailable)";
  const latestTransaction = [...transactionResult.events].sort(compareEvents).at(-1);
  const datedEvents = timeline.filter((event) => event.date);
  const datesOfService = compact([
    ...sources.transactions.map((row) => normalizeDate(row.DATEOFSERVICE)),
    ...sourceEraRows.map((row) => row.serviceDate),
  ]).sort();
  const procedures = compact([
    ...sources.transactions.map((row) => normalizeIdentifier(row.PROCEDURECODE)),
  ]).sort();
  const payerNames = compact([
    ...sources.transactions.flatMap((row) => [row.PayerPlan1, row.CompanyName1]),
    ...sourceEraRows.map((row) => row.payer),
  ]).sort();
  const warnings = [...submissions.warnings];
  if (!created) warnings.push("No explicit claim-created event; first-known date is derived");
  if (distinctEras.duplicateCount) warnings.push(`Removed ${distinctEras.duplicateCount} duplicate ERA row(s)`);
  if (transactionResult.duplicateCount) warnings.push(`Removed ${transactionResult.duplicateCount} duplicate transaction row(s)`);
  if (reconciliation.matchedPostingCount) {
    warnings.push(`Kept ${reconciliation.matchedPostingCount} payment posting(s) informational; ERA amounts were counted`);
  }

  const sourceNames = [
    sources.transactions.length && SOURCE_LABELS.transaction,
    sources.claimStatus.length && SOURCE_LABELS.claimStatus,
    sources.edi835.length && SOURCE_LABELS.edi835,
    sources.priorAuthorizations?.length && SOURCE_LABELS.priorAuthorization,
    sources.patientInvoices?.length && SOURCE_LABELS.patientInvoices,
  ].filter(Boolean);

  const priorAuthorizations = publicPriorAuthorizations(sources.priorAuthorizations || []);
  const patientInvoices = publicPatientInvoices(sources.patientInvoices || []);
  const invoiceLookup = sources.patientInvoiceLookup || {
    status: "not_loaded",
    matchMethod: null,
    matchedCpts: [],
    matchedProducts: [],
    isAmbiguous: false,
    candidateClaimIds: [],
    candidateClaimsByServiceDate: [],
    message: "Invoice matching was not run for this claim.",
  };
  const invoiceAllocations = invoicePoolAllocations(patientInvoices, invoiceLookup);
  const invoiceMatchRule = invoiceLookup.matchMethod === "service_date_and_cpt"
    ? `Date of service + mapped claim CPT (${(invoiceLookup.matchedCpts || []).join(", ")})`
    : invoiceLookup.matchMethod === "service_date_only"
      ? `Date of service only${invoiceLookup.isAmbiguous ? " · ambiguous claim match" : ""}`
      : "Exact patient first name + exact patient last name + date of service";

  const claim = {
    claimId: sources.claimId,
    encounterId: sources.claimId,
    alternateIdentifiers: compact(sources.transactions.flatMap((row) => [
      row.Claim835ID,
      row.CLAIMID,
      row.ENCOUNTERGUID,
    ])),
    submissionReferences: submissions.references,
    patientName: transactionPatientNames(sources.transactions)[0] || "Not provided",
    dateOfBirth: normalizeDate(first.DOB),
    medicalRecordNumber: text(first.MRN),
    provider: text(first.Provider) || "Not provided",
    location: text(first.Location),
    payer: payerNames.join(", ") || "Not provided",
    serviceDate: datesOfService[0] || null,
    datesOfService,
    procedure: procedures.join(", ") || "Not provided",
    createdAt: firstKnown,
    createdAtBasis: firstKnownBasis,
    submittedAt: submissions.events[0]?.date || null,
    lastActivityAt: datedEvents.at(-1)?.date || null,
    status: latestTransaction?.title || (totalPaidCents !== 0 ? "Payment received" : "Claim located"),
  };
  const summary = {
    charges: centsToAmount(aggregateLineMoney(sources.transactions, "Charges")),
    adjustments: centsToAmount(aggregateLineMoney(sources.transactions, "Adjustments")),
    balance: centsToAmount(aggregateLineMoney(sources.transactions, "Balance")),
    totalPaid: centsToAmount(totalPaidCents),
    eraPaid: centsToAmount(eraCents),
    postedPaymentFallback: centsToAmount(reconciliation.fallbackCents),
    eventCount: timeline.length,
  };

  return {
    claim,
    summary,
    progress: buildClaimProgress({ sources, claim, summary, eraRecords, priorAuthorizations }),
    priorAuthorizations,
    patientInvoices,
    invoiceIntegration: {
      status: invoiceLookup.status,
      rowCount: sources.patientInvoices?.length || 0,
      invoiceCount: patientInvoices.length,
      matchMethod: invoiceLookup.matchMethod || null,
      matchedCpts: invoiceLookup.matchedCpts || [],
      matchedProducts: invoiceLookup.matchedProducts || [],
      isAmbiguous: Boolean(invoiceLookup.isAmbiguous),
      candidateClaimIds: invoiceLookup.candidateClaimIds || [],
      candidateClaimsByServiceDate: invoiceLookup.candidateClaimsByServiceDate || [],
      allocations: invoiceAllocations,
      ...(invoiceAllocations.length ? {
        candidateInvoiceCount: patientInvoices.length,
        displayInvoiceCount: invoiceAllocations.length + patientInvoices.filter((invoice) => (
          !invoiceAllocations.some((allocation) => allocation.serviceDate === invoice.dateOfService)
        )).length,
        estimatedInvoiceCount: invoiceAllocations.filter(({ status }) => status === "estimated_equal_pool").length,
      } : {}),
      matchRule: invoiceMatchRule,
      message: invoiceLookup.message,
    },
    eras: eraRecords.map(publicEraRecord),
    cptFinancials: cptChargeSummary(sources.transactions),
    timeline: timeline.map(publicEvent),
    warnings,
    provenance: {
      sources: sourceNames,
      transactionRows: sources.transactions.length,
      claimStatusRows: sources.claimStatus.length,
      edi835Rows: sources.edi835.length,
      priorAuthorizationRows: sources.priorAuthorizations?.length || 0,
      patientInvoiceRows: sources.patientInvoices?.length || 0,
      duplicatesRemoved: distinctEras.duplicateCount + transactionResult.duplicateCount,
      eraMatchedPostings: reconciliation.matchedPostingCount,
      paymentRule:
        "ClaimStatus and edi_835 ERA amounts are authoritative. FlattenTransctions2 payments are counted only when no matching non-zero ERA exists.",
      matchRule:
        "FlattenTransctions2.ENCOUNTERID is the claim ID. ERA references join only when they equal that ENCOUNTERID plus a letter-only correction/rebill suffix; patient, DOS, and CPT never determine claim membership.",
    },
  };
}

export async function getClaimLifecycle(searchId) {
  const validated = assertValidClaimSearch(searchId);
  const cacheKey = normalizeIdentifier(validated) || validated.toUpperCase();
  const lifecycle = await mysqlClaimCache.getOrLoad(
    cacheKey,
    () => withReadOnlySession(async (session) => {
      const sources = await readClaimSources(session, validated);
      return buildClaimLifecycle(sources);
    }),
    (stage, details) => console.info(`[mysql-cache:claim] ${stage}`, details),
  );
  const [commentEnriched, categorizationEnriched] = await Promise.all([
    enrichClaimWithComments(lifecycle),
    enrichClaimWithCategorization(lifecycle),
  ]);
  return attachClaimCategorization(commentEnriched, {
    claim: categorizationEnriched.categorization,
    integration: categorizationEnriched.categorizationIntegration,
  });
}
