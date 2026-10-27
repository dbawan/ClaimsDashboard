import { withReadOnlySession } from "../db/readOnlyPool.js";
import { assertValidClaimSearch, normalizeIdentifier } from "../lib/claimIdentity.js";
import { searchPatientClaimsByProcedure } from "../repositories/claimRepository.js";
import { DATA_CACHE_TTL_MS } from "../lib/dataCache.js";
import { createTtlCache } from "../lib/ttlCache.js";

const patientProcedureCache = createTtlCache({ ttlMs: DATA_CACHE_TTL_MS });

export function assertValidProcedureCode(value) {
  const code = normalizeIdentifier(value);
  if (!/^(?:\d{5}|[A-Z]\d{4}|\d{4}[A-Z])$/.test(code)) {
    const error = new Error(
      "Enter a 5-character CPT or HCPCS code, such as 78815, A9607, or J2405.",
    );
    error.statusCode = 400;
    error.code = "INVALID_PROCEDURE_CODE";
    error.expose = true;
    throw error;
  }
  return code;
}

export async function getPatientClaimsByProcedure(searchId, procedureCode, options = {}) {
  const validatedClaimId = assertValidClaimSearch(searchId);
  const validatedCode = assertValidProcedureCode(procedureCode);
  const run = options.withReadOnlySession || withReadOnlySession;
  const search = options.searchPatientClaimsByProcedure || searchPatientClaimsByProcedure;
  return (options.cache || patientProcedureCache).getOrLoad(
    JSON.stringify([normalizeIdentifier(validatedClaimId), validatedCode]),
    () => run((session) => search(session, validatedClaimId, validatedCode)),
  );
}
