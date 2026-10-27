import { readFileSync } from "node:fs";

const MATRIX_URL = new URL("../../expected_reimbursement_matrix.json", import.meta.url);

function normalizedPayer(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function normalizedProcedure(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function matrixKey(procedure, payer) {
  return `${normalizedProcedure(procedure)}|${normalizedPayer(payer)}`;
}

function preparedRecord(record) {
  return Object.freeze({
    procedure: normalizedProcedure(record.procedure_code),
    rawPayer: String(record.raw_payer || "").trim(),
    canonicalPayer: String(record.canonical_payer_after_consolidation || "").trim(),
    payerCategory: String(record.payer_category_after_consolidation || "").trim(),
    ratePerUnit: finiteNumber(record.selected_rate_per_unit),
    observedRows: finiteNumber(record.observed_detail_row_count) || 0,
    trainingRows: finiteNumber(record.selected_scope_training_row_count) || 0,
  });
}

function strongerRecord(left, right) {
  if (!left) return right;
  if (left.ratePerUnit == null && right.ratePerUnit != null) return right;
  if (left.ratePerUnit != null && right.ratePerUnit == null) return left;
  if (right.observedRows !== left.observedRows) {
    return right.observedRows > left.observedRows ? right : left;
  }
  if (right.trainingRows !== left.trainingRows) {
    return right.trainingRows > left.trainingRows ? right : left;
  }
  return left;
}

export function buildExpectedReimbursementIndex(records = []) {
  const raw = new Map();
  const canonical = new Map();

  for (const sourceRecord of records) {
    const record = preparedRecord(sourceRecord);
    if (!record.procedure || !record.rawPayer) continue;
    raw.set(matrixKey(record.procedure, record.rawPayer), record);
    if (record.canonicalPayer) {
      const key = matrixKey(record.procedure, record.canonicalPayer);
      canonical.set(key, strongerRecord(canonical.get(key), record));
    }
  }

  return Object.freeze({ raw, canonical });
}

function loadExpectedReimbursementIndex() {
  const payload = JSON.parse(readFileSync(MATRIX_URL, "utf8"));
  if (!Array.isArray(payload.records)) {
    throw new TypeError("Expected reimbursement matrix must contain a records array");
  }
  return buildExpectedReimbursementIndex(payload.records);
}

const expectedReimbursementIndex = loadExpectedReimbursementIndex();

function findRate(procedure, payerNames, index) {
  for (const payer of payerNames) {
    const record = index.raw.get(matrixKey(procedure, payer));
    if (record) return { record, matchType: "raw_payer" };
  }
  for (const payer of payerNames) {
    const record = index.canonical.get(matrixKey(procedure, payer));
    if (record) return { record, matchType: "canonical_payer" };
  }
  return null;
}

export function calculateExpectedReimbursement({
  payerNames = [],
  cptFinancials = [],
  index = expectedReimbursementIndex,
} = {}) {
  const payerList = Array.isArray(payerNames) ? payerNames : [];
  const cptLines = Array.isArray(cptFinancials) ? cptFinancials : [];
  const payers = [...new Set(payerList.map((payer) => String(payer ?? "").trim()).filter(Boolean))];
  const breakdown = cptLines.map((line) => {
    const procedure = normalizedProcedure(line.procedure);
    const recordedUnits = finiteNumber(line.units);
    const units = recordedUnits > 0 ? recordedUnits : 1;
    const charged = finiteNumber(line.charged);
    const match = findRate(procedure, payers, index);
    const ratePerUnit = match?.record.ratePerUnit ?? null;
    const uncapped = ratePerUnit == null ? null : ratePerUnit * units;
    const expected = uncapped == null
      ? null
      : money(charged != null && charged >= 0 ? Math.min(uncapped, charged) : uncapped);

    return Object.freeze({
      procedure,
      units,
      charged,
      ratePerUnit,
      expected,
      payer: match?.record.rawPayer || null,
      canonicalPayer: match?.record.canonicalPayer || null,
      matchType: match?.matchType || "unmatched",
    });
  });
  const matched = breakdown.filter((line) => line.expected != null);

  return Object.freeze({
    total: matched.length ? money(matched.reduce((sum, line) => sum + line.expected, 0)) : null,
    breakdown: Object.freeze(breakdown),
    matchedCptCount: matched.length,
    totalCptCount: breakdown.length,
    complete: breakdown.length > 0 && matched.length === breakdown.length,
    payer: matched[0]?.payer || null,
  });
}
