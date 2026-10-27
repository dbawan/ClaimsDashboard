import { config } from "../config.js";
import {
  closePermissionsPool,
  executePermissionsSql,
  PermissionsDatabaseError,
} from "../db/permissionsPool.js";

export { closePermissionsPool };

export const PERMISSION_KEYS = Object.freeze([
  "claimOverview",
  "paymentsAndEra",
  "supportingRecords",
  "highLevelOperations",
  "worklistAccess",
  "worklistManagement",
]);

export const CLAIM_PERMISSION_KEYS = Object.freeze([
  "claimOverview",
  "paymentsAndEra",
  "supportingRecords",
]);

export const ALL_PERMISSIONS = Object.freeze({
  claimOverview: true,
  paymentsAndEra: true,
  supportingRecords: true,
  highLevelOperations: true,
  worklistAccess: true,
  worklistManagement: true,
});

const qualifiedTable = `\`${config.userPermissions.schema}\`.\`${config.userPermissions.table}\``;

export class PermissionStoreError extends Error {
  constructor(message = "User permissions are temporarily unavailable.") {
    super(message);
    this.name = "PermissionStoreError";
    this.code = "PERMISSIONS_UNAVAILABLE";
    this.statusCode = 503;
    this.expose = true;
  }
}

export class PermissionDeniedError extends Error {
  constructor(message = "This account does not have permission to access this data.") {
    super(message);
    this.name = "PermissionDeniedError";
    this.code = "PERMISSION_DENIED";
    this.statusCode = 403;
    this.expose = true;
  }
}

function normalizedUid(value) {
  const uid = String(value || "").trim();
  if (!uid || uid.length > 128) {
    throw new PermissionStoreError("The SSO user identifier is missing or invalid.");
  }
  return uid;
}

async function execute(sql, parameters = []) {
  try {
    return await executePermissionsSql(sql, parameters);
  } catch (error) {
    if (error instanceof PermissionStoreError) throw error;
    if (error instanceof PermissionsDatabaseError) {
      throw new PermissionStoreError(error.message);
    }
    console.error("User-permission database operation failed:", error?.code || error?.name || "unknown error");
    throw new PermissionStoreError();
  }
}

export function permissionsFromRow(row = {}) {
  return Object.freeze({
    claimOverview: Boolean(Number(row.claim_overview)),
    paymentsAndEra: Boolean(Number(row.payments_and_era)),
    supportingRecords: Boolean(Number(row.supporting_records)),
    highLevelOperations: Boolean(Number(row.high_level_operations)),
    worklistAccess: Boolean(Number(row.worklist_access)),
    worklistManagement: Boolean(Number(row.worklist_management)),
  });
}

export async function provisionUserPermissions(uid, options = {}) {
  const run = options.execute || execute;
  const normalized = normalizedUid(uid);
  try {
    await run(
      `INSERT INTO ${qualifiedTable} (cognito_uid, last_login_at)
       VALUES (?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE last_login_at = UTC_TIMESTAMP()`,
      [normalized],
    );
  } catch (error) {
    if (error instanceof PermissionStoreError) throw error;
    throw new PermissionStoreError();
  }
}

export async function loadUserPermissions(uid, options = {}) {
  const run = options.execute || execute;
  const normalized = normalizedUid(uid);
  let rows;
  try {
    [rows] = await run(
      `SELECT claim_overview,
              payments_and_era,
              supporting_records,
              high_level_operations,
              worklist_access,
              worklist_management
         FROM ${qualifiedTable}
        WHERE cognito_uid = ?
        LIMIT 1`,
      [normalized],
    );
  } catch (error) {
    if (error instanceof PermissionStoreError) throw error;
    throw new PermissionStoreError();
  }

  if (!rows.length) {
    await provisionUserPermissions(normalized, { execute: run });
    return loadUserPermissions(normalized, { execute: run });
  }
  return permissionsFromRow(rows[0]);
}

export function requirePermission(permission) {
  if (!PERMISSION_KEYS.includes(permission)) throw new Error(`Unknown permission: ${permission}`);
  return function permissionMiddleware(request, response, next) {
    if (request.user?.permissions?.[permission]) {
      next();
      return;
    }
    next(new PermissionDeniedError());
  };
}

export function requireAnyPermission(permissions) {
  const keys = [...permissions];
  if (!keys.length || keys.some((permission) => !PERMISSION_KEYS.includes(permission))) {
    throw new Error("requireAnyPermission received an unknown or empty permission list");
  }
  return function anyPermissionMiddleware(request, response, next) {
    if (keys.some((permission) => request.user?.permissions?.[permission])) {
      next();
      return;
    }
    next(new PermissionDeniedError());
  };
}
