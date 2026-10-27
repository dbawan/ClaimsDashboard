import { config } from "../config.js";
import {
  claimIdentifierCandidates,
  findSalesforceClaimCases,
} from "../integrations/salesforceComments.js";
import { SalesforceNoteWriter } from "../integrations/salesforceNoteWriter.js";
import { canCreateSalesforceNotes } from "../permissions/salesforceNoteAccess.js";
import { getBaseClaimLifecycle, invalidateClaimEnrichments } from "./claimLifecycleService.js";

const SALESFORCE_NOTE_FIELD_MAX_CHARS = 32_768;
const SUBMISSION_SOURCE = "United Theranostics Claim Lifecycle application";

export class SalesforceNoteRequestError extends Error {
  constructor(message, {
    code = "INVALID_SALESFORCE_NOTE",
    statusCode = 400,
  } = {}) {
    super(message);
    this.name = "SalesforceNoteRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.expose = true;
  }
}

function fieldText(record, field) {
  return String(record?.[field] || "").trim();
}

export function validateSalesforceNoteText(value, maxChars = 5_000) {
  if (typeof value !== "string") {
    throw new SalesforceNoteRequestError("Enter a message to add to the Salesforce claim ticket.");
  }
  const text = value.trim();
  if (!text) {
    throw new SalesforceNoteRequestError("Enter a message to add to the Salesforce claim ticket.");
  }
  if (text.length > maxChars) {
    throw new SalesforceNoteRequestError(
      `The Salesforce message must be ${maxChars.toLocaleString("en-US")} characters or fewer.`,
      { code: "SALESFORCE_NOTE_TOO_LONG", statusCode: 413 },
    );
  }
  if (text.includes("\u0000")) {
    throw new SalesforceNoteRequestError("The Salesforce message contains an unsupported character.");
  }
  return text;
}

function attributionValue(value, maxChars) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

export function salesforceNoteAttribution(actor) {
  const email = attributionValue(actor?.email, 320);
  const name = attributionValue(actor?.name, 200) || email || "Authenticated user";
  const submitter = email && email.toLowerCase() !== name.toLowerCase()
    ? `${name} (${email})`
    : name;

  return [
    "—",
    `Submission source: ${SUBMISSION_SOURCE}`,
    `Submitted by: ${submitter}`,
  ].join("\n");
}

export function formatSalesforceNoteText(text, actor) {
  return `${text}\n\n${salesforceNoteAttribution(actor)}`;
}

function singleLine(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatSalesforceDiagnosisSelection(worklist, { compact = false } = {}) {
  const diagnosis = singleLine(worklist?.type?.name);
  const tasks = (worklist?.type?.checkboxes || [])
    .map(({ label }) => singleLine(label))
    .filter(Boolean);
  if (!diagnosis || !tasks.length) {
    throw new SalesforceNoteRequestError(
      "The selected diagnosis or its assigned tasks could not be included in Salesforce.",
      { code: "INVALID_DIAGNOSIS_NOTIFICATION" },
    );
  }
  return compact
    ? [`Diagnosis: ${diagnosis}`, "Tasks:", ...tasks].join("\n")
    : [
      `Diagnosis chosen: ${diagnosis}`,
      "",
      "Tasks assigned to this claim:",
      ...tasks.map((task, index) => `${index + 1}. ${task}`),
    ].join("\n");
}

export function resolveSalesforceNoteTarget(claim, cases, settings = config.salesforce) {
  if (!cases.length) {
    throw new SalesforceNoteRequestError(
      "No Salesforce claim ticket matched this claim. No note was created.",
      { code: "SALESFORCE_CASE_NOT_FOUND", statusCode: 422 },
    );
  }

  const primaryReference = String(claim.encounterId || claim.claimId || "").trim().toUpperCase();
  const primaryMatches = cases.filter((record) => (
    fieldText(record, settings.claimIdField).toUpperCase() === primaryReference
  ));
  if (primaryMatches.length === 1) return primaryMatches[0];
  if (primaryMatches.length > 1) {
    throw new SalesforceNoteRequestError(
      "More than one Salesforce ticket exactly matched this claim. No note was created.",
      { code: "SALESFORCE_CASE_AMBIGUOUS", statusCode: 409 },
    );
  }

  const exactIdentifiers = new Set(
    claimIdentifierCandidates(claim).map((value) => value.toUpperCase()),
  );
  const exactMatches = cases.filter((record) => (
    exactIdentifiers.has(fieldText(record, settings.claimIdField).toUpperCase())
  ));
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1 || cases.length > 1) {
    throw new SalesforceNoteRequestError(
      "This claim maps to multiple Salesforce tickets. Select an exact ticket in Salesforce before adding a note.",
      { code: "SALESFORCE_CASE_AMBIGUOUS", statusCode: 409 },
    );
  }
  return cases[0];
}

let defaultWriter;

async function writeSalesforceClaimNote(searchId, text, actor, options, settings) {
  const attributedText = formatSalesforceNoteText(text, actor);
  const getClaim = options.getClaim || getBaseClaimLifecycle;
  const lifecycle = await getClaim(searchId);
  const writer = options.writer || (defaultWriter ||= new SalesforceNoteWriter(settings));
  const cases = await findSalesforceClaimCases(lifecycle.claim, {
    settings,
    client: writer.readClient,
  });
  const target = resolveSalesforceNoteTarget(lifecycle.claim, cases, settings);
  const created = await writer.createNote({ caseId: target.Id, text: attributedText });
  (options.invalidateClaimEnrichments || invalidateClaimEnrichments)();

  return {
    status: "created",
    claimId: lifecycle.claim.claimId,
    salesforceCaseId: created.caseId,
    noteId: created.noteId,
  };
}

export async function createSalesforceClaimNote(searchId, input, actor, options = {}) {
  const settings = options.settings || config.salesforce;
  if (!canCreateSalesforceNotes(actor, settings)) {
    throw new SalesforceNoteRequestError(
      "This account is not permitted to add Salesforce claim notes.",
      { code: "PERMISSION_DENIED", statusCode: 403 },
    );
  }
  const attribution = salesforceNoteAttribution(actor);
  const maxBodyChars = Math.min(
    settings.noteMaxChars,
    SALESFORCE_NOTE_FIELD_MAX_CHARS - attribution.length - 2,
  );
  const text = validateSalesforceNoteText(input?.text, maxBodyChars);
  return writeSalesforceClaimNote(searchId, text, actor, options, settings);
}

export async function createSalesforceDiagnosisSelectionNote(
  searchId,
  worklist,
  actor,
  options = {},
) {
  const settings = options.settings || config.salesforce;
  if (!settings.noteWritesEnabled || !settings.configured || !actor?.permissions?.worklistManagement) {
    throw new SalesforceNoteRequestError(
      "Salesforce diagnosis notifications are not available for this account.",
      { code: "DIAGNOSIS_NOTIFICATION_UNAVAILABLE", statusCode: 503 },
    );
  }
  const attribution = salesforceNoteAttribution(actor);
  const maxBodyChars = Math.min(
    settings.noteMaxChars,
    SALESFORCE_NOTE_FIELD_MAX_CHARS - attribution.length - 2,
  );
  const detailedText = formatSalesforceDiagnosisSelection(worklist);
  const text = validateSalesforceNoteText(
    detailedText.length <= maxBodyChars
      ? detailedText
      : formatSalesforceDiagnosisSelection(worklist, { compact: true }),
    maxBodyChars,
  );
  return writeSalesforceClaimNote(searchId, text, actor, options, settings);
}
