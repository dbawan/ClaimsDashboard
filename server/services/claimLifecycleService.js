import { claimStatusEraRows, ediEraRows, advancedMdEraRows, distinctEraRows } from "../lib/eraReconciliation.js";
import { withReadOnlySession } from "../db/readOnlyPool.js";
import { config } from "../config.js";
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
import { claimPaymentTiming } from "../lib/claimPaymentTiming.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { CLAIM_CACHE_TTL_MS } from "../lib/dataCache.js";
import { readClaimSources } from "../repositories/claimRepository.js";
import {
  attachClaimCategorization,
  enrichClaimWithCategorization,
} from "./claimCategorizationService.js";
import { enrichClaimWithComments } from "./claimCommentService.js";
import { attachClaimVitals } from "./claimVitalsService.js";

export const MYSQL_CLAIM_CACHE_TTL_MS = CLAIM_CACHE_TTL_MS;
const mysqlClaimCache = createTtlCache({ ttlMs: MYSQL_CLAIM_CACHE_TTL_MS });
// Categorized-claim API data may follow the cached MySQL snapshot. Salesforce
// comments deliberately bypass this cache and are loaded for every claim search.
let claimCategorizations = new WeakMap();

export function invalidateClaimEnrichments() {
  claimCategorizations = new WeakMap();
}

const SOURCE_LABELS = Object.freeze({
  transaction: "FlattenTransctions2",
  claimStatus: "ClaimStatus ERA",
  edi835: "EDI 835 ERA",
  advancedMd: "AdvancedMD ERA",
  priorAuthorization: "EHR prior authorization",
  patientInvoices: "Patient invoices",
  combined: "Combined sources",
});

const SOURCE_RANK = Object.freeze({ advancedMd: 0, claimStatus: 1, edi835: 2, transaction: 3 });

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

function originalClaimCharge(rows) {
  const rowsWithCharges = rows.filter((row) => moneyToCents(row.Charges) != null);
  if (!rowsWithCharges.length) return null;
  const createdRows = rowsWithCharges.filter((row) => isClaimCreatedEvent(
    row.CLAIMTRANSACTIONTYPENAME,
  ));
  if (createdRows.length) return centsToAmount(aggregateLineMoney(createdRows, "Charges"));

  const billedRows = rowsWithCharges.filter((row) => (
    /^(?:BILLED|REBILLEDCLAIM|REBILLED)$/.test(normalizeIdentifier(row.CLAIMTRANSACTIONTYPENAME))
  ));
  const candidates = billedRows.length ? billedRows : rowsWithCharges;
  const earliestDate = firstDate(candidates.map((row) => normalizeDate(row.POSTINGDATE)));
  const originalRows = earliestDate
    ? candidates.filter((row) => normalizeDate(row.POSTINGDATE) === earliestDate)
    : candidates;
  return centsToAmount(aggregateLineMoney(originalRows, "Charges"));
}

function latestClaimCharge(rows) {
  const rowsWithCharges = rows.filter((row) => moneyToCents(row.Charges) != null);
  if (!rowsWithCharges.length) return 0;

  const submissionRows = rowsWithCharges.filter((row) => (
    /^(?:CLAIMCREATED|CREATEDCLAIM|BILLED|REBILLEDCLAIM|REBILLED)$/.test(
      normalizeIdentifier(row.CLAIMTRANSACTIONTYPENAME),
    )
  ));
  const candidates = submissionRows.length ? submissionRows : rowsWithCharges;
  const latestDate = compact(
    candidates.map((row) => normalizeDate(row.POSTINGDATE) || normalizeDate(row.DATEOFSERVICE)),
  ).sort().at(-1);
  const latestRows = latestDate
    ? candidates.filter((row) => (
      (normalizeDate(row.POSTINGDATE) || normalizeDate(row.DATEOFSERVICE)) === latestDate
    ))
    : candidates;
  return centsToAmount(aggregateLineMoney(latestRows, "Charges"));
}

function claimAttemptCount(transactions, submissionReferences) {
  if (submissionReferences.length) return submissionReferences.length;
  const attemptKeys = new Set();
  for (const row of transactions) {
    const transactionType = normalizeIdentifier(row.CLAIMTRANSACTIONTYPENAME);
    if (!/^(?:BILLED|REBILLEDCLAIM|REBILLED)$/.test(transactionType)) continue;
    const date = normalizeDate(row.POSTINGDATE) || normalizeDate(row.DATEOFSERVICE);
    attemptKeys.add(stableKey([date, transactionType]));
  }
  return attemptKeys.size;
}

function latestAppealRebillDate(transactions) {
  // Use recorded actions, not ERA suffix observations or planned/status activity.
  const actionTypes = new Set([
    "REBILLED", "REBILLEDCLAIM", "CLAIMREBILLED",
    "CORRECTEDCLAIM", "CLAIMCORRECTED", "RESUBMITTEDCLAIM", "CLAIMRESUBMITTED",
    "APPEALSUBMITTED", "SUBMITTEDAPPEAL", "APPEALFILED", "FILEDAPPEAL", "APPEALSENT",
  ]);
  return compact(transactions
    .filter((row) => actionTypes.has(normalizeIdentifier(row.CLAIMTRANSACTIONTYPENAME)))
    .map((row) => normalizeDate(row.POSTINGDATE)))
    .sort().at(-1) || null;
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
      const units = Number(row.UNIT);
      serviceLines.set(key, {
        procedure,
        chargeCents: moneyToCents(row.Charges) || 0,
        units: Number.isFinite(units) && units > 0 ? units : 1,
      });
    }
  }

  const byProcedure = new Map();
  for (const line of serviceLines.values()) {
    const current = byProcedure.get(line.procedure) || { chargeCents: 0, units: 0 };
    current.chargeCents += line.chargeCents;
    current.units += line.units;
    byProcedure.set(line.procedure, current);
  }
  return [...byProcedure]
    .map(([procedure, { chargeCents, units }]) => ({
      procedure,
      charged: centsToAmount(chargeCents),
      units,
    }))
    .sort((left, right) => right.charged - left.charged
      || left.procedure.localeCompare(right.procedure));
}


function isPaymentEvent(eventType) {
  const value = String(eventType ?? "").toLowerCase();
  if (/patient responsibility|copay|coinsurance|deductible/.test(value)) return false;
  return /^(applied payment|payment applied|insurance payment|payment posted|payment received|remittance payment|paid transaction|receipt|payment reversal|voided payment)$/.test(value.trim());
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
  if (transactionId) return stableKey(["id", row.EHR, row.CLAIMTRANSACTIONTYPENAME, transactionId, row.PAYMENTID, row.PAYMENTCLAIMID]);
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
      ? moneyToCents(row.Amount)
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
      chargeCents: moneyToCents(row.Charges),
      adjustedCents: moneyToCents(row.Adjustments),
      balanceCents: moneyToCents(row.Balance),
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
      title: isClaimCreatedEvent(group.title) ? "Claim created" : group.paymentEvent
        ? amountCents < 0 ? "Posted payment reversed" : "Posted payment" : group.title,
      description: details.join(" · ") || "Activity recorded in FlattenTransctions2.",
      source: SOURCE_LABELS.transaction,
      sourceType: "transaction",
      status: eventStatus(group.title, amountCents || 0),
      amountCents,
      countedPaymentCents: group.paymentEvent ? amountCents || 0 : 0,
      lineReferences: compact(group.lines.flatMap((line) => line.lineReferences)),
      transactionType: group.transactionType,
      paymentEvent: group.paymentEvent,
      lines: group.lines,
      paymentAuthority: group.paymentEvent ? "posted" : "informational",
    };
  });
  for (const event of events) for (const line of event.lines) {
    line.countedPaymentCents = event.paymentEvent ? line.amountCents || 0 : 0;
  }
  return { events, duplicateCount };
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
      row.remittanceKey || "",
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
      receivedAt: first.receivedAt || null,
      postFailed: groupRows.some((row) => row.postFailed),
      dismissedAt: first.dismissedAt || null,
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
        flattenedClaimId: row.flattenedClaimId || null,
        claimLevelOnly: Boolean(row.claimLevelOnly),
        patientResponsibilityCents: row.patientResponsibilityCents ?? null,
        adjustedCents: row.adjustedCents ?? null,
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
      countedPaymentCents: 0,
      receivedPaymentCents: record.paidCents,
      lineReferences: record.lineReferences,
      paymentAuthority: "era",
      traceNumber: record.traceNumber,
      claimReference: record.claimReference,
      cptPaymentLines: record.serviceLines.map((line) => ({
        procedure: line.procedure,
        countedPaymentCents: 0,
        receivedPaymentCents: line.paidCents,
        chargeCents: line.chargeCents,
        allowedCents: line.allowedCents,
        patientResponsibilityCents: line.patientResponsibilityCents,
        adjustedCents: line.adjustedCents,
        adjustment: line.adjustment,
        units: line.units,
      })),
    };
  });
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

    if (patientKeys.size && anchorPatientKeys.size
      && stableKey([...patientKeys].sort()) !== stableKey([...anchorPatientKeys].sort())) {
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
      procedures: [...cpts].sort(),
    };
  });

  if (references.length === 0) {
    warnings.push("No ERA submission/rebill reference matched ENCOUNTERID; received payment data is unavailable. Posted payments remain available from the billing ledger.");
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
  const activityLines = event.cptPaymentLines || event.lines || [];
  const cptPayments = activityLines
    .filter((line) => line.procedure && line.countedPaymentCents)
    .map((line) => ({
      procedure: line.procedure,
      paid: centsToAmount(line.countedPaymentCents),
    }));
  const activityByProcedure = new Map();
  for (const line of activityLines) {
    const procedure = normalizeIdentifier(line.procedure);
    if (!procedure) continue;
    if (!activityByProcedure.has(procedure)) {
      activityByProcedure.set(procedure, {
        procedure,
        lineCount: 0,
        postedCents: 0,
        receivedCents: 0,
        billedCents: 0,
        allowedCents: 0,
        patientResponsibilityCents: 0,
        adjustedCents: 0,
        balanceCents: 0,
        billedKnown: false,
        allowedKnown: false,
        patientResponsibilityKnown: false,
        adjustedKnown: false,
        balanceKnown: false,
        adjustments: [],
      });
    }
    const activity = activityByProcedure.get(procedure);
    activity.lineCount += 1;
    activity.postedCents += line.countedPaymentCents || 0;
    activity.receivedCents += line.receivedPaymentCents || 0;
    if (line.chargeCents != null) {
      activity.billedKnown = true;
      activity.billedCents += line.chargeCents;
    }
    if (line.allowedCents != null) {
      activity.allowedKnown = true;
      activity.allowedCents += line.allowedCents;
    }
    if (line.patientResponsibilityCents != null) {
      activity.patientResponsibilityKnown = true;
      activity.patientResponsibilityCents += line.patientResponsibilityCents;
    }
    if (line.adjustedCents != null) {
      activity.adjustedKnown = true;
      activity.adjustedCents += line.adjustedCents;
    }
    if (line.balanceCents != null) {
      activity.balanceKnown = true;
      activity.balanceCents += line.balanceCents;
    }
    if (line.adjustment && !activity.adjustments.includes(line.adjustment)) {
      activity.adjustments.push(line.adjustment);
    }
  }
  const procedures = compact([
    ...(event.procedures || []),
    ...activityByProcedure.keys(),
  ]).sort();
  const cptActivity = [...activityByProcedure.values()].map((activity) => ({
    procedure: activity.procedure,
    lineCount: activity.lineCount,
    posted: centsToAmount(activity.postedCents),
    received: centsToAmount(activity.receivedCents),
    billed: activity.billedKnown ? centsToAmount(activity.billedCents) : null,
    allowed: activity.allowedKnown ? centsToAmount(activity.allowedCents) : null,
    patientResponsibility: activity.patientResponsibilityKnown
      ? centsToAmount(activity.patientResponsibilityCents)
      : null,
    adjusted: activity.adjustedKnown ? centsToAmount(activity.adjustedCents) : null,
    balance: activity.balanceKnown ? centsToAmount(activity.balanceCents) : null,
    adjustments: activity.adjustments,
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
    receivedPayment: centsToAmount(event.receivedPaymentCents || 0),
    cptReceived: (event.cptPaymentLines || []).filter((line) => line.receivedPaymentCents)
      .map((line) => ({ procedure: line.procedure || "UNALLOCATED", paid: centsToAmount(line.receivedPaymentCents) })),
    paymentAuthority: event.paymentAuthority,
    submissionReference: event.submissionReference || null,
    procedures,
    cptActivity,
    cptPayments,
  };
}

function publicEraRecord(record) {
  return {
    id: record.id,
    date: record.date,
    receivedAt: record.receivedAt,
    postFailed: record.postFailed,
    dismissedAt: record.dismissedAt,
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
      flattenedClaimId: line.flattenedClaimId,
      claimLevelOnly: line.claimLevelOnly,
      patientResponsibility: line.patientResponsibilityCents == null ? null : centsToAmount(line.patientResponsibilityCents),
      adjusted: line.adjustedCents == null ? null : centsToAmount(line.adjustedCents),
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
  const postingDates = sources.transactions.filter((row) => isPaymentEvent(row.CLAIMTRANSACTIONTYPENAME) && (moneyToCents(row.Amount) || 0) > 0)
    .map((row) => normalizeDate(row.POSTINGDATE)).filter(Boolean).sort();
  const paymentPosted = postingDates.length > 0;
  const paymentReceived = eraRecords.some((record) => record.paidCents > 0);
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
      key: "payment-received",
      label: "Payment received",
      achieved: paymentReceived,
      detail: paymentReceived ? eraRecords.filter((record) => record.paidCents > 0).at(-1)?.date : null,
    },
    {
      key: "payment-posting",
      label: "Posted payment",
      achieved: paymentPosted,
      detail: postingDates.at(-1) || null,
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
  if (paymentReceived) currentKey = "payment-received";
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
    ...advancedMdEraRows(sources.advancedMdEra),
    ...claimStatusEraRows(sources.claimStatus),
    ...ediEraRows(sources.edi835),
  ].filter((row) => submissionSuffix(sources.claimId, row.claimReference) !== null);
  const distinctEras = distinctEraRows(sourceEraRows);
  const eraRecords = buildEraRecords(distinctEras.rows);
  const eraTimeline = eraEvents(eraRecords);
  const postedCents = transactionResult.events.reduce((total, event) => total + event.countedPaymentCents, 0);
  const submissions = buildSubmissionEvents(sources.claimId, sources.transactions, sourceEraRows);
  const eraCents = distinctEras.rows.reduce((total, row) => total + row.paidCents, 0);
  const totalPaidCents = postedCents;
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
  const reimbursementPayerNames = compact([
    ...sources.transactions.flatMap((row) => [row.CompanyName1, row.PayerPlan1]),
    ...sourceEraRows.map((row) => row.payer),
  ]);
  const warnings = [...submissions.warnings];
  if (!created) warnings.push("No explicit claim-created event; first-known date is derived");
  if (distinctEras.duplicateCount) warnings.push(`Removed ${distinctEras.duplicateCount} duplicate ERA row(s)`);
  if (transactionResult.duplicateCount) warnings.push(`Removed ${transactionResult.duplicateCount} duplicate transaction row(s)`);

  const sourceNames = [
    sources.transactions.length && SOURCE_LABELS.transaction,
    sources.claimStatus.length && SOURCE_LABELS.claimStatus,
    sources.edi835.length && SOURCE_LABELS.edi835,
    sources.advancedMdEra?.length && SOURCE_LABELS.advancedMd,
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
    status: latestTransaction?.title || (totalPaidCents !== 0 ? "Posted payment" : eraCents !== 0 ? "Payment received" : "Claim located"),
  };
  const summary = {
    charges: centsToAmount(aggregateLineMoney(sources.transactions, "Charges")),
    latestCharge: latestClaimCharge(sources.transactions),
    adjustments: centsToAmount(aggregateLineMoney(sources.transactions, "Adjustments")),
    balance: centsToAmount(aggregateLineMoney(sources.transactions, "Balance")),
    totalPaid: centsToAmount(totalPaidCents),
    eraPaid: centsToAmount(eraCents),
    postedPaid: centsToAmount(postedCents),
    receivedPaid: centsToAmount(eraCents),
    eventCount: timeline.length,
  };
  Object.assign(summary, claimPaymentTiming({
    createdAt: firstKnown,
    latestCharge: summary.latestCharge,
    payments: timeline.map((event) => ({
      date: event.date,
      amount: centsToAmount(event.countedPaymentCents || 0),
    })),
    thresholdPercent: config.claims.paidThresholdPercent,
  }));
  const transactionDates = compact(
    sources.transactions.map((row) => normalizeDate(row.POSTINGDATE)),
  ).sort();
  const cptFinancials = cptChargeSummary(sources.transactions);
  const claimVitalSources = Object.freeze({
    lastTransactionDate: transactionDates.at(-1) || null,
    latestAppealRebillDate: latestAppealRebillDate(sources.transactions),
    originalCharge: originalClaimCharge(sources.transactions),
    attempts: claimAttemptCount(sources.transactions, submissions.references),
    payerNames: Object.freeze(reimbursementPayerNames),
  });

  return {
    claim,
    summary,
    claimVitalSources,
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
    cptFinancials,
    timeline: timeline.map(publicEvent),
    warnings,
    provenance: {
      sources: sourceNames,
      transactionRows: sources.transactions.length,
      claimStatusRows: sources.claimStatus.length,
      edi835Rows: sources.edi835.length,
      advancedMdEraRows: sources.advancedMdEra?.length || 0,
      priorAuthorizationRows: sources.priorAuthorizations?.length || 0,
      patientInvoiceRows: sources.patientInvoices?.length || 0,
      duplicatesRemoved: distinctEras.duplicateCount + transactionResult.duplicateCount,
      eraMatchedPostings: 0,
      paymentRule:
        "Posted payments come only from FlattenTransctions2. Payments received come from deduplicated AdvancedMD, ClaimStatus and edi_835 remittances. Received and posted amounts are never added together.",
      matchRule:
        "FlattenTransctions2.ENCOUNTERID is the claim ID. ERA references join only when they equal that ENCOUNTERID plus a letter-only correction/rebill suffix; patient, DOS, and CPT never determine claim membership.",
    },
  };
}

export async function getBaseClaimLifecycle(searchId, options = {}) {
  const validated = assertValidClaimSearch(searchId);
  const cacheKey = normalizeIdentifier(validated) || validated.toUpperCase();
  const cache = options.cache || mysqlClaimCache;
  const run = options.withReadOnlySession || withReadOnlySession;
  const read = options.readClaimSources || readClaimSources;
  return cache.getOrLoad(
    cacheKey,
    () => run(async (session) => {
      const sources = await read(session, validated);
      return buildClaimLifecycle(sources);
    }),
    (stage, details) => console.info(`[mysql-cache:claim] ${stage}`, details),
  );
}

async function categorizedClaimLifecycle(lifecycle, options = {}) {
  const cache = claimCategorizations;
  if (!cache.has(lifecycle)) {
    const pending = Promise.resolve()
      .then(() => (options.enrichClaimWithCategorization || enrichClaimWithCategorization)(lifecycle))
      .then((enriched) => {
        // A temporary integration failure must remain retryable on the next request.
        if (/error|failed|timeout|unavailable|unauthorized/.test(
          enriched.categorizationIntegration?.status || "",
        )) cache.delete(lifecycle);
        return enriched;
      })
      .catch((error) => {
        cache.delete(lifecycle);
        throw error;
      });
    cache.set(lifecycle, pending);
  }
  return cache.get(lifecycle);
}

export async function getCachedClaimLifecycle(searchId, options = {}) {
  const lifecycle = await (options.getBaseClaimLifecycle || getBaseClaimLifecycle)(searchId);
  // Calendar-based ages and deadlines still update on every request.
  return attachClaimVitals(lifecycle);
}

export async function getClaimLifecycle(searchId, options = {}) {
  const lifecycle = await (options.getBaseClaimLifecycle || getBaseClaimLifecycle)(searchId);
  const [commentEnriched, categorizationEnriched] = await Promise.all([
    // Salesforce is intentionally queried on every request. Gemini's immutable
    // per-comment classifications retain their own content-addressed cache.
    (options.enrichClaimWithComments || enrichClaimWithComments)(lifecycle),
    categorizedClaimLifecycle(lifecycle, options),
  ]);
  const enriched = attachClaimCategorization(commentEnriched, {
    claim: categorizationEnriched.categorization,
    integration: categorizationEnriched.categorizationIntegration,
  });
  return attachClaimVitals(enriched);
}
