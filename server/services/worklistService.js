import { randomUUID } from "node:crypto";
import { normalizeIdentifier } from "../lib/claimIdentity.js";
import * as defaultRepository from "../repositories/worklistRepository.js";
import { getBaseClaimLifecycle } from "./claimLifecycleService.js";

const MAX_TYPE_NAME_CHARS = 120;
const MAX_CHECKBOXES = 40;
const MAX_CHECKBOX_LABEL_CHARS = 120;
const MAX_NOTE_CHARS = 4_000;

export class WorklistRequestError extends Error {
  constructor(message, {
    code = "INVALID_WORKLIST_REQUEST",
    statusCode = 400,
  } = {}) {
    super(message);
    this.name = "WorklistRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.expose = true;
  }
}

function repository(options) {
  return options.repository || defaultRepository;
}

async function resolvedClaimId(searchId, options) {
  const getClaim = options.getClaim || getBaseClaimLifecycle;
  const lifecycle = await getClaim(searchId);
  return validateWorklistClaimId(lifecycle?.claim?.claimId);
}

function actorId(actor) {
  const value = String(actor?.id || "").trim();
  if (!value || value.length > 128) {
    throw new WorklistRequestError("The authenticated user could not be identified.", {
      code: "INVALID_WORKLIST_ACTOR",
      statusCode: 403,
    });
  }
  return value;
}

function actorName(actor) {
  const value = String(actor?.name || actor?.email || actor?.id || "Authenticated user")
    .replace(/\s+/g, " ")
    .trim();
  return value.slice(0, 200) || "Authenticated user";
}

export function validateWorklistClaimId(value) {
  const claimId = normalizeIdentifier(value);
  if (!claimId || claimId.length > 80) {
    throw new WorklistRequestError("Use a valid claim ID for this worklist.", {
      code: "INVALID_WORKLIST_CLAIM",
    });
  }
  return claimId;
}

export function validateWorklistTypeId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{1,20}$/.test(normalized)) {
    throw new WorklistRequestError("Choose a valid worklist type.", {
      code: "INVALID_WORKLIST_TYPE",
    });
  }
  const typeId = Number(normalized);
  if (!Number.isSafeInteger(typeId) || typeId <= 0) {
    throw new WorklistRequestError("Choose a valid worklist type.", {
      code: "INVALID_WORKLIST_TYPE",
    });
  }
  return typeId;
}

function normalizedTypeName(value) {
  if (typeof value !== "string") {
    throw new WorklistRequestError("Enter a worklist type name.");
  }
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) throw new WorklistRequestError("Enter a worklist type name.");
  if (name.length > MAX_TYPE_NAME_CHARS || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new WorklistRequestError(
      `The worklist type name must be ${MAX_TYPE_NAME_CHARS} characters or fewer.`,
      { code: "WORKLIST_NAME_TOO_LONG" },
    );
  }
  return name;
}

function normalizedCheckboxLabels(value) {
  if (!Array.isArray(value) || !value.length) {
    throw new WorklistRequestError("Add at least one checkbox to the worklist type.", {
      code: "WORKLIST_CHECKBOX_REQUIRED",
    });
  }
  if (value.length > MAX_CHECKBOXES) {
    throw new WorklistRequestError(`A worklist type can contain at most ${MAX_CHECKBOXES} checkboxes.`, {
      code: "TOO_MANY_WORKLIST_CHECKBOXES",
    });
  }

  const labels = value.map((item) => String(item?.label ?? item ?? "").replace(/\s+/g, " ").trim());
  if (labels.some((label) => !label)) {
    throw new WorklistRequestError("Every worklist checkbox needs a label.", {
      code: "WORKLIST_CHECKBOX_LABEL_REQUIRED",
    });
  }
  if (labels.some((label) => label.length > MAX_CHECKBOX_LABEL_CHARS || /[\u0000-\u001f\u007f]/.test(label))) {
    throw new WorklistRequestError(
      `Each checkbox label must be ${MAX_CHECKBOX_LABEL_CHARS} characters or fewer.`,
      { code: "WORKLIST_CHECKBOX_LABEL_TOO_LONG" },
    );
  }
  const uniqueLabels = new Set(labels.map((label) => label.toLocaleLowerCase("en-US")));
  if (uniqueLabels.size !== labels.length) {
    throw new WorklistRequestError("Checkbox labels must be unique within a worklist type.", {
      code: "DUPLICATE_WORKLIST_CHECKBOX",
    });
  }
  return labels;
}

function normalizedCheckedItemIds(value, type) {
  if (!Array.isArray(value)) {
    throw new WorklistRequestError("Checked worklist items must be provided as a list.", {
      code: "INVALID_WORKLIST_CHECKS",
    });
  }
  const validIds = new Set(type.checkboxes.map(({ id }) => id));
  const checkedItemIds = [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  if (checkedItemIds.some((id) => !validIds.has(id))) {
    throw new WorklistRequestError("The checklist contains an item that does not belong to this worklist type.", {
      code: "UNKNOWN_WORKLIST_CHECKBOX",
      statusCode: 409,
    });
  }
  return checkedItemIds;
}

function normalizedNote(value) {
  if (value == null) return "";
  if (typeof value !== "string") {
    throw new WorklistRequestError("The diagnosis note must be text.", {
      code: "INVALID_WORKLIST_NOTE",
    });
  }
  const note = value.replace(/\r\n?/g, "\n").trim();
  if (note.length > MAX_NOTE_CHARS || note.includes("\u0000")) {
    throw new WorklistRequestError(
      `The diagnosis note must be ${MAX_NOTE_CHARS.toLocaleString("en-US")} characters or fewer.`,
      { code: "WORKLIST_NOTE_TOO_LONG" },
    );
  }
  return note;
}

function nextCompletionDetails(current, checkedItemIds, actor, now) {
  const previousCheckedIds = new Set(current.checkedItemIds || []);
  const previousDetails = current.completionDetails || {};
  const completedBy = Object.freeze({
    id: actorId(actor),
    name: actorName(actor),
  });
  const entries = [];
  for (const itemId of checkedItemIds) {
    if (previousCheckedIds.has(itemId)) {
      if (previousDetails[itemId]) entries.push([itemId, previousDetails[itemId]]);
      continue;
    }
    entries.push([itemId, Object.freeze({ completedBy, completedAt: now })]);
  }
  return Object.fromEntries(entries);
}

export async function listWorklistTypes(options = {}) {
  return repository(options).listWorklistTypes(options.repositoryOptions);
}

export async function getClaimWorklist(searchId, options = {}) {
  const claimId = validateWorklistClaimId(searchId);
  return repository(options).findClaimWorklist(claimId, options.repositoryOptions);
}

export async function getClaimWorklists(searchId, options = {}) {
  const claimId = validateWorklistClaimId(searchId);
  const store = repository(options);
  if (store.findClaimWorklists) {
    return store.findClaimWorklists(claimId, options.repositoryOptions);
  }
  const worklist = await store.findClaimWorklist(claimId, options.repositoryOptions);
  return worklist ? Object.freeze([worklist]) : Object.freeze([]);
}

export async function createWorklistType(input, actor, options = {}) {
  const name = normalizedTypeName(input?.name);
  const labels = normalizedCheckboxLabels(input?.checkboxes);
  const createId = options.createId || randomUUID;
  const checkboxes = labels.map((label) => Object.freeze({ id: createId(), label }));

  try {
    return await repository(options).insertWorklistType({
      name,
      checkboxes,
      actorId: actorId(actor),
    }, options.repositoryOptions);
  } catch (error) {
    if (error?.databaseCode === "ER_DUP_ENTRY" || error?.code === "ER_DUP_ENTRY") {
      throw new WorklistRequestError("A worklist type with that name already exists.", {
        code: "WORKLIST_TYPE_EXISTS",
        statusCode: 409,
      });
    }
    throw error;
  }
}

export async function removeWorklistType(typeIdValue, actor, options = {}) {
  actorId(actor);
  const typeId = validateWorklistTypeId(typeIdValue);
  const store = repository(options);
  const type = await store.findWorklistTypeById(typeId, options.repositoryOptions);
  if (!type) {
    throw new WorklistRequestError("That worklist type is no longer available.", {
      code: "WORKLIST_TYPE_NOT_FOUND",
      statusCode: 404,
    });
  }
  const removed = await store.deactivateWorklistType(typeId, options.repositoryOptions);
  if (!removed) {
    throw new WorklistRequestError("That worklist type is no longer available.", {
      code: "WORKLIST_TYPE_NOT_FOUND",
      statusCode: 404,
    });
  }
  return Object.freeze({ id: type.id, name: type.name, preservedAssignmentCount: type.assignmentCount });
}

async function assignClaimWorklistResult(searchId, input, actor, options = {}) {
  const claimId = await resolvedClaimId(searchId, options);
  const typeId = validateWorklistTypeId(input?.worklistTypeId);
  const note = normalizedNote(input?.note);
  const store = repository(options);
  const type = await store.findWorklistTypeById(typeId, options.repositoryOptions);
  if (!type) {
    throw new WorklistRequestError("That worklist type is no longer available.", {
      code: "WORKLIST_TYPE_NOT_FOUND",
      statusCode: 404,
    });
  }
  const previous = store.findClaimWorklistByTypeId
    ? await store.findClaimWorklistByTypeId(claimId, typeId, options.repositoryOptions)
    : await store.findClaimWorklist(claimId, options.repositoryOptions);
  const worklist = await store.upsertClaimWorklist({
    claimId,
    typeId,
    note,
    actorId: actorId(actor),
    actorName: actorName(actor),
  }, options.repositoryOptions);
  if (!worklist) {
    throw new WorklistRequestError(
      "This database still allows only one Problem List item per claim. Apply the multiple-worklists migration and try again.",
      { code: "MULTIPLE_WORKLISTS_MIGRATION_REQUIRED", statusCode: 409 },
    );
  }
  return Object.freeze({
    worklist,
    diagnosisChanged: !previous,
  });
}

export async function assignClaimWorklist(searchId, input, actor, options = {}) {
  const result = await assignClaimWorklistResult(searchId, input, actor, options);
  return result.worklist;
}

export async function assignClaimDiagnosis(searchId, input, actor, options = {}) {
  return assignClaimWorklistResult(searchId, input, actor, options);
}

export async function updateClaimWorklistChecks(searchId, input, actor, options = {}) {
  const claimId = await resolvedClaimId(searchId, options);
  const store = repository(options);
  const typeId = input?.worklistTypeId == null
    ? null
    : validateWorklistTypeId(input.worklistTypeId);
  const current = typeId != null && store.findClaimWorklistByTypeId
    ? await store.findClaimWorklistByTypeId(claimId, typeId, options.repositoryOptions)
    : await store.findClaimWorklist(claimId, options.repositoryOptions);
  if (!current) {
    throw new WorklistRequestError("Choose a worklist type for this claim first.", {
      code: "CLAIM_WORKLIST_NOT_FOUND",
      statusCode: 404,
    });
  }
  const checkedItemIds = normalizedCheckedItemIds(input?.checkedItemIds, current.type);
  const completionDetails = nextCompletionDetails(
    current,
    checkedItemIds,
    actor,
    (options.now || (() => new Date()))().toISOString(),
  );
  const updated = await store.updateClaimWorklistChecks({
    claimId,
    typeId: current.type.id,
    checkedItemIds,
    completionDetails,
    actorId: actorId(actor),
  }, options.repositoryOptions);
  if (!updated || updated.type.id !== current.type.id) {
    throw new WorklistRequestError("This claim’s worklist changed while it was being updated. Reload and try again.", {
      code: "CLAIM_WORKLIST_CHANGED",
      statusCode: 409,
    });
  }
  return updated;
}
