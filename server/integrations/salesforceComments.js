import { config } from "../config.js";

export class SalesforceReadError extends Error {
  constructor(message, code = "SALESFORCE_READ_FAILED") {
    super(message);
    this.name = "SalesforceReadError";
    this.code = code;
  }
}

export function assertReadOnlySoql(soql) {
  const value = String(soql || "").trim();
  if (!/^SELECT\b/i.test(value)) {
    throw new SalesforceReadError("Only Salesforce SELECT queries are allowed", "UNSAFE_SOQL");
  }
  if (value.includes(";") || /\bFOR\s+UPDATE\b/i.test(value)) {
    throw new SalesforceReadError("Salesforce query must be one non-locking SELECT", "UNSAFE_SOQL");
  }
  return value;
}

export function soqlQuote(value) {
  return `'${String(value ?? "").replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function claimIdentifierCandidates(claim) {
  return [...new Set([
    claim?.claimId,
    claim?.encounterId,
    ...(claim?.alternateIdentifiers || []),
    ...(claim?.submissionReferences || []),
  ].map((value) => String(value || "").trim()).filter((value) => value && value.length <= 120))]
    .slice(0, 25);
}

export function canonicalSalesforceClaimToken(value) {
  let candidate = String(value || "").trim().toUpperCase();
  const archive = candidate.match(/^ARCHIVE-([^-]+)-/);
  if (archive) candidate = archive[1];
  const claim835 = candidate.match(/^(\d+)Z70886$/);
  if (claim835) return claim835[1];
  const correction = candidate.match(/^(\d+)[A-Z]$/);
  if (correction) return correction[1];
  return candidate;
}

async function parseJsonResponse(response, operation) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SalesforceReadError(`${operation} returned HTTP ${response.status}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SalesforceReadError(`${operation} returned an unexpected response`);
  }
  return payload;
}

export class SalesforceClient {
  constructor(settings = config.salesforce, fetchImplementation = globalThis.fetch) {
    this.settings = settings;
    this.fetch = fetchImplementation;
    this.instanceUrl = "";
    this.accessToken = "";
  }

  async authenticate() {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.settings.clientId,
      client_secret: this.settings.clientSecret,
      refresh_token: this.settings.refreshToken,
    });
    const response = await this.fetch(`${this.settings.loginUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.settings.timeoutMs),
    });
    const payload = await parseJsonResponse(response, "Salesforce authentication");
    const instanceUrl = String(payload.instance_url || "").replace(/\/$/, "");
    const accessToken = String(payload.access_token || "");
    let parsed;
    try {
      parsed = new URL(instanceUrl);
    } catch {
      throw new SalesforceReadError("Salesforce token response omitted a valid instance URL");
    }
    if (parsed.protocol !== "https:" || !accessToken) {
      throw new SalesforceReadError("Salesforce token response omitted connection details");
    }
    this.instanceUrl = instanceUrl;
    this.accessToken = accessToken;
  }

  async query(soql, retryAuthentication = true) {
    const select = assertReadOnlySoql(soql);
    if (!this.accessToken) await this.authenticate();

    let url = `${this.instanceUrl}/services/data/${this.settings.apiVersion}/query?${new URLSearchParams({ q: select })}`;
    const records = [];
    while (url) {
      const response = await this.fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      if (response.status === 401 && retryAuthentication) {
        this.accessToken = "";
        this.instanceUrl = "";
        return this.query(select, false);
      }
      const payload = await parseJsonResponse(response, "Salesforce query");
      if (!Array.isArray(payload.records)) {
        throw new SalesforceReadError("Salesforce query response omitted records");
      }
      records.push(...payload.records.filter((record) => record && typeof record === "object"));
      const nextPath = String(payload.nextRecordsUrl || "");
      if (nextPath && !nextPath.startsWith("/services/data/")) {
        throw new SalesforceReadError("Salesforce returned an invalid pagination URL");
      }
      url = nextPath ? `${this.instanceUrl}${nextPath}` : "";
    }
    return records;
  }
}

function integration(status, overrides = {}) {
  return {
    status,
    caseStatus: null,
    caseCount: 0,
    commentCount: 0,
    truncated: false,
    message: "",
    ...overrides,
  };
}

function text(value) {
  return String(value ?? "").trim();
}

function money(value) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", "").replace("$", ""));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function dateOnly(value) {
  const candidate = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function mapNote(record, caseRecord, index, settings) {
  const rawText = text(record[settings.noteTextField]);
  return {
    commentId: text(record.Id) || `salesforce-note-${index + 1}`,
    caseId: text(record[settings.noteCaseField]),
    claimReference: text(caseRecord?.[settings.claimIdField]),
    caseStatus: text(caseRecord?.[settings.statusField]),
    createdAt: text(record.CreatedDate),
    date: dateOnly(record.CreatedDate),
    action: text(record[settings.noteActionField]),
    followUpAction: text(record[settings.noteFollowupField]),
    text: rawText.slice(0, config.gemini.maxCommentChars),
    textTruncated: rawText.length > config.gemini.maxCommentChars,
    paid: money(record[settings.notePaidField]),
    allowed: money(record[settings.noteAllowedField]),
    amount: money(record[settings.noteAmountField]),
    checkEft: text(record[settings.noteCheckField]),
    clearedDate: dateOnly(record[settings.noteClearedField]),
    issueDate: dateOnly(record[settings.noteIssueField]),
    paymentPostingIssue: Boolean(record[settings.notePostingIssueField]),
  };
}

let defaultClient;

export async function readSalesforceClaimComments(claim, options = {}) {
  const settings = options.settings || config.salesforce;
  if (settings.partial) {
    return { comments: [], integration: integration("misconfigured", {
      message: "Salesforce comment integration is partially configured. Complete all Salesforce OAuth values in .env.",
    }) };
  }
  if (!settings.configured) {
    return { comments: [], integration: integration("not_configured", {
      message: "Salesforce comments are unavailable until Salesforce OAuth values are populated in .env.",
    }) };
  }

  const identifiers = claimIdentifierCandidates(claim);
  if (!identifiers.length) {
    return { comments: [], integration: integration("no_claim_identifier", {
      message: "No exact claim identifier was available for the Salesforce lookup.",
    }) };
  }

  const client = options.client || (defaultClient ||= new SalesforceClient(settings));
  const caseFields = [
    "Id",
    "CreatedDate",
    "LastModifiedDate",
    settings.statusField,
    settings.claimIdField,
    settings.icnField,
  ].join(",");
  const baseClaimId = String(claim.encounterId || claim.claimId || "").trim();
  const caseClauses = [`${settings.claimIdField} IN (${identifiers.map(soqlQuote).join(",")})`];
  if (baseClaimId) {
    caseClauses.push(`${settings.claimIdField} LIKE ${soqlQuote(`${baseClaimId}%`)}`);
    caseClauses.push(`${settings.claimIdField} LIKE ${soqlQuote(`ARCHIVE-${baseClaimId}%`)}`);
  }
  const candidateCases = await client.query(
    `SELECT ${caseFields} FROM ${settings.caseObject} WHERE (${caseClauses.join(" OR ")}) ORDER BY CreatedDate LIMIT 201`,
  );
  if (candidateCases.length > 200) {
    throw new SalesforceReadError("More than 200 Salesforce cases matched the bounded claim-family lookup");
  }
  const exactIdentifiers = new Set(identifiers.map((value) => value.toUpperCase()));
  const canonicalBase = canonicalSalesforceClaimToken(baseClaimId);
  const cases = candidateCases.filter((record) => {
    const reference = text(record[settings.claimIdField]).toUpperCase();
    return exactIdentifiers.has(reference)
      || (canonicalBase && canonicalSalesforceClaimToken(reference) === canonicalBase);
  });
  if (!cases.length) {
    return { comments: [], integration: integration("no_case", {
      message: "No Salesforce case matched the claim's exact ENCOUNTERID, correction/archive family, or alternate claim identifiers.",
    }) };
  }

  const latestCase = cases.at(-1);
  const caseStatus = text(latestCase?.[settings.statusField]) || null;
  const caseIds = cases.map((record) => text(record.Id)).filter(Boolean);
  const caseById = new Map(cases.map((record) => [text(record.Id), record]));
  const noteFields = [
    "Id",
    settings.noteCaseField,
    "CreatedDate",
    settings.noteActionField,
    settings.noteFollowupField,
    settings.noteTextField,
    settings.notePaidField,
    settings.noteAllowedField,
    settings.noteAmountField,
    settings.noteCheckField,
    settings.noteClearedField,
    settings.noteIssueField,
    settings.notePostingIssueField,
  ].join(",");
  const noteRows = await client.query(
    `SELECT ${noteFields} FROM ${settings.noteObject} WHERE ${settings.noteCaseField} IN (${caseIds.map(soqlQuote).join(",")}) ORDER BY CreatedDate,Id LIMIT ${settings.maxComments + 1}`,
  );
  if (noteRows.length > settings.maxComments) {
    return { comments: [], integration: integration("comment_limit_exceeded", {
      caseStatus,
      caseCount: cases.length,
      commentCount: noteRows.length,
      truncated: true,
      message: `Salesforce returned more than ${settings.maxComments} comments. Increase SF_MAX_COMMENTS to categorize all comments; none were silently omitted.`,
    }) };
  }

  const comments = noteRows.map((row, index) => mapNote(
    row,
    caseById.get(text(row[settings.noteCaseField])),
    index,
    settings,
  ));
  return {
    comments,
    integration: integration(comments.length ? "ready" : "no_comments", {
      caseStatus,
      caseCount: cases.length,
      commentCount: comments.length,
      message: comments.length
        ? "Salesforce comments were retrieved with query-only access."
        : "The matched Salesforce case has no comments.",
    }),
  };
}
