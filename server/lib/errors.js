export class ClaimNotFoundError extends Error {
  constructor(claimId) {
    super(`No claim was found for “${claimId}”.`);
    this.name = "ClaimNotFoundError";
    this.statusCode = 404;
    this.code = "CLAIM_NOT_FOUND";
  }
}

export class AmbiguousClaimError extends Error {
  constructor(claimIds) {
    super("That identifier matches more than one claim. Enter the complete claim ID.");
    this.name = "AmbiguousClaimError";
    this.statusCode = 409;
    this.code = "AMBIGUOUS_CLAIM";
    this.claimIds = claimIds;
  }
}

export class DatabaseQueryTimeoutError extends Error {
  constructor(queryLabel, options = {}) {
    super("The database took too long to answer the read-only query.", options);
    this.name = "DatabaseQueryTimeoutError";
    this.statusCode = 504;
    this.code = "DB_QUERY_TIMEOUT";
    this.queryLabel = queryLabel || "unlabeled";
  }
}

export class PatientIdentityUnavailableError extends Error {
  constructor() {
    super("This claim does not include enough patient identity data for a patient-scoped claim lookup.");
    this.name = "PatientIdentityUnavailableError";
    this.statusCode = 422;
    this.code = "PATIENT_IDENTITY_UNAVAILABLE";
    this.expose = true;
  }
}

export class PatientNotFoundError extends Error {
  constructor() {
    super("The selected patient could not be found.");
    this.name = "PatientNotFoundError";
    this.statusCode = 404;
    this.code = "PATIENT_NOT_FOUND";
    this.expose = true;
  }
}
