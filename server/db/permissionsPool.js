import mysql from "mysql2/promise";
import { config } from "../config.js";

let pool;

export class PermissionsDatabaseError extends Error {
  constructor(message = "The application database is temporarily unavailable.", { cause } = {}) {
    super(message, { cause });
    this.name = "PermissionsDatabaseError";
    this.code = "APPLICATION_DATABASE_UNAVAILABLE";
    this.databaseCode = cause?.code || null;
    this.statusCode = 503;
    this.expose = true;
  }
}

function createPool() {
  const settings = config.permissionsDb;
  if (!settings.configured) {
    throw new PermissionsDatabaseError(
      "The application database is not configured. Set PERMISSIONS_DB_HOST and PERMISSIONS_DB_USER.",
    );
  }
  return mysql.createPool({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    waitForConnections: true,
    connectionLimit: settings.connectionLimit,
    queueLimit: 0,
    multipleStatements: false,
    dateStrings: true,
    ...(settings.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
}

function permissionsPool() {
  pool ||= createPool();
  return pool;
}

export async function executePermissionsSql(sql, parameters = []) {
  try {
    return await permissionsPool().execute({
      sql,
      timeout: config.permissionsDb.queryTimeoutMs,
    }, parameters);
  } catch (error) {
    if (error instanceof PermissionsDatabaseError) throw error;
    console.error("Application database operation failed:", error?.code || error?.name || "unknown error");
    throw new PermissionsDatabaseError(undefined, { cause: error });
  }
}

export async function closePermissionsPool() {
  if (!pool) return;
  const activePool = pool;
  pool = undefined;
  await activePool.end();
}
