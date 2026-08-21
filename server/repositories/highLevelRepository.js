import { config } from "../config.js";
import {
  encounterCandidateFromEraReference,
  normalizeIdentifier,
  submissionSuffix,
} from "../lib/claimIdentity.js";
import {
  invoiceProductText,
  PATIENT_INVOICE_CPT_MAPPINGS,
} from "../lib/patientInvoiceMatching.js";

const TRANSACTIONS = `\`${config.schemas.transactions}\`.\`${config.tables.transactions}\``;
const CLAIM_STATUS = `\`${config.schemas.claimStatus}\`.\`${config.tables.claimStatus}\``;
const PATIENT_INVOICES = `\`${config.schemas.claimStatus}\`.\`${config.tables.patientInvoices}\``;
const EDI_835 = `\`${config.schemas.edi}\`.\`${config.tables.edi}\``;

const BACKLOG_LIMIT = 2_000;
const NO_RESPONSE_RESULT_LIMIT = 500;
const NO_RESPONSE_SCAN_LIMIT = 1_500;
const MIN_CLAIM_ID_LENGTH = 4;
const MAX_HIGH_LEVEL_INVOICE_CANDIDATES = 10_000;
const CLAIM_SORT_SQL = Object.freeze({
  "paid-percent": "paidPercent DESC, paidAmount DESC, billedAmount DESC, serviceDate DESC, claimId ASC",
  youngest: "serviceDate DESC, lastActivity DESC, claimId ASC",
  oldest: "serviceDate ASC, lastActivity ASC, claimId ASC",
  billed: "billedAmount DESC, serviceDate DESC, claimId ASC",
});

function text(value) {
  return String(value ?? "").trim();
}

function dateOnly(value) {
  const raw = text(value);
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const candidate = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function compact(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function derivedRows(rows, columns) {
  const first = `SELECT ${columns.map((column) => `? AS ${column}`).join(", ")}`;
  const additional = `SELECT ${columns.map(() => "?").join(", ")}`;
  return {
    sql: rows.map((_, index) => (index === 0 ? first : additional)).join(" UNION ALL "),
    parameters: rows.flatMap((row) => columns.map((column) => row[column])),
  };
}

function claimProcedureCodes(claim) {
  return new Set(
    text(claim.procedureCodes)
      .split(",")
      .map(normalizeIdentifier)
      .filter(Boolean),
  );
}

async function invoiceMatchesForClaims(session, claims) {
  const matches = new Map(claims.map((claim) => [normalizeIdentifier(claim.claimId), {
    rowCount: 0,
    matchMethod: null,
    isAmbiguous: false,
    candidateClaimIds: [],
  }]));
  const setMatch = (claimId, values) => {
    const key = normalizeIdentifier(claimId);
    if (!matches.has(key)) return;
    matches.set(key, { ...matches.get(key), ...values });
  };
  const exactRequests = claims.map((claim) => ({
    claimId: normalizeIdentifier(claim.claimId),
    serviceDate: dateOnly(claim.serviceDate),
    firstName: text(claim.patientFirstName),
    lastName: text(claim.patientLastName),
  })).filter((request) => request.claimId && request.serviceDate && request.firstName && request.lastName);

  if (exactRequests.length) {
    const exact = derivedRows(exactRequests, ["claimId", "serviceDate", "firstName", "lastName"]);
    const exactRows = await session.select(
      `SELECT requests.claimId, COUNT(invoices.id) AS invoiceRowCount
         FROM (${exact.sql}) AS requests
         JOIN ${PATIENT_INVOICES} AS invoices
           ON invoices.DateOfService = requests.serviceDate
          AND UPPER(TRIM(invoices.pt_FirstName)) = UPPER(requests.firstName)
          AND UPPER(TRIM(invoices.pt_LastName)) = UPPER(requests.lastName)
        GROUP BY requests.claimId`,
      exact.parameters,
      { label: "high-level.claims.patient-invoice-exact-counts" },
    );
    for (const row of exactRows) {
      const rowCount = numberValue(row.invoiceRowCount);
      if (rowCount > 0) setMatch(row.claimId, { rowCount, matchMethod: "patient_and_service_date" });
    }
  }

  const fallbackRequests = [];
  for (const claim of claims) {
    const claimId = normalizeIdentifier(claim.claimId);
    const serviceDate = dateOnly(claim.serviceDate);
    if (!claimId || !serviceDate || matches.get(claimId)?.rowCount > 0) continue;
    const procedures = claimProcedureCodes(claim);
    for (const mapping of PATIENT_INVOICE_CPT_MAPPINGS) {
      if (!procedures.has(mapping.cpt)) continue;
      fallbackRequests.push({
        claimId,
        serviceDate,
        cpt: mapping.cpt,
        product: mapping.product,
        queryPattern: mapping.queryPattern,
      });
    }
  }
  if (fallbackRequests.length) {
    const fallback = derivedRows(
      fallbackRequests,
      ["claimId", "serviceDate", "cpt", "product", "queryPattern"],
    );
    const candidateRows = await session.select(
      `SELECT requests.claimId,
              requests.cpt,
              requests.product,
              invoices.id,
              invoices.InvoiceNumber,
              invoices.DateOfService,
              invoices.ProductName,
              invoices.Description,
              invoices.ProcedureName
         FROM (${fallback.sql}) AS requests
         JOIN ${PATIENT_INVOICES} AS invoices
           ON invoices.DateOfService = requests.serviceDate
          AND UPPER(CONCAT_WS(' ', invoices.ProductName, invoices.Description, invoices.ProcedureName)) LIKE requests.queryPattern
        ORDER BY requests.claimId, invoices.InvoiceNumber, invoices.id
        LIMIT ${MAX_HIGH_LEVEL_INVOICE_CANDIDATES + 1}`,
      fallback.parameters,
      { label: "high-level.claims.patient-invoice-cpt-candidates" },
    );
    if (candidateRows.length > MAX_HIGH_LEVEL_INVOICE_CANDIDATES) {
      throw new Error(
        `patient_invoices returned more than ${MAX_HIGH_LEVEL_INVOICE_CANDIDATES} High Level CPT fallback candidates.`,
      );
    }

    const matchedByClaim = new Map();
    for (const row of candidateRows) {
      if (!invoiceProductText(row).includes(normalizeIdentifier(row.product))) continue;
      const claimId = normalizeIdentifier(row.claimId);
      if (!matchedByClaim.has(claimId)) matchedByClaim.set(claimId, new Map());
      matchedByClaim.get(claimId).set(String(row.id), row);
    }

    const lineRequests = [];
    for (const [claimId, matchedRows] of matchedByClaim) {
      const invoiceNumbers = new Map();
      for (const row of matchedRows.values()) {
        const invoiceNumber = text(row.InvoiceNumber);
        const serviceDate = dateOnly(row.DateOfService);
        if (invoiceNumber && serviceDate) {
          invoiceNumbers.set(`${serviceDate}|${invoiceNumber}`, { claimId, serviceDate, invoiceNumber });
        }
      }
      if (invoiceNumbers.size) lineRequests.push(...invoiceNumbers.values());
      else setMatch(claimId, { rowCount: matchedRows.size, matchMethod: "service_date_and_cpt" });
    }

    if (lineRequests.length) {
      const lines = derivedRows(lineRequests, ["claimId", "serviceDate", "invoiceNumber"]);
      const lineCounts = await session.select(
        `SELECT requests.claimId, COUNT(invoices.id) AS invoiceRowCount
           FROM (${lines.sql}) AS requests
           JOIN ${PATIENT_INVOICES} AS invoices
             ON invoices.DateOfService = requests.serviceDate
            AND invoices.InvoiceNumber = requests.invoiceNumber
          GROUP BY requests.claimId`,
        lines.parameters,
        { label: "high-level.claims.patient-invoice-cpt-line-counts" },
      );
      for (const row of lineCounts) {
        const rowCount = numberValue(row.invoiceRowCount);
        if (rowCount > 0) setMatch(row.claimId, { rowCount, matchMethod: "service_date_and_cpt" });
      }
    }
  }

  const dateOnlyRequests = claims.map((claim) => ({
    claimId: normalizeIdentifier(claim.claimId),
    serviceDate: dateOnly(claim.serviceDate),
  })).filter(({ claimId, serviceDate }) => (
    claimId && serviceDate && matches.get(claimId)?.rowCount === 0
  ));
  if (!dateOnlyRequests.length) return matches;

  const dateOnlyDerived = derivedRows(dateOnlyRequests, ["claimId", "serviceDate"]);
  const dateOnlyRows = await session.select(
    `SELECT requests.claimId,
            requests.serviceDate,
            COUNT(invoices.id) AS invoiceRowCount
       FROM (${dateOnlyDerived.sql}) AS requests
       JOIN ${PATIENT_INVOICES} AS invoices
         ON invoices.DateOfService = requests.serviceDate
      GROUP BY requests.claimId, requests.serviceDate`,
    dateOnlyDerived.parameters,
    { label: "high-level.claims.patient-invoice-date-only-counts" },
  );
  const matchedDates = new Set();
  for (const row of dateOnlyRows) {
    const rowCount = numberValue(row.invoiceRowCount);
    const serviceDate = dateOnly(row.serviceDate);
    if (rowCount <= 0 || !serviceDate) continue;
    setMatch(row.claimId, { rowCount, matchMethod: "service_date_only" });
    matchedDates.add(serviceDate);
  }
  if (!matchedDates.size) return matches;

  const dates = derivedRows([...matchedDates].map((serviceDate) => ({ serviceDate })), ["serviceDate"]);
  const claimCandidates = await session.select(
    `SELECT requests.serviceDate,
            CAST(transactions.ENCOUNTERID AS CHAR) AS claimId
       FROM (${dates.sql}) AS requests
       JOIN ${TRANSACTIONS} AS transactions
         ON transactions.DATEOFSERVICE >= requests.serviceDate
        AND transactions.DATEOFSERVICE < DATE_ADD(requests.serviceDate, INTERVAL 1 DAY)
      WHERE transactions.ENCOUNTERID IS NOT NULL
      GROUP BY requests.serviceDate, transactions.ENCOUNTERID
      ORDER BY requests.serviceDate, claimId
      LIMIT ${MAX_HIGH_LEVEL_INVOICE_CANDIDATES + 1}`,
    dates.parameters,
    { label: "high-level.claims.patient-invoice-date-only-claim-candidates" },
  );
  if (claimCandidates.length > MAX_HIGH_LEVEL_INVOICE_CANDIDATES) {
    throw new Error(
      `More than ${MAX_HIGH_LEVEL_INVOICE_CANDIDATES} claims share the High Level invoice fallback dates.`,
    );
  }
  const candidatesByDate = new Map([...matchedDates].map((serviceDate) => [serviceDate, []]));
  for (const row of claimCandidates) {
    const serviceDate = dateOnly(row.serviceDate);
    const claimId = normalizeIdentifier(row.claimId);
    if (candidatesByDate.has(serviceDate) && claimId) candidatesByDate.get(serviceDate).push(claimId);
  }
  for (const request of dateOnlyRequests) {
    const match = matches.get(request.claimId);
    if (match?.matchMethod !== "service_date_only") continue;
    const candidateClaimIds = compact(candidatesByDate.get(request.serviceDate) || []);
    setMatch(request.claimId, {
      candidateClaimIds,
      isAmbiguous: candidateClaimIds.length > 1,
    });
  }

  return matches;
}

function deniedEncounterCandidates(rows) {
  const candidates = new Set();
  for (const row of rows) {
    if (numberValue(row.paid) !== 0 || !text(row.reason)) continue;
    const reference = normalizeIdentifier(row.reference);
    if (!reference) continue;
    candidates.add(reference);
    const familyCandidate = encounterCandidateFromEraReference(reference);
    if (familyCandidate) candidates.add(familyCandidate);
  }
  return [...candidates].sort();
}

function compactReason(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const codes = compact(parsed.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const group = text(entry.group || entry.group_code);
        const reason = text(entry.reason || entry.reason_code || entry.code);
        return [group, reason].filter(Boolean).join("-");
      }));
      if (codes.length) return codes.join(", ");
    }
  } catch {
    // Plain-text adjustment descriptions are already suitable for display.
  }
  return raw.replace(/\s+/g, " ").slice(0, 120);
}

function claimForReference(reference, claimIds) {
  return claimIds.find((claimId) => submissionSuffix(claimId, reference) !== null) || null;
}

function referencePredicate(column, claimIds) {
  const numericClaimIds = claimIds.filter((claimId) => /^\d{1,18}$/.test(claimId));
  const prefixClaimIds = claimIds.filter((claimId) => !/^\d{1,18}$/.test(claimId));
  const clauses = [];
  const parameters = [];

  // The large edi_835 source has no index on patient_control_number. Comparing
  // all numeric encounter prefixes in one scan is substantially cheaper than
  // scanning it once per batch with hundreds of OR-ed LIKE expressions.
  if (numericClaimIds.length) {
    clauses.push(`CAST(${column} AS UNSIGNED) IN (${numericClaimIds.map(() => "?").join(", ")})`);
    parameters.push(...numericClaimIds);
  }
  if (prefixClaimIds.length) {
    clauses.push(`(${prefixClaimIds.map(() => `${column} LIKE ?`).join(" OR ")})`);
    parameters.push(...prefixClaimIds.map((claimId) => `${claimId}%`));
  }

  return {
    sql: clauses.length ? `(${clauses.join(" OR ")})` : "1 = 0",
    parameters,
  };
}

function transactionStatus(title, amount) {
  const normalized = text(title).toLowerCase();
  if (/payment|paid/.test(normalized) && amount < 0) return "reversed";
  if (/payment|paid/.test(normalized) && amount > 0) return "paid";
  if (/denial|denied|reject/.test(normalized)) return "action";
  if (/billed|submitted|submission|rebill|re-bill|corrected/.test(normalized)) return "submitted";
  if (/claim created|created/.test(normalized)) return "created";
  if (/settled|adjusted|write.?off/.test(normalized)) return "processed";
  return "activity";
}

function transactionLabel(status, title) {
  if (status === "submitted") return /rebill|re-bill|corrected/i.test(title) ? "Rebilled" : "Submitted";
  if (status === "paid") return "Payment posted";
  if (status === "reversed") return "Payment reversed";
  if (status === "created") return "Created";
  if (status === "action") return text(title) || "Review needed";
  if (status === "processed") return text(title) || "Billing updated";
  return text(title) || "Activity";
}

function normalizeTransactionEvents(rows) {
  return rows.map((row) => {
    const amount = numberValue(row.amount);
    const status = transactionStatus(row.eventType, amount);
    return {
      claimId: normalizeIdentifier(row.claimId),
      date: dateOnly(row.eventDate),
      status,
      label: transactionLabel(status, row.eventType),
      amount: /paid|reversed/.test(status) ? amount : null,
      procedure: normalizeIdentifier(row.procedureCode) || null,
      charge: row.charge == null ? null : numberValue(row.charge),
      source: "billing",
    };
  }).filter((event) => event.claimId && event.date);
}

function normalizeEraEvents(rows, claimIds, source) {
  return rows.map((row) => {
    const reference = normalizeIdentifier(row.reference);
    const claimId = claimForReference(reference, claimIds);
    const amount = numberValue(row.amount);
    const status = amount > 0 ? "paid" : amount < 0 ? "reversed" : "action";
    const reason = compactReason(row.reason);
    return {
      claimId,
      date: dateOnly(row.eventDate),
      status,
      label: amount > 0
        ? "Paid"
        : amount < 0
          ? "Payment reversed"
          : reason
            ? `Denied: ${reason}`
            : "Payer response — no payment",
      amount,
      procedure: normalizeIdentifier(row.procedureCode) || null,
      charge: row.charge == null ? null : numberValue(row.charge),
      source,
      reason,
    };
  }).filter((event) => event.claimId && event.date);
}

async function responseRowsForClaims(session, claimIds) {
  const claimStatusPredicate = referencePredicate("PatientControlNumber", claimIds);
  const claimStatus = await session.select(
    `SELECT PatientControlNumber AS reference,
            CheckEftDate AS eventDate,
            Payment AS amount,
            AdjudProcedure AS procedureCode,
            ChargeAmount AS charge,
            COALESCE(NULLIF(AdjustmentCodes, ''), NULLIF(ChargeAdjustments, '')) AS reason
       FROM ${CLAIM_STATUS}
      WHERE ${claimStatusPredicate.sql}`,
    claimStatusPredicate.parameters,
    { label: "high-level.claims.claim-status-responses" },
  );

  const ediPredicate = referencePredicate("patient_control_number", claimIds);
  const edi835 = await session.select(
    `SELECT patient_control_number AS reference,
            COALESCE(payment_date, claim_received_date, service_date) AS eventDate,
            paid_amount AS amount,
            service_code AS procedureCode,
            charge_amount AS charge,
            service_adjustments AS reason
       FROM ${EDI_835}
      WHERE ${ediPredicate.sql}`,
    ediPredicate.parameters,
    { label: "high-level.claims.edi-responses" },
  );

  return { claimStatus, edi835 };
}

async function respondedClaimIds(
  session,
  claimIds,
  onProgress = () => {},
) {
  const responded = new Set();
  const startedAt = Date.now();

  onProgress("responses:start", {
    candidateCount: claimIds.length,
  });

  const sources = [
    {
      column: "PatientControlNumber",
      label: "claim-status",
      table: CLAIM_STATUS,
    },
    {
      column: "patient_control_number",
      label: "edi-835",
      table: EDI_835,
    },
  ];

  for (const source of sources) {
    const sourceStartedAt = Date.now();
    const predicate = referencePredicate(source.column, claimIds);
    const rows = await session.select(
      `SELECT DISTINCT ${source.column} AS reference
         FROM ${source.table}
        WHERE ${predicate.sql}`,
      predicate.parameters,
      { label: `high-level.no-response.${source.label}` },
    );
    const respondedBeforeSource = responded.size;
    for (const row of rows) {
      const claimId = claimForReference(row.reference, claimIds);
      if (claimId) responded.add(claimId);
    }
    onProgress("responses:source", {
      source: source.label,
      referenceCount: rows.length,
      matchedClaimCount: responded.size - respondedBeforeSource,
      durationMs: Date.now() - sourceStartedAt,
    });
  }

  onProgress("responses:complete", {
    matchedClaimCount: responded.size,
    processedCount: claimIds.length,
    unansweredCount: claimIds.length - responded.size,
    durationMs: Date.now() - startedAt,
  });

  return { responded, processedCount: claimIds.length };
}

function deduplicateEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = [
      event.claimId,
      event.date,
      event.status,
      event.amount ?? "",
      event.procedure || "",
      event.charge ?? "",
      event.label,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function readHighLevelClaims(session, { start, end, limit, sort = "youngest" }) {
  const activityWhere = `(POSTINGDATE BETWEEN ? AND ? OR DATEOFSERVICE BETWEEN ? AND ?)`;
  const rangeParameters = [start, end, start, end];
  const orderBy = CLAIM_SORT_SQL[sort] || CLAIM_SORT_SQL.youngest;
  const [countRows, claims] = await Promise.all([
    session.select(
      `SELECT COUNT(DISTINCT CAST(ENCOUNTERID AS CHAR)) AS total
         FROM ${TRANSACTIONS}
        WHERE ENCOUNTERID IS NOT NULL
          AND ${activityWhere}`,
      rangeParameters,
      { label: "high-level.claims.count" },
    ),
    session.select(
      `SELECT service_lines.claimId,
              MIN(service_lines.serviceDate) AS serviceDate,
              MIN(service_lines.firstActivity) AS firstActivity,
              MAX(service_lines.lastActivity) AS lastActivity,
              MAX(service_lines.patientName) AS patientName,
              MAX(service_lines.patientFirstName) AS patientFirstName,
              MAX(service_lines.patientLastName) AS patientLastName,
              MAX(service_lines.payer) AS payer,
              GROUP_CONCAT(DISTINCT service_lines.procedureCode ORDER BY service_lines.procedureCode SEPARATOR ',') AS procedureCodes,
              SUM(service_lines.procedureCharge) AS billedAmount,
              SUM(service_lines.procedurePaid) AS paidAmount,
              CASE WHEN SUM(service_lines.procedureCharge) > 0
                THEN SUM(service_lines.procedurePaid) / SUM(service_lines.procedureCharge)
                ELSE 0 END AS paidPercent
         FROM (
           SELECT CAST(ENCOUNTERID AS CHAR) AS claimId,
                  PROCEDURECODE AS procedureCode,
                  MIN(DATE(DATEOFSERVICE)) AS serviceDate,
                  MIN(DATE(COALESCE(POSTINGDATE, DATEOFSERVICE))) AS firstActivity,
                  MAX(DATE(COALESCE(POSTINGDATE, DATEOFSERVICE))) AS lastActivity,
                  MAX(TRIM(CONCAT_WS(' ', FIRSTNAME, LASTNAME))) AS patientName,
                  MAX(NULLIF(TRIM(FIRSTNAME), '')) AS patientFirstName,
                  MAX(NULLIF(TRIM(LASTNAME), '')) AS patientLastName,
                  MAX(COALESCE(NULLIF(PayerPlan1, ''), NULLIF(CompanyName1, ''))) AS payer,
                  MAX(COALESCE(Charges, 0)) AS procedureCharge,
                  MAX(COALESCE(Receipt, 0)) AS procedurePaid
             FROM ${TRANSACTIONS}
            WHERE ENCOUNTERID IS NOT NULL
              AND ${activityWhere}
            GROUP BY ENCOUNTERID, PROCEDURECODE
         ) AS service_lines
        GROUP BY service_lines.claimId
        ORDER BY ${orderBy}
        LIMIT ${limit}`,
      rangeParameters,
      { label: "high-level.claims.summary" },
    ),
  ]);

  const claimIds = compact(claims.map((claim) => normalizeIdentifier(claim.claimId)));
  if (!claimIds.length) return { total: numberValue(countRows[0]?.total), claims: [], events: [] };

  const placeholders = claimIds.map(() => "?").join(", ");
  const transactionRows = await session.select(
    `SELECT CAST(ENCOUNTERID AS CHAR) AS claimId,
            DATE(COALESCE(POSTINGDATE, DATEOFSERVICE)) AS eventDate,
            CLAIMTRANSACTIONTYPENAME AS eventType,
            PROCEDURECODE AS procedureCode,
            SUM(COALESCE(Amount, 0)) AS amount,
            SUM(COALESCE(Charges, 0)) AS charge
       FROM ${TRANSACTIONS}
      WHERE ENCOUNTERID IN (${placeholders})
        AND ${activityWhere}
      GROUP BY ENCOUNTERID, eventDate, CLAIMTRANSACTIONTYPENAME, PROCEDURECODE
      ORDER BY eventDate ASC`,
    [...claimIds, ...rangeParameters],
    { label: "high-level.claims.transaction-events" },
  );
  const [responseRows, invoiceMatches] = await Promise.all([
    responseRowsForClaims(session, claimIds),
    invoiceMatchesForClaims(session, claims),
  ]);
  const events = deduplicateEvents([
    ...normalizeTransactionEvents(transactionRows),
    ...normalizeEraEvents(responseRows.claimStatus, claimIds, "payer"),
    ...normalizeEraEvents(responseRows.edi835, claimIds, "payer"),
  ]).filter((event) => event.date >= start && event.date <= end);

  return {
    total: numberValue(countRows[0]?.total),
    claims: claims.map((claim) => {
      const claimId = normalizeIdentifier(claim.claimId);
      const invoiceMatch = invoiceMatches.get(claimId) || {};
      return {
        claimId,
        patientName: text(claim.patientName) || null,
        payer: text(claim.payer) || null,
        serviceDate: dateOnly(claim.serviceDate),
        firstActivity: dateOnly(claim.firstActivity),
        lastActivity: dateOnly(claim.lastActivity),
        billedAmount: numberValue(claim.billedAmount),
        paidAmount: numberValue(claim.paidAmount),
        paidPercent: numberValue(claim.paidPercent),
        invoiceRowCount: invoiceMatch.rowCount || 0,
        invoiceMatchMethod: invoiceMatch.matchMethod || null,
        invoiceMatchAmbiguous: Boolean(invoiceMatch.isAmbiguous),
        invoiceCandidateClaimIds: invoiceMatch.candidateClaimIds || [],
      };
    }),
    events,
  };
}

export async function readUnsubmittedAppointments(session, {
  start,
  end,
  order = "oldest",
  scope = "all",
} = {}) {
  const scopeWhere = scope === "recent"
    ? "AND DATEOFSERVICE >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY)"
    : "";
  const orderDirection = order === "youngest" ? "DESC" : "ASC";
  const rows = await session.select(
    `SELECT CAST(ENCOUNTERID AS CHAR) AS claimId,
            MIN(DATE(DATEOFSERVICE)) AS serviceDate,
            MAX(DATE(COALESCE(POSTINGDATE, DATEOFSERVICE))) AS lastActivity,
            MAX(TRIM(CONCAT_WS(' ', FIRSTNAME, LASTNAME))) AS patientName,
            MAX(COALESCE(NULLIF(PayerPlan1, ''), NULLIF(CompanyName1, ''))) AS payer,
            MAX(NULLIF(Provider, '')) AS provider,
            MAX(NULLIF(Location, '')) AS location,
            MAX(NULLIF(CAST(MRN AS CHAR), '')) AS mrn,
            MAX(DATE(DOB)) AS dateOfBirth,
            GROUP_CONCAT(DISTINCT NULLIF(PROCEDURECODE, '') ORDER BY PROCEDURECODE SEPARATOR ',') AS procedures
      FROM ${TRANSACTIONS}
      WHERE ENCOUNTERID IS NOT NULL
        AND DATEOFSERVICE <= CURRENT_DATE
        ${scopeWhere}
      GROUP BY ENCOUNTERID
     HAVING SUM(CASE
       WHEN LOWER(COALESCE(CLAIMTRANSACTIONTYPENAME, '')) REGEXP 'billed|submitted|submission|rebill|re-bill'
       THEN 1 ELSE 0 END) = 0
        AND serviceDate >= ?
        AND serviceDate <= ?
      ORDER BY serviceDate ${orderDirection}, claimId ASC
      LIMIT ${BACKLOG_LIMIT + 1}`,
    [start, end],
    { label: "high-level.unsubmitted" },
  );
  return {
    items: rows.slice(0, BACKLOG_LIMIT).map((row) => ({
      claimId: normalizeIdentifier(row.claimId),
      patientName: text(row.patientName) || null,
      payer: text(row.payer) || null,
      serviceDate: dateOnly(row.serviceDate),
      lastActivity: dateOnly(row.lastActivity),
      provider: text(row.provider) || null,
      location: text(row.location) || null,
      mrn: text(row.mrn) || null,
      dateOfBirth: dateOnly(row.dateOfBirth),
      procedures: compact(text(row.procedures).split(",")),
    })),
    truncated: rows.length > BACKLOG_LIMIT,
  };
}

export async function readClaimsWithoutResponse(
  session,
  { start, end, order = "oldest", scope = "all" } = {},
  onProgress = () => {},
) {
  const scopeHaving = scope === "overdue"
    ? "AND submittedDate <= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY)"
    : "";
  const orderDirection = order === "youngest" ? "DESC" : "ASC";
  const candidateStartedAt = Date.now();

  onProgress("candidates:start", {
    order,
    scope,
    scanLimit: NO_RESPONSE_SCAN_LIMIT,
  });

  const rows = await session.select(
    `SELECT CAST(ENCOUNTERID AS CHAR) AS claimId,
            MIN(DATE(DATEOFSERVICE)) AS serviceDate,
            MAX(DATE(COALESCE(POSTINGDATE, DATEOFSERVICE))) AS submittedDate,
            MAX(TRIM(CONCAT_WS(' ', FIRSTNAME, LASTNAME))) AS patientName,
            MAX(COALESCE(NULLIF(PayerPlan1, ''), NULLIF(CompanyName1, ''))) AS payer,
            MAX(NULLIF(Provider, '')) AS provider,
            MAX(NULLIF(Location, '')) AS location,
            MAX(NULLIF(CAST(MRN AS CHAR), '')) AS mrn,
            MAX(DATE(DOB)) AS dateOfBirth,
            GROUP_CONCAT(DISTINCT NULLIF(PROCEDURECODE, '') ORDER BY PROCEDURECODE SEPARATOR ',') AS procedures
       FROM ${TRANSACTIONS}
      WHERE ENCOUNTERID IS NOT NULL
        AND CHAR_LENGTH(TRIM(CAST(ENCOUNTERID AS CHAR))) >= ${MIN_CLAIM_ID_LENGTH}
        AND LOWER(COALESCE(CLAIMTRANSACTIONTYPENAME, '')) REGEXP 'billed|submitted|submission|rebill|re-bill'
      GROUP BY ENCOUNTERID
     HAVING submittedDate IS NOT NULL
        AND submittedDate >= ?
        AND submittedDate <= ?
        ${scopeHaving}
      ORDER BY submittedDate ${orderDirection}, claimId ASC
      LIMIT ${NO_RESPONSE_SCAN_LIMIT + 1}`,
    [start, end],
    { label: "high-level.no-response.candidates" },
  );

  const candidates = rows.slice(0, NO_RESPONSE_SCAN_LIMIT);
  onProgress("candidates:complete", {
    candidateCount: candidates.length,
    capped: rows.length > NO_RESPONSE_SCAN_LIMIT,
    durationMs: Date.now() - candidateStartedAt,
  });

  const claimIds = compact(candidates.map((row) => normalizeIdentifier(row.claimId)));
  const responseResult = claimIds.length
    ? await respondedClaimIds(session, claimIds, onProgress)
    : { responded: new Set(), processedCount: 0 };
  const scannedCandidates = candidates.slice(0, responseResult.processedCount);
  const unanswered = scannedCandidates.filter((row) => (
    !responseResult.responded.has(normalizeIdentifier(row.claimId))
  ));
  const truncated = rows.length > responseResult.processedCount
    || unanswered.length > NO_RESPONSE_RESULT_LIMIT;

  onProgress("results:complete", {
    scannedCount: scannedCandidates.length,
    matchedResponseCount: responseResult.responded.size,
    noResponseCount: unanswered.length,
    returnedCount: Math.min(unanswered.length, NO_RESPONSE_RESULT_LIMIT),
    truncated,
  });

  return {
    items: unanswered.slice(0, NO_RESPONSE_RESULT_LIMIT).map((row) => ({
      claimId: normalizeIdentifier(row.claimId),
      patientName: text(row.patientName) || null,
      payer: text(row.payer) || null,
      serviceDate: dateOnly(row.serviceDate),
      submittedDate: dateOnly(row.submittedDate),
      provider: text(row.provider) || null,
      location: text(row.location) || null,
      mrn: text(row.mrn) || null,
      dateOfBirth: dateOnly(row.dateOfBirth),
      procedures: compact(text(row.procedures).split(",")),
    })),
    scanned: scannedCandidates.length,
    truncated,
  };
}

export async function readHighLevelDashboard(session, { start, end }) {
  const billedRows = await session.select(
    `SELECT billed_submissions.claimId,
            billed_submissions.procedureCode,
            billed_submissions.date,
            billed_submissions.patientName,
            billed_submissions.payer,
            billed_submissions.charge,
            billed_submissions.submissionOrder,
            billed_submissions.latestSubmissionOrder
       FROM (
         SELECT ranked_lines.*,
                MAX(ranked_lines.submissionOrder) OVER (PARTITION BY ranked_lines.claimId) AS latestSubmissionOrder
           FROM (
             SELECT billed_lines.*,
                    DENSE_RANK() OVER (PARTITION BY billed_lines.claimId ORDER BY billed_lines.date ASC) - 1 AS submissionOrder
               FROM (
                 SELECT CAST(transactions.ENCOUNTERID AS CHAR) AS claimId,
                        COALESCE(NULLIF(transactions.PROCEDURECODE, ''), 'UNCODED') AS procedureCode,
                        DATE(transactions.POSTINGDATE) AS date,
                        MAX(TRIM(CONCAT_WS(' ', transactions.FIRSTNAME, transactions.LASTNAME))) AS patientName,
                        MAX(COALESCE(NULLIF(transactions.CompanyName1, ''), NULLIF(transactions.PayerPlan1, ''))) AS payer,
                        MAX(COALESCE(transactions.Charges, 0)) AS charge
                   FROM ${TRANSACTIONS} AS transactions
                   INNER JOIN (
                     SELECT DISTINCT ENCOUNTERID
                       FROM ${TRANSACTIONS}
                      WHERE ENCOUNTERID IS NOT NULL
                        AND POSTINGDATE >= ?
                        AND POSTINGDATE < DATE_ADD(?, INTERVAL 1 DAY)
                        AND CLAIMTRANSACTIONTYPENAME IN ('Billed', 'Re-billed claim', 'Re-billed')
                   ) AS range_claims ON range_claims.ENCOUNTERID = transactions.ENCOUNTERID
                  WHERE transactions.CLAIMTRANSACTIONTYPENAME IN ('Billed', 'Re-billed claim', 'Re-billed')
                  GROUP BY transactions.ENCOUNTERID,
                           DATE(transactions.POSTINGDATE),
                           COALESCE(NULLIF(transactions.PROCEDURECODE, ''), 'UNCODED')
               ) AS billed_lines
           ) AS ranked_lines
       ) AS billed_submissions
      WHERE billed_submissions.date >= ?
        AND billed_submissions.date < DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY billed_submissions.date ASC,
               billed_submissions.charge DESC,
               billed_submissions.claimId ASC,
               billed_submissions.submissionOrder ASC`,
    [start, end, start, end],
    { label: "high-level.dashboard.billed" },
  );

  const originalRows = await session.select(
    `SELECT CAST(transactions.ENCOUNTERID AS CHAR) AS claimId,
            COALESCE(NULLIF(transactions.PROCEDURECODE, ''), 'UNCODED') AS procedureCode,
            DATE(transactions.POSTINGDATE) AS date,
            MAX(TRIM(CONCAT_WS(' ', transactions.FIRSTNAME, transactions.LASTNAME))) AS patientName,
            MAX(COALESCE(NULLIF(transactions.CompanyName1, ''), NULLIF(transactions.PayerPlan1, ''))) AS payer,
            SUM(COALESCE(transactions.Charges, 0)) AS charge
       FROM ${TRANSACTIONS} AS transactions
      WHERE transactions.ENCOUNTERID IS NOT NULL
        AND transactions.POSTINGDATE >= ?
        AND transactions.POSTINGDATE < DATE_ADD(?, INTERVAL 1 DAY)
        AND transactions.CLAIMTRANSACTIONTYPENAME = 'Claim created'
      GROUP BY transactions.ENCOUNTERID,
               DATE(transactions.POSTINGDATE),
               COALESCE(NULLIF(transactions.PROCEDURECODE, ''), 'UNCODED')
      ORDER BY date ASC,
               charge DESC,
               claimId ASC`,
    [start, end],
    { label: "high-level.dashboard.original" },
  );

  const claimStatusRows = await session.select(
    `SELECT PatientControlNumber AS reference,
            DATE(COALESCE(CheckEftDate, EobTransactionDate, ImportedAtUtc, DateOfServiceStart)) AS eventDate,
            DateOfServiceStart AS serviceDate,
            COALESCE(NULLIF(AdjudProcedure, ''), NULLIF(SubProcedure, '')) AS procedureCode,
            COALESCE(NULLIF(AdjudModifier, ''), NULLIF(SubModifier, '')) AS modifier,
            LineControlNumber AS lineNumber,
            ChargeAmount AS charge,
            Payment AS paid,
            AllowedAmount AS allowed,
            COALESCE(NULLIF(AdjustmentCodes, ''), NULLIF(ChargeAdjustments, '')) AS reason,
            PayerName AS payer,
            CheckEftTraceNumber AS traceNumber
       FROM ${CLAIM_STATUS}
      WHERE (CheckEftDate >= ? AND CheckEftDate < DATE_ADD(?, INTERVAL 1 DAY))
         OR (EobTransactionDate >= ? AND EobTransactionDate < DATE_ADD(?, INTERVAL 1 DAY))
         OR (ImportedAtUtc >= ? AND ImportedAtUtc < DATE_ADD(?, INTERVAL 1 DAY))`,
    [start, end, start, end, start, end],
    { label: "high-level.dashboard.claim-status" },
  );

  const compactStart = start.replaceAll("-", "");
  const compactEnd = end.replaceAll("-", "");
  const ediRows = await session.select(
    `SELECT patient_control_number AS reference,
            COALESCE(payment_date, claim_received_date, service_date, statement_from_date) AS eventDate,
            COALESCE(service_date, statement_from_date) AS serviceDate,
            service_code AS procedureCode,
            modifiers AS modifier,
            reference_id AS lineNumber,
            charge_amount AS charge,
            paid_amount AS paid,
            NULL AS allowed,
            service_adjustments AS reason,
            payer_name AS payer,
            trace_number AS traceNumber
       FROM ${EDI_835}
      WHERE (payment_date BETWEEN ? AND ? OR payment_date BETWEEN ? AND ?)
         OR (claim_received_date BETWEEN ? AND ? OR claim_received_date BETWEEN ? AND ?)
         OR (service_date BETWEEN ? AND ? OR service_date BETWEEN ? AND ?)`,
    [
      start, end, compactStart, compactEnd,
      start, end, compactStart, compactEnd,
      start, end, compactStart, compactEnd,
    ],
    { label: "high-level.dashboard.edi-835" },
  );

  const deniedEncounterIds = deniedEncounterCandidates([...claimStatusRows, ...ediRows]);
  const latestDeniedBilledRows = deniedEncounterIds.length ? await session.select(
    `SELECT latest_lines.claimId,
            latest_lines.procedureCode,
            latest_lines.date,
            latest_lines.charge
       FROM (
         SELECT billed_lines.*,
                DENSE_RANK() OVER (PARTITION BY billed_lines.claimId ORDER BY billed_lines.date DESC) AS recency
           FROM (
             SELECT CAST(transactions.ENCOUNTERID AS CHAR) AS claimId,
                    COALESCE(NULLIF(transactions.PROCEDURECODE, ''), 'UNCODED') AS procedureCode,
                    DATE(transactions.POSTINGDATE) AS date,
                    MAX(COALESCE(transactions.Charges, 0)) AS charge
               FROM ${TRANSACTIONS} AS transactions
              WHERE transactions.ENCOUNTERID IN (${deniedEncounterIds.map(() => "?").join(", ")})
                AND transactions.CLAIMTRANSACTIONTYPENAME IN ('Billed', 'Re-billed claim', 'Re-billed')
              GROUP BY transactions.ENCOUNTERID,
                       DATE(transactions.POSTINGDATE),
                       COALESCE(NULLIF(transactions.PROCEDURECODE, ''), 'UNCODED')
           ) AS billed_lines
       ) AS latest_lines
      WHERE latest_lines.recency = 1
      ORDER BY latest_lines.claimId ASC,
               latest_lines.procedureCode ASC`,
    deniedEncounterIds,
    { label: "high-level.dashboard.latest-denied-billed" },
  ) : [];

  return { billedRows, originalRows, claimStatusRows, ediRows, latestDeniedBilledRows };
}
