import { config } from "../config.js";
import { SalesforceClient, soqlQuote } from "./salesforceComments.js";

const SALESFORCE_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

export class SalesforceNoteWriteError extends Error {
  constructor(message, {
    code = "SALESFORCE_NOTE_CREATE_FAILED",
    statusCode = 502,
    expose = true,
    resultUncertain = false,
  } = {}) {
    super(message);
    this.name = "SalesforceNoteWriteError";
    this.code = code;
    this.statusCode = statusCode;
    this.expose = expose;
    this.resultUncertain = resultUncertain;
    this.retainIdempotency = resultUncertain;
  }
}

function salesforceError(payload, status) {
  const first = Array.isArray(payload) ? payload[0] : null;
  const code = String(first?.errorCode || "");
  if ([
    "FIELD_CUSTOM_VALIDATION_EXCEPTION",
    "INVALID_CROSS_REFERENCE_KEY",
    "INVALID_FIELD_FOR_INSERT_UPDATE",
    "REQUIRED_FIELD_MISSING",
  ].includes(code)) {
    return new SalesforceNoteWriteError(
      "Salesforce rejected the note fields. No note was created.",
      { code: "SALESFORCE_NOTE_REJECTED", statusCode: 422 },
    );
  }
  if (["INSUFFICIENT_ACCESS", "INSUFFICIENT_ACCESS_OR_READONLY"].includes(code)) {
    return new SalesforceNoteWriteError(
      "The Salesforce integration account is not permitted to create this note.",
      { code: "SALESFORCE_NOTE_PERMISSION_DENIED", statusCode: 503 },
    );
  }
  if (status >= 500 || status === 429) {
    return new SalesforceNoteWriteError(
      "Salesforce returned an unavailable response. The result is uncertain; check Salesforce before trying again.",
      {
        code: "SALESFORCE_NOTE_RESULT_UNCERTAIN",
        statusCode: 503,
        resultUncertain: true,
      },
    );
  }
  return new SalesforceNoteWriteError(
    "Salesforce could not create the note. No successful result was returned.",
  );
}

export class SalesforceNoteWriter {
  constructor(settings = config.salesforce, options = {}) {
    this.settings = settings;
    this.fetch = options.fetchImplementation || globalThis.fetch;
    this.readClient = options.readClient || new SalesforceClient(settings, this.fetch);
    this.recordTypeId = "";
  }

  async resolveRecordTypeId() {
    if (this.recordTypeId) return this.recordTypeId;
    const recordTypeName = String(this.settings.noteRecordType || "").trim();
    if (!recordTypeName) return "";

    const rows = await this.readClient.query(
      `SELECT Id,DeveloperName,Name FROM RecordType WHERE SobjectType = ${soqlQuote(this.settings.noteObject)} AND IsActive = TRUE AND (DeveloperName = ${soqlQuote(recordTypeName)} OR Name = ${soqlQuote(recordTypeName)}) LIMIT 2`,
    );
    if (rows.length !== 1 || !SALESFORCE_ID.test(String(rows[0].Id || ""))) {
      throw new SalesforceNoteWriteError(
        `The configured Salesforce note record type “${recordTypeName}” could not be resolved uniquely. No note was created.`,
        { code: "SALESFORCE_NOTE_RECORD_TYPE_INVALID", statusCode: 503 },
      );
    }
    this.recordTypeId = rows[0].Id;
    return this.recordTypeId;
  }

  async createNote({ caseId, text }, retryAuthentication = true) {
    if (!SALESFORCE_ID.test(String(caseId || ""))) {
      throw new SalesforceNoteWriteError(
        "The resolved Salesforce claim ticket ID was invalid. No note was created.",
        { code: "SALESFORCE_CASE_ID_INVALID", statusCode: 422 },
      );
    }

    const recordTypeId = await this.resolveRecordTypeId();
    if (!this.readClient.accessToken) await this.readClient.authenticate();
    const body = {
      [this.settings.noteCaseField]: caseId,
      [this.settings.noteTextField]: text,
      ...(recordTypeId ? { RecordTypeId: recordTypeId } : {}),
    };

    let response;
    try {
      response = await this.fetch(
        `${this.readClient.instanceUrl}/services/data/${this.settings.apiVersion}/sobjects/${this.settings.noteObject}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.readClient.accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.settings.timeoutMs),
        },
      );
    } catch {
      throw new SalesforceNoteWriteError(
        "The Salesforce response was interrupted. The result is uncertain; check Salesforce before trying again.",
        {
          code: "SALESFORCE_NOTE_RESULT_UNCERTAIN",
          statusCode: 503,
          resultUncertain: true,
        },
      );
    }

    if (response.status === 401 && retryAuthentication) {
      this.readClient.accessToken = "";
      this.readClient.instanceUrl = "";
      await this.readClient.authenticate();
      return this.createNote({ caseId, text }, false);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) throw salesforceError(payload, response.status);
    const noteId = String(payload?.id || "");
    if (payload?.success !== true || !SALESFORCE_ID.test(noteId)) {
      throw new SalesforceNoteWriteError(
        "Salesforce returned an unexpected result. The result is uncertain; check Salesforce before trying again.",
        {
          code: "SALESFORCE_NOTE_RESULT_UNCERTAIN",
          statusCode: 502,
          resultUncertain: true,
        },
      );
    }
    return { noteId, caseId };
  }
}
