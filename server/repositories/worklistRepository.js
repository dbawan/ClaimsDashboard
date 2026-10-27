import { config } from "../config.js";
import { executePermissionsSql } from "../db/permissionsPool.js";

const typesTable = `\`${config.worklists.schema}\`.\`${config.worklists.typesTable}\``;
const claimsTable = `\`${config.worklists.schema}\`.\`${config.worklists.claimsTable}\``;

function parsedJson(value, fallback) {
  if (value == null) return fallback;
  if (Array.isArray(value) || (typeof value === "object" && !Buffer.isBuffer(value))) return value;
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
  } catch {
    return fallback;
  }
}

function worklistTypeFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: Number(row.id),
    name: String(row.type_name || ""),
    checkboxes: Object.freeze(parsedJson(row.checkboxes_json, [])),
    assignmentCount: Number(row.assignment_count || 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  });
}

function claimWorklistFromRow(row) {
  if (!row) return null;
  const completionDetails = parsedJson(row.completion_details_json, {});
  return Object.freeze({
    claimId: String(row.claim_id || ""),
    type: worklistTypeFromRow(row),
    checkedItemIds: Object.freeze(parsedJson(row.checkbox_state_json, [])),
    note: String(row.note_text || ""),
    completionDetails: Object.freeze(
      completionDetails && typeof completionDetails === "object" && !Array.isArray(completionDetails)
        ? completionDetails
        : {},
    ),
    createdAt: row.assignment_created_at || null,
    updatedAt: row.assignment_updated_at || null,
  });
}

const claimWorklistSelect = `SELECT assignment.claim_id,
            assignment.checkbox_state_json,
            assignment.note_text,
            assignment.completion_details_json,
            assignment.created_at AS assignment_created_at,
            assignment.updated_at AS assignment_updated_at,
            type.id,
            type.type_name,
            type.checkboxes_json,
            type.created_at,
            type.updated_at
       FROM ${claimsTable} AS assignment
       JOIN ${typesTable} AS type
         ON type.id = assignment.worklist_type_id`;

async function runQuery(options, sql, parameters = []) {
  const execute = options.execute || executePermissionsSql;
  return execute(sql, parameters);
}

function missingColumn(error) {
  return error?.databaseCode === "ER_BAD_FIELD_ERROR" || error?.code === "ER_BAD_FIELD_ERROR";
}

export async function listClaimWorklistOwners(claimIds, options = {}) {
  const ids = [...new Set((claimIds || []).map((claimId) => String(claimId || "").trim()).filter(Boolean))];
  if (!ids.length) return Object.freeze([]);
  const placeholders = ids.map(() => "?").join(", ");
  let rows;
  try {
    [rows] = await runQuery(
      options,
      `SELECT assignment.claim_id,
              assignment.assigned_by_cognito_uid,
              assignment.assigned_by_name,
              type.type_name
         FROM ${claimsTable} AS assignment
        JOIN ${typesTable} AS type
           ON type.id = assignment.worklist_type_id
        WHERE assignment.claim_id IN (${placeholders})`,
      ids,
    );
  } catch (error) {
    if (!missingColumn(error)) throw error;
    [rows] = await runQuery(
      options,
      `SELECT assignment.claim_id,
              assignment.assigned_by_cognito_uid,
              NULL AS assigned_by_name,
              type.type_name
         FROM ${claimsTable} AS assignment
         JOIN ${typesTable} AS type
           ON type.id = assignment.worklist_type_id
        WHERE assignment.claim_id IN (${placeholders})`,
      ids,
    );
  }
  return Object.freeze(rows.map((row) => Object.freeze({
    claimId: String(row.claim_id || ""),
    ownerId: String(row.assigned_by_cognito_uid || ""),
    ownerName: String(row.assigned_by_name || "").trim() || null,
    worklistType: String(row.type_name || "").trim() || null,
  })));
}

export async function listWorklistTypes(options = {}) {
  const [rows] = await runQuery(
    options,
    `SELECT type.id,
            type.type_name,
            type.checkboxes_json,
            type.created_at,
            type.updated_at,
            (SELECT COUNT(*)
               FROM ${claimsTable} AS assignment
              WHERE assignment.worklist_type_id = type.id) AS assignment_count
       FROM ${typesTable} AS type
      WHERE type.is_active = TRUE
      ORDER BY type.type_name ASC, type.id ASC`,
  );
  return Object.freeze(rows.map(worklistTypeFromRow));
}

export async function findWorklistTypeById(typeId, options = {}) {
  const [rows] = await runQuery(
    options,
    `SELECT type.id,
            type.type_name,
            type.checkboxes_json,
            type.created_at,
            type.updated_at,
            (SELECT COUNT(*)
               FROM ${claimsTable} AS assignment
              WHERE assignment.worklist_type_id = type.id) AS assignment_count
       FROM ${typesTable} AS type
      WHERE type.id = ?
        AND type.is_active = TRUE
      LIMIT 1`,
    [typeId],
  );
  return worklistTypeFromRow(rows[0]);
}

export async function insertWorklistType({ name, checkboxes, actorId }, options = {}) {
  const [result] = await runQuery(
    options,
    `INSERT INTO ${typesTable} (
       type_name,
       checkboxes_json,
       created_by_cognito_uid
     ) VALUES (?, CAST(? AS JSON), ?)`,
    [name, JSON.stringify(checkboxes), actorId],
  );
  return Object.freeze({
    id: Number(result.insertId),
    name,
    checkboxes: Object.freeze(checkboxes),
    assignmentCount: 0,
    createdAt: null,
    updatedAt: null,
  });
}

export async function deactivateWorklistType(typeId, options = {}) {
  const [result] = await runQuery(
    options,
    `UPDATE ${typesTable} AS type
        SET is_active = FALSE,
            updated_at = CURRENT_TIMESTAMP
      WHERE type.id = ?
        AND type.is_active = TRUE`,
    [typeId],
  );
  return Number(result?.affectedRows || 0) === 1;
}

export async function findClaimWorklist(claimId, options = {}) {
  const [rows] = await runQuery(
    options,
    `${claimWorklistSelect}
      WHERE assignment.claim_id = ?
      ORDER BY assignment.created_at ASC, type.type_name ASC
      LIMIT 1`,
    [claimId],
  );
  return claimWorklistFromRow(rows[0]);
}

export async function findClaimWorklists(claimId, options = {}) {
  const [rows] = await runQuery(
    options,
    `${claimWorklistSelect}
      WHERE assignment.claim_id = ?
      ORDER BY assignment.created_at ASC, type.type_name ASC`,
    [claimId],
  );
  return Object.freeze(rows.map(claimWorklistFromRow));
}

export async function findClaimWorklistByTypeId(claimId, typeId, options = {}) {
  const [rows] = await runQuery(
    options,
    `${claimWorklistSelect}
      WHERE assignment.claim_id = ?
        AND assignment.worklist_type_id = ?
      LIMIT 1`,
    [claimId, typeId],
  );
  return claimWorklistFromRow(rows[0]);
}

export async function upsertClaimWorklist({ claimId, typeId, note, actorId, actorName }, options = {}) {
  const currentSql = `INSERT INTO ${claimsTable} (
       claim_id,
       worklist_type_id,
       checkbox_state_json,
       note_text,
       completion_details_json,
       assigned_by_cognito_uid,
       assigned_by_name,
       updated_by_cognito_uid
     )
     SELECT ?, type.id, JSON_ARRAY(), NULLIF(?, ''), JSON_OBJECT(), ?, ?, ?
       FROM ${typesTable} AS type
     WHERE type.id = ?
        AND type.is_active = TRUE
     ON DUPLICATE KEY UPDATE
       note_text = IF(${claimsTable}.worklist_type_id = VALUES(worklist_type_id), VALUES(note_text), ${claimsTable}.note_text),
       assigned_by_cognito_uid = IF(${claimsTable}.worklist_type_id = VALUES(worklist_type_id), VALUES(assigned_by_cognito_uid), ${claimsTable}.assigned_by_cognito_uid),
       assigned_by_name = IF(${claimsTable}.worklist_type_id = VALUES(worklist_type_id), VALUES(assigned_by_name), ${claimsTable}.assigned_by_name),
       updated_by_cognito_uid = IF(${claimsTable}.worklist_type_id = VALUES(worklist_type_id), VALUES(updated_by_cognito_uid), ${claimsTable}.updated_by_cognito_uid),
       updated_at = IF(${claimsTable}.worklist_type_id = VALUES(worklist_type_id), CURRENT_TIMESTAMP, ${claimsTable}.updated_at)`;
  try {
    await runQuery(options, currentSql, [claimId, note, actorId, actorName, actorId, typeId]);
  } catch (error) {
    if (!missingColumn(error)) throw error;
    await runQuery(
      options,
      `INSERT INTO ${claimsTable} (
         claim_id,
         worklist_type_id,
         checkbox_state_json,
         note_text,
         completion_details_json,
         assigned_by_cognito_uid,
         updated_by_cognito_uid
       )
       SELECT ?, type.id, JSON_ARRAY(), NULLIF(?, ''), JSON_OBJECT(), ?, ?
         FROM ${typesTable} AS type
       WHERE type.id = ?
          AND type.is_active = TRUE
       ON DUPLICATE KEY UPDATE
         note_text = IF(${claimsTable}.worklist_type_id = VALUES(worklist_type_id), VALUES(note_text), ${claimsTable}.note_text),
         assigned_by_cognito_uid = IF(${claimsTable}.worklist_type_id = VALUES(worklist_type_id), VALUES(assigned_by_cognito_uid), ${claimsTable}.assigned_by_cognito_uid),
         updated_by_cognito_uid = IF(${claimsTable}.worklist_type_id = VALUES(worklist_type_id), VALUES(updated_by_cognito_uid), ${claimsTable}.updated_by_cognito_uid),
         updated_at = IF(${claimsTable}.worklist_type_id = VALUES(worklist_type_id), CURRENT_TIMESTAMP, ${claimsTable}.updated_at)`,
      [claimId, note, actorId, actorId, typeId],
    );
  }
  return findClaimWorklistByTypeId(claimId, typeId, options);
}

export async function updateClaimWorklistChecks({
  claimId,
  typeId,
  checkedItemIds,
  completionDetails,
  actorId,
}, options = {}) {
  await runQuery(
    options,
    `UPDATE ${claimsTable}
        SET checkbox_state_json = CAST(? AS JSON),
            completion_details_json = CAST(? AS JSON),
            updated_by_cognito_uid = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE claim_id = ?
        AND worklist_type_id = ?`,
    [JSON.stringify(checkedItemIds), JSON.stringify(completionDetails), actorId, claimId, typeId],
  );
  return findClaimWorklistByTypeId(claimId, typeId, options);
}
