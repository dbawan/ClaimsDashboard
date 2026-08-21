import mysql from "mysql2/promise";
import { config } from "../config.js";
import { DatabaseQueryTimeoutError } from "../lib/errors.js";

let pool;

function getPool() {
  if (!config.db.user) {
    throw new Error("DB_USER is required for claim search.");
  }
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      ssl: config.db.ssl ? {} : undefined,
      waitForConnections: true,
      connectionLimit: config.db.connectionLimit,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      multipleStatements: false,
      dateStrings: true,
    });
  }
  return pool;
}

export function assertSelectOnly(sql) {
  const trimmed = sql.trim();
  if (!/^SELECT\b/i.test(trimmed)) {
    throw new Error("Blocked non-SELECT database statement.");
  }
  if (trimmed.replace(/;\s*$/, "").includes(";")) {
    throw new Error("Blocked multi-statement database query.");
  }
}

async function verifyReadOnly(connection) {
  for (const variable of ["transaction_read_only", "tx_read_only"]) {
    try {
      const [rows] = await connection.query(`SELECT @@session.${variable} AS enabled`);
      if (Number(rows[0]?.enabled) !== 1) {
        throw new Error("The MySQL session did not enter read-only mode.");
      }
      return;
    } catch (error) {
      if (!String(error.message).toLowerCase().includes("unknown system variable")) {
        throw error;
      }
    }
  }
  throw new Error("The MySQL server did not expose a verifiable read-only flag.");
}

export async function withReadOnlySession(work) {
  const connection = await getPool().getConnection();
  let discardConnection = false;
  try {
    await connection.query("SET SESSION TRANSACTION READ ONLY");
    await connection.query("START TRANSACTION READ ONLY");
    await verifyReadOnly(connection);

    const session = Object.freeze({
      async select(sql, parameters = [], options = {}) {
        assertSelectOnly(sql);
        const queryLabel = String(options.label || "").trim();
        const startedAt = Date.now();
        try {
          const [rows] = await connection.execute({
            sql,
            timeout: config.db.queryTimeoutMs,
          }, parameters);
          if (queryLabel) {
            console.info("[database:query] complete", {
              label: queryLabel,
              durationMs: Date.now() - startedAt,
              rowCount: Array.isArray(rows) ? rows.length : undefined,
            });
          }
          return rows;
        } catch (error) {
          if (error?.code === "PROTOCOL_SEQUENCE_TIMEOUT") {
            discardConnection = true;
            const timeoutError = new DatabaseQueryTimeoutError(queryLabel, { cause: error });
            console.error("[database:query] timeout", {
              label: timeoutError.queryLabel,
              durationMs: Date.now() - startedAt,
              timeoutMs: config.db.queryTimeoutMs,
            });
            throw timeoutError;
          }
          if (queryLabel) {
            console.error("[database:query] failed", {
              label: queryLabel,
              durationMs: Date.now() - startedAt,
              code: error?.code || null,
            });
          }
          throw error;
        }
      },
    });

    return await work(session);
  } catch (error) {
    if (error?.code === "PROTOCOL_SEQUENCE_TIMEOUT" || error?.code === "DB_QUERY_TIMEOUT") {
      discardConnection = true;
    }
    throw error;
  } finally {
    if (discardConnection) {
      connection.destroy();
    } else {
      try {
        await connection.rollback();
      } finally {
        connection.release();
      }
    }
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
