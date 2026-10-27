import { readAdvancedMdEra } from "./advancedMdEraRepository.js";
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
import {
  AmbiguousClaimError,
  ClaimNotFoundError,
  PatientIdentityUnavailableError,
  PatientNotFoundError,
} from "../lib/errors.js";

export { PATIENT_INVOICE_CPT_MAPPINGS } from "../lib/patientInvoiceMatching.js";

const TRANSACTIONS = `\`${config.schemas.transactions}\`.\`${config.tables.transactions}\``;
const CLAIM_STATUS = `\`${config.schemas.claimStatus}\`.\`${config.tables.claimStatus}\``;
const PATIENT_INVOICES = `\`${config.schemas.claimStatus}\`.\`${config.tables.patientInvoices}\``;
const EDI_835 = `\`${config.schemas.edi}\`.\`${config.tables.edi}\``;
const EHR = `\`${config.schemas.ehr}\``;
const PATIENT_INFO = `${EHR}.\`${config.tables.patientInfo}\``;

const MAX_CANDIDATES = 30;
const MAX_ROWS_PER_SOURCE = 25_000;
const MAX_INVOICE_ROWS = 500;
const PATIENT_CLAIM_PAGE_SIZE = 25;
const MAX_PATIENT_CLAIM_RESULTS = 100;
const MAX_PATIENT_SUGGESTIONS = 10;
const INVOICE_COLUMNS = `
  id, vendor, InvoiceNumber, pt_FirstName, pt_LastName, DateOfService,
  RX, Description, ProductNumber, Amount, ProcedureName, Quantity,
  QuantityType, QuantityUsed, Price, ExtPrice, Tax, BatchNum, PRN,
  ProductName, ShipToAddr, created_at, RedactedInvoicePDF,
  InjectionDate, InjectionTime, DeliveryNumber, BatchExpiryDate,
  RLTCustomerPONumber, ReferenceInvoiceNumber, LineIndex`;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function patientSearchResult(row) {
  const firstName = String(row.firstName || "").trim();
  const lastName = String(row.lastName || "").trim();
  return Object.freeze({
    patientId: String(row.patientId || "").trim(),
    name: [firstName, lastName].filter(Boolean).join(" ")
      || String(row.fullName || "").trim()
      || "Unnamed patient",
    dateOfBirth: String(row.dateOfBirth || "").slice(0, 10) || null,
    chartNumber: String(row.chartNumber || "").trim() || null,
    inactive: Boolean(row.inactiveAt),
  });
}

export async function searchPatientsByName(session, query) {
  const pattern = `${query}%`;
  const rows = await session.select(
    `SELECT
            CAST(Patient_UID AS CHAR) AS patientId,
            NULLIF(TRIM(FullName), '') AS fullName,
            NULLIF(TRIM(FirstName), '') AS firstName,
            NULLIF(TRIM(LastName), '') AS lastName,
            DATE(DOB) AS dateOfBirth,
            NULLIF(TRIM(ChartNumber), '') AS chartNumber,
            Inactive AS inactiveAt
       FROM ${PATIENT_INFO}
      WHERE LicenseKey = ?
        AND Patient_UID IS NOT NULL
        AND (
          UPPER(TRIM(FullName)) LIKE UPPER(?)
          OR UPPER(TRIM(CONCAT_WS(' ', FirstName, LastName))) LIKE UPPER(?)
          OR UPPER(TRIM(CONCAT_WS(' ', LastName, FirstName))) LIKE UPPER(?)
          OR UPPER(TRIM(CONCAT(LastName, ', ', FirstName))) LIKE UPPER(?)
          OR UPPER(TRIM(FirstName)) LIKE UPPER(?)
          OR UPPER(TRIM(LastName)) LIKE UPPER(?)
        )
      ORDER BY
        CASE
          WHEN UPPER(TRIM(FullName)) = UPPER(?)
            OR UPPER(TRIM(CONCAT_WS(' ', FirstName, LastName))) = UPPER(?) THEN 0
          WHEN UPPER(TRIM(FirstName)) = UPPER(?)
            OR UPPER(TRIM(LastName)) = UPPER(?) THEN 1
          ELSE 2
        END,
        LastName ASC, FirstName ASC, DOB ASC, Patient_UID ASC
      LIMIT ${MAX_PATIENT_SUGGESTIONS + 1}`,
    [
      config.ehr.licenseKey,
      pattern, pattern, pattern, pattern, pattern, pattern,
      query, query, query, query,
    ],
    { label: "claim.patient-name-search.suggestions" },
  );

  return Object.freeze({
    query,
    total: Math.min(rows.length, MAX_PATIENT_SUGGESTIONS),
    hasMore: rows.length > MAX_PATIENT_SUGGESTIONS,
    patients: Object.freeze(rows.slice(0, MAX_PATIENT_SUGGESTIONS).map(patientSearchResult)),
  });
}

function patientClaimSummary(row) {
  return Object.freeze({
    claimId: normalizeIdentifier(row.claimId),
    serviceDate: String(row.serviceDate || "").slice(0, 10) || null,
    lastActivityDate: String(row.lastActivityDate || "").slice(0, 10) || null,
    status: String(row.status || "").trim() || "Claim located",
    payer: String(row.payer || "").trim() || null,
    provider: String(row.provider || "").trim() || null,
    location: String(row.location || "").trim() || null,
    procedureCodes: Object.freeze(unique(
      String(row.procedureCodes || "").split(",").map(normalizeIdentifier),
    )),
  });
}

function claimReferenceWhere(field, claimIds) {
  return claimIds.map(() => `${field} LIKE ?`).join(" OR ");
}

export async function readPatientClaimSources(session, patientId, {
  includeFinancials = false,
  startDate = null,
  endDate = null,
  offset = 0,
  procedureQuery = null,
} = {}) {
  const pageOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const patientRows = await session.select(
    `SELECT CAST(Patient_UID AS CHAR) AS patientId,
            NULLIF(TRIM(FullName), '') AS fullName,
            NULLIF(TRIM(FirstName), '') AS firstName,
            NULLIF(TRIM(LastName), '') AS lastName,
            DATE(DOB) AS dateOfBirth,
            NULLIF(TRIM(ChartNumber), '') AS chartNumber,
            Inactive AS inactiveAt
       FROM ${PATIENT_INFO}
      WHERE LicenseKey = ?
        AND Patient_UID = ?
      LIMIT 2`,
    [config.ehr.licenseKey, patientId],
    { label: "claim.patient-name-search.identity" },
  );
  if (patientRows.length !== 1) throw new PatientNotFoundError();

  const serviceDateFilters = [
    startDate ? "DATE(MIN(claim_rows.DATEOFSERVICE)) >= ?" : null,
    endDate ? "DATE(MIN(claim_rows.DATEOFSERVICE)) <= ?" : null,
  ].filter(Boolean);
  const serviceDateParameters = [startDate, endDate].filter(Boolean);
  const procedureFilter = procedureQuery
    ? `
            AND EXISTS (
              SELECT 1
                FROM ${TRANSACTIONS} AS procedure_rows
               WHERE procedure_rows.ENCOUNTERID = claim_rows.ENCOUNTERID
                 AND UPPER(TRIM(procedure_rows.PROCEDURECODE)) LIKE ?
            )`
    : "";
  const procedureParameters = procedureQuery ? [`%${procedureQuery}%`] : [];
  const serviceDateHaving = serviceDateFilters.length
    ? `\n     HAVING ${serviceDateFilters.join("\n        AND ")}`
    : "";
  const totalRows = await session.select(
    `SELECT COUNT(*) AS total
       FROM (
         SELECT claim_rows.ENCOUNTERID
           FROM ${TRANSACTIONS} AS claim_rows
          WHERE claim_rows.ENCOUNTERID IS NOT NULL
            AND TRIM(CAST(claim_rows.PATIENTGUID AS CHAR)) = ?
            AND UPPER(TRIM(claim_rows.EHR)) = UPPER(?)${procedureFilter}
          GROUP BY claim_rows.ENCOUNTERID${serviceDateHaving}
       ) AS matching_patient_claims`,
    [patientId, config.ehr.transactionSource, ...procedureParameters, ...serviceDateParameters],
    { label: "claim.patient-name-search.claim-count" },
  );
  const total = Math.max(0, Number(totalRows[0]?.total) || 0);
  const summaryRows = await session.select(
    `SELECT CAST(claim_rows.ENCOUNTERID AS CHAR) AS claimId,
            DATE(MIN(claim_rows.DATEOFSERVICE)) AS serviceDate,
            DATE(MAX(claim_rows.POSTINGDATE)) AS lastActivityDate,
            SUBSTRING_INDEX(
              GROUP_CONCAT(
                NULLIF(TRIM(claim_rows.CLAIMTRANSACTIONTYPENAME), '')
                ORDER BY claim_rows.POSTINGDATE DESC, claim_rows.CLAIMTRANSACTIONID DESC
                SEPARATOR '|||'
              ),
              '|||',
              1
            ) AS status,
            MAX(NULLIF(TRIM(claim_rows.PayerPlan1), '')) AS payer,
            MAX(NULLIF(TRIM(claim_rows.Provider), '')) AS provider,
            MAX(NULLIF(TRIM(claim_rows.Location), '')) AS location,
            GROUP_CONCAT(
              DISTINCT UPPER(TRIM(claim_rows.PROCEDURECODE))
              ORDER BY UPPER(TRIM(claim_rows.PROCEDURECODE))
              SEPARATOR ','
            ) AS procedureCodes
       FROM ${TRANSACTIONS} AS claim_rows
      WHERE claim_rows.ENCOUNTERID IS NOT NULL
        AND TRIM(CAST(claim_rows.PATIENTGUID AS CHAR)) = ?
        AND UPPER(TRIM(claim_rows.EHR)) = UPPER(?)${procedureFilter}
      GROUP BY claim_rows.ENCOUNTERID${serviceDateHaving}
      ORDER BY serviceDate DESC, claimId DESC
      LIMIT ${PATIENT_CLAIM_PAGE_SIZE + 1}
      OFFSET ${pageOffset}`,
    [patientId, config.ehr.transactionSource, ...procedureParameters, ...serviceDateParameters],
    { label: "claim.patient-name-search.claims" },
  );
  const claimRows = summaryRows.slice(0, PATIENT_CLAIM_PAGE_SIZE).map(patientClaimSummary);
  const claimIds = claimRows.map(({ claimId }) => claimId).filter(Boolean);

  let transactions = [];
  let claimStatus = [];
  let edi835 = [];
  let advancedMdEra = [];
  if (includeFinancials && claimIds.length) {
    const placeholders = claimIds.map(() => "?").join(", ");
    const prefixes = claimIds.map((claimId) => `${claimId}%`);
    [transactions, claimStatus, edi835, advancedMdEra] = await Promise.all([
      session.select(
        `SELECT *
           FROM ${TRANSACTIONS}
          WHERE ENCOUNTERID IN (${placeholders})
          ORDER BY ENCOUNTERID ASC, POSTINGDATE ASC, CLAIMTRANSACTIONID ASC
          LIMIT ${MAX_ROWS_PER_SOURCE + 1}`,
        claimIds,
        { label: "claim.patient-name-search.financial-transactions" },
      ),
      session.select(
        `SELECT *
           FROM ${CLAIM_STATUS}
          WHERE ${claimReferenceWhere("PatientControlNumber", claimIds)}
          ORDER BY CheckEftDate ASC, ImportedAtUtc ASC, ClaimStatusId ASC
          LIMIT ${MAX_ROWS_PER_SOURCE + 1}`,
        prefixes,
        { label: "claim.patient-name-search.financial-claim-status" },
      ),
      session.select(
        `SELECT *
           FROM ${EDI_835}
          WHERE ${claimReferenceWhere("patient_control_number", claimIds)}
          ORDER BY payment_date ASC, service_date ASC, id ASC
          LIMIT ${MAX_ROWS_PER_SOURCE + 1}`,
        prefixes,
        { label: "claim.patient-name-search.financial-edi-835" },
      ),
      readAdvancedMdEra(session, { claimIds }),
    ]);
    ensureComplete(transactions, "FlattenTransctions2", "selected patient");
    ensureComplete(claimStatus, "ClaimStatus", "selected patient");
    ensureComplete(edi835, "edi_835", "selected patient");
  }

  const hasMore = summaryRows.length > PATIENT_CLAIM_PAGE_SIZE
    || pageOffset + claimRows.length < total;
  return Object.freeze({
    patient: patientSearchResult(patientRows[0]),
    total,
    hasMore,
    nextOffset: hasMore ? pageOffset + claimRows.length : null,
    claimRows: Object.freeze(claimRows),
    transactions: Object.freeze(transactions),
    claimStatus: Object.freeze(claimStatus),
    edi835: Object.freeze(edi835),
    advancedMdEra: Object.freeze(advancedMdEra),
  });
}

async function exactEncounterCandidates(session, identifier) {
  const rows = await session.select(
    `SELECT DISTINCT CAST(ENCOUNTERID AS CHAR) AS encounterId
       FROM ${TRANSACTIONS}
      WHERE ENCOUNTERID = ?
      LIMIT 2`,
    [identifier],
  );

  return unique(rows.map((row) => normalizeIdentifier(row.encounterId)));
}

async function transactionCandidates(session, identifier) {
  const rows = await session.select(
    `SELECT DISTINCT CAST(ENCOUNTERID AS CHAR) AS encounterId
       FROM ${TRANSACTIONS}
      WHERE ENCOUNTERID = ?
         OR Claim835ID = ?
         OR CLAIMID = ?
         OR ENCOUNTERGUID = ?
      LIMIT ${MAX_CANDIDATES + 1}`,
    [identifier, identifier, identifier, identifier],
  );

  return unique(rows.map((row) => normalizeIdentifier(row.encounterId)));
}

async function eraAliases(session, identifier) {
  const [claimStatusRows, ediRows] = await Promise.all([
    session.select(
      `SELECT DISTINCT PatientControlNumber
         FROM ${CLAIM_STATUS}
        WHERE ClaimNumber = ? OR PatientControlNumber = ?
        LIMIT ${MAX_CANDIDATES + 1}`,
      [identifier, identifier],
    ),
    session.select(
      `SELECT DISTINCT patient_control_number
         FROM ${EDI_835}
        WHERE payer_claim_control = ?
           OR patient_control_number = ?
        LIMIT ${MAX_CANDIDATES + 1}`,
      [identifier, identifier],
    ),
  ]);

  return unique([
    ...claimStatusRows.map((row) => row.PatientControlNumber),
    ...ediRows.map((row) => row.patient_control_number),
  ]);
}

async function resolveTransactionClaimId(session, searchId) {
  const exactEncounters = await exactEncounterCandidates(session, searchId);
  if (exactEncounters.length === 1) return exactEncounters[0];
  if (exactEncounters.length > 1) {
    throw new AmbiguousClaimError(exactEncounters.slice(0, 10));
  }

  let candidates = await transactionCandidates(session, searchId);

  if (candidates.length === 0) {
    const familyCandidate = encounterCandidateFromEraReference(searchId);
    if (familyCandidate) candidates = await transactionCandidates(session, familyCandidate);
  }

  if (candidates.length === 0) {
    const aliases = await eraAliases(session, searchId);
    for (const alias of aliases.slice(0, MAX_CANDIDATES)) {
      const familyCandidate = encounterCandidateFromEraReference(alias);
      candidates = unique([
        ...candidates,
        ...(await transactionCandidates(session, alias)),
        ...(familyCandidate
          ? await transactionCandidates(session, familyCandidate)
          : []),
      ]);
    }
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new AmbiguousClaimError(candidates.slice(0, 10));
  throw new ClaimNotFoundError(searchId);
}

function ensureComplete(rows, sourceName, claimId) {
  if (rows.length > MAX_ROWS_PER_SOURCE) {
    throw new Error(
      `${sourceName} returned more than ${MAX_ROWS_PER_SOURCE.toLocaleString()} rows for claim ${claimId}; refusing to return a silently truncated lifecycle.`,
    );
  }
  return rows;
}

async function loadTransactions(session, claimId) {
  const rows = await session.select(
    `SELECT *
       FROM ${TRANSACTIONS}
      WHERE ENCOUNTERID = ?
      ORDER BY POSTINGDATE ASC, CLAIMTRANSACTIONID ASC
      LIMIT ${MAX_ROWS_PER_SOURCE + 1}`,
    [claimId],
  );
  return ensureComplete(rows, "FlattenTransctions2", claimId);
}

async function loadPatientIdentity(session, claimId) {
  return session.select(
    `SELECT DISTINCT
            NULLIF(TRIM(CAST(PATIENTGUID AS CHAR)), '') AS patientGuid,
            NULLIF(TRIM(EHR), '') AS ehr,
            NULLIF(TRIM(FIRSTNAME), '') AS firstName,
            NULLIF(TRIM(LASTNAME), '') AS lastName,
            DATE(DOB) AS dateOfBirth
       FROM ${TRANSACTIONS}
      WHERE ENCOUNTERID = ?
      LIMIT 11`,
    [claimId],
    { label: "claim.patient-claim-lookup.identity" },
  );
}

function patientLookupIdentity(rows) {
  const patientGuidIdentities = new Map();
  for (const row of rows) {
    const patientGuid = String(row.patientGuid || "").trim();
    const ehr = String(row.ehr || "").trim();
    if (!patientGuid) continue;
    const key = `${patientGuid.toLocaleUpperCase()}|${ehr.toLocaleUpperCase()}`;
    if (!patientGuidIdentities.has(key)) patientGuidIdentities.set(key, { patientGuid, ehr });
  }
  const patientGuids = [...patientGuidIdentities.values()].slice(0, 10);
  if (patientGuids.length) {
    return {
      whereClause: patientGuids.map(({ ehr }) => (
        ehr
          ? "(TRIM(CAST(PATIENTGUID AS CHAR)) = ? AND UPPER(TRIM(EHR)) = UPPER(?))"
          : "TRIM(CAST(PATIENTGUID AS CHAR)) = ?"
      )).join(" OR "),
      parameters: patientGuids.flatMap(({ patientGuid, ehr }) => (
        ehr ? [patientGuid, ehr] : [patientGuid]
      )),
      patientName: rows
        .map((row) => [row.firstName, row.lastName].filter(Boolean).join(" ").trim())
        .find(Boolean) || null,
      matchMethod: "patient_guid",
    };
  }

  const demographics = new Map();
  for (const row of rows) {
    const firstName = String(row.firstName || "").trim();
    const lastName = String(row.lastName || "").trim();
    const dateOfBirth = String(row.dateOfBirth || "").slice(0, 10);
    if (!firstName || !lastName || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) continue;
    const key = `${firstName.toLocaleUpperCase()}|${lastName.toLocaleUpperCase()}|${dateOfBirth}`;
    if (!demographics.has(key)) demographics.set(key, { firstName, lastName, dateOfBirth });
  }
  const identities = [...demographics.values()].slice(0, 10);
  if (!identities.length) throw new PatientIdentityUnavailableError();

  return {
    whereClause: identities.map(() => (
      "(UPPER(TRIM(FIRSTNAME)) = UPPER(?) AND UPPER(TRIM(LASTNAME)) = UPPER(?) AND DATE(DOB) = ?)"
    )).join(" OR "),
    parameters: identities.flatMap(({ firstName, lastName, dateOfBirth }) => (
      [firstName, lastName, dateOfBirth]
    )),
    patientName: `${identities[0].firstName} ${identities[0].lastName}`,
    matchMethod: "name_and_date_of_birth",
  };
}

function patientClaimResult(row, matchedCode) {
  return Object.freeze({
    claimId: normalizeIdentifier(row.claimId),
    serviceDate: String(row.serviceDate || "").slice(0, 10) || null,
    lastActivityDate: String(row.lastActivityDate || "").slice(0, 10) || null,
    status: String(row.status || "").trim() || "Claim located",
    payer: String(row.payer || "").trim() || null,
    provider: String(row.provider || "").trim() || null,
    location: String(row.location || "").trim() || null,
    matchedCode,
    procedureCodes: unique(String(row.procedureCodes || "").split(",").map(normalizeIdentifier)),
  });
}

export async function searchPatientClaimsByProcedure(session, searchId, procedureCode) {
  const claimId = await resolveTransactionClaimId(session, searchId);
  const identityRows = await loadPatientIdentity(session, claimId);
  if (!identityRows.length) throw new ClaimNotFoundError(searchId);

  const identity = patientLookupIdentity(identityRows);
  const matchedCode = normalizeIdentifier(procedureCode);
  const rows = await session.select(
    `SELECT CAST(claim_rows.ENCOUNTERID AS CHAR) AS claimId,
            DATE(MIN(claim_rows.DATEOFSERVICE)) AS serviceDate,
            DATE(MAX(claim_rows.POSTINGDATE)) AS lastActivityDate,
            SUBSTRING_INDEX(
              GROUP_CONCAT(
                NULLIF(TRIM(claim_rows.CLAIMTRANSACTIONTYPENAME), '')
                ORDER BY claim_rows.POSTINGDATE DESC, claim_rows.CLAIMTRANSACTIONID DESC
                SEPARATOR '|||'
              ),
              '|||',
              1
            ) AS status,
            MAX(NULLIF(TRIM(claim_rows.PayerPlan1), '')) AS payer,
            MAX(NULLIF(TRIM(claim_rows.Provider), '')) AS provider,
            MAX(NULLIF(TRIM(claim_rows.Location), '')) AS location,
            GROUP_CONCAT(
              DISTINCT UPPER(TRIM(claim_rows.PROCEDURECODE))
              ORDER BY UPPER(TRIM(claim_rows.PROCEDURECODE))
              SEPARATOR ','
            ) AS procedureCodes
       FROM ${TRANSACTIONS} AS claim_rows
       JOIN (
         SELECT ENCOUNTERID, MAX(DATEOFSERVICE) AS latestMatchingServiceDate
           FROM ${TRANSACTIONS}
          WHERE ENCOUNTERID IS NOT NULL
            AND (${identity.whereClause})
            AND UPPER(TRIM(PROCEDURECODE)) = ?
          GROUP BY ENCOUNTERID
          ORDER BY latestMatchingServiceDate DESC, ENCOUNTERID DESC
          LIMIT ${MAX_PATIENT_CLAIM_RESULTS + 1}
       ) AS matching_claims
         ON matching_claims.ENCOUNTERID = claim_rows.ENCOUNTERID
      GROUP BY claim_rows.ENCOUNTERID
      ORDER BY serviceDate DESC, claimId DESC`,
    [...identity.parameters, matchedCode],
    { label: "claim.patient-claim-lookup.search" },
  );

  return Object.freeze({
    patientName: identity.patientName,
    matchedCode,
    matchMethod: identity.matchMethod,
    total: Math.min(rows.length, MAX_PATIENT_CLAIM_RESULTS),
    hasMore: rows.length > MAX_PATIENT_CLAIM_RESULTS,
    claims: Object.freeze(rows.slice(0, MAX_PATIENT_CLAIM_RESULTS).map((row) => (
      patientClaimResult(row, matchedCode)
    ))),
  });
}

async function loadClaimStatus(session, claimId) {
  const rows = await session.select(
    `SELECT *
       FROM ${CLAIM_STATUS}
      WHERE PatientControlNumber LIKE ?
        AND PatientControlNumber REGEXP ?
      ORDER BY CheckEftDate ASC, ImportedAtUtc ASC, ClaimStatusId ASC
      LIMIT ${MAX_ROWS_PER_SOURCE + 1}`,
    [`${claimId}%`, `^${claimId}[A-Za-z]*$`],
  );

  return ensureComplete(rows, "ClaimStatus", claimId).filter(
    (row) => submissionSuffix(claimId, row.PatientControlNumber) !== null,
  );
}

async function loadEdi835(session, claimId) {
  const rows = await session.select(
    `SELECT *
       FROM ${EDI_835}
      WHERE patient_control_number LIKE ?
        AND patient_control_number REGEXP ?
      ORDER BY payment_date ASC, service_date ASC, id ASC
      LIMIT ${MAX_ROWS_PER_SOURCE + 1}`,
    [`${claimId}%`, `^${claimId}[A-Za-z]*$`],
  );

  return ensureComplete(rows, "edi_835", claimId).filter(
    (row) => submissionSuffix(claimId, row.patient_control_number) !== null,
  );
}

async function loadPriorAuthorizations(session, claimId) {
  return session.select(
    `SELECT
       auth.Authorization_UID AS authorizationId,
       auth.AuthorizationNumber AS authorizationNumber,
       auth.Description AS authorizationDescription,
       auth.EffectiveDate AS effectiveDate,
       auth.ExpirationDate AS expirationDate,
       status.Description AS authorizationStatus,
       rp.PatientFID AS patientId,
       pt.ChartNumber AS chartNumber,
       pt.LastName AS patientLastName,
       pt.FirstName AS patientFirstName,
       pt.DOB AS patientDateOfBirth,
       aa.AppointmentFID AS appointmentId,
       app.StartDateTime AS appointmentDateTime,
       app.ApptTypes AS appointmentType,
       app.ApptStatus AS appointmentStatus,
       app.FacilityFID AS facilityId,
       facility.FacilityName AS facility,
       ac.AuthorizationCount_UID AS authorizationCountId,
       ac.AuthorizedVisits AS authorizedVisits,
       ac.AuthorizedUnits AS authorizedUnits,
       ac.RemainingVisits AS remainingVisits,
       ac.RemainingUnits AS remainingUnits,
       auth_code.ProcedureCodeFID AS procedureCodeId,
       pcc.ChargeCode AS procedureCode
     FROM ${EHR}.\`vw_ODBC_pt_Authorizations\` AS auth
     JOIN ${EHR}.\`vw_ODBC_pt_ReferralPlans\` AS rp
       ON rp.ReferralPlan_UID = auth.ReferralPlanFID
      AND rp.LicenseKey = auth.LicenseKey
     LEFT JOIN ${EHR}.\`vw_ODBC_pt_PatientInfo\` AS pt
       ON pt.Patient_UID = rp.PatientFID
      AND pt.LicenseKey = auth.LicenseKey
     LEFT JOIN ${EHR}.\`vw_ODBC_mf_ReferralPlanStatusCodes\` AS status
       ON status.ReferralPlanStatus_UID = auth.StatusFID
      AND status.LicenseKey = auth.LicenseKey
     JOIN ${EHR}.\`vw_ODBC_appts_lnk_Appointments_Authorizations\` AS aa
       ON aa.AuthorizationFID = auth.Authorization_UID
      AND aa.LicenseKey = auth.LicenseKey
     LEFT JOIN ${EHR}.\`vw_ODBC_appts_Appointments\` AS app
       ON app.Appointment_UID = aa.AppointmentFID
      AND app.LicenseKey = aa.LicenseKey
     LEFT JOIN ${EHR}.\`vw_ODBC_mf_Facilities\` AS facility
       ON facility.Facility_UID = app.FacilityFID
      AND facility.LicenseKey = app.LicenseKey
     LEFT JOIN ${EHR}.\`vw_ODBC_pt_AuthorizationCounts\` AS ac
       ON ac.AuthorizationFID = auth.Authorization_UID
      AND ac.LicenseKey = auth.LicenseKey
     LEFT JOIN ${EHR}.\`vw_ODBC_pt_lnk_AuthorizationCount_ProcedureCodes\` AS auth_code
       ON auth_code.AuthorizationCountFID = ac.AuthorizationCount_UID
      AND auth_code.LicenseKey = ac.LicenseKey
     LEFT JOIN ${EHR}.\`vw_ODBC_mf_ProcChargeCodes\` AS pcc
       ON pcc.ChargeCode_UID = auth_code.ProcedureCodeFID
      AND pcc.LicenseKey = auth_code.LicenseKey
    WHERE auth.LicenseKey = ?
      AND aa.AppointmentFID = ?
    ORDER BY auth.Authorization_UID, app.StartDateTime,
             ac.AuthorizationCount_UID, pcc.ChargeCode`,
    [config.ehr.licenseKey, claimId],
    { label: "claim.prior-authorization" },
  );
}

function patientIdentities(rows) {
  const identities = new Map();
  for (const row of rows) {
    const firstName = String(row.FIRSTNAME || "").trim();
    const lastName = String(row.LASTNAME || "").trim();
    if (!firstName || !lastName) continue;
    const key = `${firstName.toLocaleUpperCase()}|${lastName.toLocaleUpperCase()}`;
    if (!identities.has(key)) identities.set(key, { firstName, lastName });
  }
  return [...identities.values()].slice(0, 10);
}

function ensureInvoiceRows(rows, matchDescription) {
  if (rows.length > MAX_INVOICE_ROWS) {
    throw new Error(
      `patient_invoices returned more than ${MAX_INVOICE_ROWS} ${matchDescription} rows; refusing to return a silently truncated invoice list.`,
    );
  }
  return rows;
}

async function selectInvoiceRows(session, whereClause, parameters, label) {
  const rows = await session.select(
    `SELECT ${INVOICE_COLUMNS}
       FROM ${PATIENT_INVOICES}
      WHERE ${whereClause}
      ORDER BY DateOfService ASC, InvoiceNumber ASC, LineIndex ASC, id ASC
      LIMIT ${MAX_INVOICE_ROWS + 1}`,
    parameters,
    { label },
  );
  return ensureInvoiceRows(rows, label);
}

async function claimCandidatesForServiceDates(session, serviceDates, procedureCodes = []) {
  const dateClauses = serviceDates.map(() => (
    "(DATEOFSERVICE >= ? AND DATEOFSERVICE < DATE_ADD(?, INTERVAL 1 DAY))"
  )).join(" OR ");
  const normalizedProcedureCodes = unique(procedureCodes.map(normalizeIdentifier));
  const procedureClause = normalizedProcedureCodes.length
    ? `AND UPPER(TRIM(PROCEDURECODE)) IN (${normalizedProcedureCodes.map(() => "?").join(",")})`
    : "";
  const rows = await session.select(
    `SELECT DATE(DATEOFSERVICE) AS serviceDate,
            CAST(ENCOUNTERID AS CHAR) AS claimId
      FROM ${TRANSACTIONS}
      WHERE ENCOUNTERID IS NOT NULL
        AND (${dateClauses})
        ${procedureClause}
      GROUP BY DATE(DATEOFSERVICE), ENCOUNTERID
      ORDER BY serviceDate ASC, claimId ASC
      LIMIT ${MAX_INVOICE_ROWS + 1}`,
    [
      ...serviceDates.flatMap((serviceDate) => [serviceDate, serviceDate]),
      ...normalizedProcedureCodes,
    ],
    { label: "claim.patient-invoices.service-date-claim-candidates" },
  );
  if (rows.length > MAX_INVOICE_ROWS) {
    throw new Error(
      `More than ${MAX_INVOICE_ROWS} claims share the invoice service date; refusing to return a silently truncated ambiguity list.`,
    );
  }

  const byServiceDate = new Map(serviceDates.map((serviceDate) => [serviceDate, []]));
  for (const row of rows) {
    const serviceDate = String(row.serviceDate || "").slice(0, 10);
    const claimId = normalizeIdentifier(row.claimId);
    if (!byServiceDate.has(serviceDate) || !claimId) continue;
    byServiceDate.get(serviceDate).push(claimId);
  }
  return [...byServiceDate].map(([serviceDate, candidateClaimIds]) => ({
    serviceDate,
    candidateClaimIds: unique(candidateClaimIds),
  }));
}

async function loadDateOnlyInvoiceFallback(session, serviceDates, priorMessage) {
  const datePlaceholders = serviceDates.map(() => "?").join(",");
  const rows = await selectInvoiceRows(
    session,
    `DateOfService IN (${datePlaceholders})`,
    serviceDates,
    "claim.patient-invoices.service-date-only",
  );
  if (!rows.length) {
    return {
      rows: [],
      status: "no_match",
      matchMethod: null,
      matchedCpts: [],
      matchedProducts: [],
      isAmbiguous: false,
      candidateClaimIds: [],
      candidateClaimsByServiceDate: [],
      message: priorMessage,
    };
  }

  const candidateClaimsByServiceDate = await claimCandidatesForServiceDates(session, serviceDates);
  const candidateClaimIds = unique(
    candidateClaimsByServiceDate.flatMap(({ candidateClaimIds: ids }) => ids),
  );
  const ambiguousDates = candidateClaimsByServiceDate.filter(
    ({ candidateClaimIds: ids }) => ids.length > 1,
  );
  const isAmbiguous = ambiguousDates.length > 0;
  const ambiguitySummary = ambiguousDates.map(({ serviceDate, candidateClaimIds: ids }) => (
    `${serviceDate} matches ${ids.length} claims (${ids.join(", ")})`
  )).join("; ");

  return {
    rows,
    status: isAmbiguous ? "ambiguous_date_fallback" : "ready_date_fallback",
    matchMethod: "service_date_only",
    matchedCpts: [],
    matchedProducts: [],
    isAmbiguous,
    candidateClaimIds,
    candidateClaimsByServiceDate,
    message: isAmbiguous
      ? `Matched invoice rows by date of service only. Review required because ${ambiguitySummary}.`
      : "Patient/date and mapped-CPT matching returned no invoice. Matched invoice rows by date of service only.",
  };
}

async function loadPatientInvoices(session, transactions) {
  const serviceDates = unique(
    transactions.map((row) => String(row.DATEOFSERVICE || "").slice(0, 10)),
  ).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).slice(0, 50);
  const identities = patientIdentities(transactions);
  if (!serviceDates.length) {
    return {
      rows: [],
      status: "insufficient_identity",
      matchMethod: null,
      matchedCpts: [],
      matchedProducts: [],
      isAmbiguous: false,
      candidateClaimIds: [],
      candidateClaimsByServiceDate: [],
      message: "A date of service was not available for invoice matching.",
    };
  }

  const datePlaceholders = serviceDates.map(() => "?").join(",");
  if (identities.length) {
    const identityClauses = identities
      .map(() => "(UPPER(TRIM(pt_FirstName)) = UPPER(?) AND UPPER(TRIM(pt_LastName)) = UPPER(?))")
      .join(" OR ");
    const identityParameters = identities.flatMap(({ firstName, lastName }) => [firstName, lastName]);
    const exactRows = await selectInvoiceRows(
      session,
      `DateOfService IN (${datePlaceholders}) AND (${identityClauses})`,
      [...serviceDates, ...identityParameters],
      "claim.patient-invoices.exact-patient-date",
    );
    if (exactRows.length) {
      return {
        rows: exactRows,
        status: "ready",
        matchMethod: "patient_and_service_date",
        matchedCpts: [],
        matchedProducts: [],
        isAmbiguous: false,
        candidateClaimIds: [],
        candidateClaimsByServiceDate: [],
        message: "Invoice rows matched the claim's exact patient first name, last name, and date of service.",
      };
    }
  }

  const claimCpts = new Set(transactions.map((row) => normalizeIdentifier(row.PROCEDURECODE)).filter(Boolean));
  const eligibleMappings = PATIENT_INVOICE_CPT_MAPPINGS.filter(({ cpt }) => claimCpts.has(cpt));
  if (eligibleMappings.length) {
    const productExpression = "UPPER(CONCAT_WS(' ', ProductName, Description, ProcedureName))";
    const productClauses = eligibleMappings.map(() => `${productExpression} LIKE ?`).join(" OR ");
    const candidateRows = await selectInvoiceRows(
      session,
      `DateOfService IN (${datePlaceholders}) AND (${productClauses})`,
      [...serviceDates, ...eligibleMappings.map(({ queryPattern }) => queryPattern)],
      "claim.patient-invoices.mapped-cpt-candidates",
    );
    const matchedMappings = eligibleMappings.filter(({ product }) => {
      const productKey = normalizeIdentifier(product);
      return candidateRows.some((row) => invoiceProductText(row).includes(productKey));
    });
    if (matchedMappings.length) {
      const matchedProductKeys = matchedMappings.map(({ product }) => normalizeIdentifier(product));
      const matchedCandidates = candidateRows.filter((row) => matchedProductKeys.some(
        (productKey) => invoiceProductText(row).includes(productKey),
      ));
      const invoiceNumbers = unique(matchedCandidates.map((row) => String(row.InvoiceNumber || "").trim()));
      const fallbackRows = invoiceNumbers.length
        ? await selectInvoiceRows(
          session,
          `DateOfService IN (${datePlaceholders}) AND InvoiceNumber IN (${invoiceNumbers.map(() => "?").join(",")})`,
          [...serviceDates, ...invoiceNumbers],
          "claim.patient-invoices.mapped-cpt-lines",
        )
        : matchedCandidates;
      const matchedCpts = matchedMappings.map(({ cpt }) => cpt);
      const matchedProducts = matchedMappings.map(({ product }) => product);
      const candidateClaimsByServiceDate = await claimCandidatesForServiceDates(
        session,
        serviceDates,
        matchedCpts,
      );
      const candidateClaimIds = unique(
        candidateClaimsByServiceDate.flatMap(({ candidateClaimIds: ids }) => ids),
      );
      const isAmbiguous = candidateClaimsByServiceDate.some(
        ({ candidateClaimIds: ids }) => ids.length > 1,
      );
      return {
        rows: fallbackRows,
        status: isAmbiguous ? "ambiguous_cpt_fallback" : "ready_cpt_fallback",
        matchMethod: "service_date_and_cpt",
        matchedCpts,
        matchedProducts,
        isAmbiguous,
        candidateClaimIds,
        candidateClaimsByServiceDate,
        message: isAmbiguous
          ? `Matched by date of service and mapped claim CPT ${matchedCpts.join(", ")} (${matchedProducts.join(", ")}). Multiple claims share that date and CPT, so the invoices are presented as a review pool.`
          : `Patient/date matching returned no invoice. Matched by date of service and mapped claim CPT ${matchedCpts.join(", ")} (${matchedProducts.join(", ")}).`,
      };
    }
  }

  const priorMessage = eligibleMappings.length
    ? `No invoice matched the patient and date of service, the mapped claim CPT${eligibleMappings.length === 1 ? "" : "s"} ${eligibleMappings.map(({ cpt }) => cpt).join(", ")}, or the date of service alone.`
    : "No invoice matched the patient and date of service or the date of service alone, and the claim has none of the configured invoice fallback CPT codes.";
  return loadDateOnlyInvoiceFallback(session, serviceDates, priorMessage);
}

export async function readClaimSources(session, searchId) {
  const claimId = await resolveTransactionClaimId(session, searchId);
  const transactions = await loadTransactions(session, claimId);

  if (transactions.length === 0) throw new ClaimNotFoundError(searchId);

  const [claimStatus, edi835, priorAuthorizations, invoiceLookup, advancedMdEra] = await Promise.all([
    loadClaimStatus(session, claimId),
    loadEdi835(session, claimId),
    loadPriorAuthorizations(session, claimId),
    loadPatientInvoices(session, transactions),
    transactions.some((row) => row.EHR === config.ehr.transactionSource)
      ? readAdvancedMdEra(session, { claimIds: [claimId] }) : [],
  ]);

  return Object.freeze({
    claimId,
    transactions,
    claimStatus,
    edi835,
    advancedMdEra,
    priorAuthorizations,
    patientInvoices: invoiceLookup.rows,
    patientInvoiceLookup: Object.freeze({
      status: invoiceLookup.status,
      matchMethod: invoiceLookup.matchMethod,
      matchedCpts: Object.freeze(invoiceLookup.matchedCpts),
      matchedProducts: Object.freeze(invoiceLookup.matchedProducts),
      isAmbiguous: invoiceLookup.isAmbiguous,
      candidateClaimIds: Object.freeze(invoiceLookup.candidateClaimIds),
      candidateClaimsByServiceDate: Object.freeze(invoiceLookup.candidateClaimsByServiceDate.map((entry) => Object.freeze({
        serviceDate: entry.serviceDate,
        candidateClaimIds: Object.freeze(entry.candidateClaimIds),
      }))),
      message: invoiceLookup.message,
    }),
  });
}
