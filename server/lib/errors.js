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
