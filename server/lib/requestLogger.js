import { config } from "../config.js";

const escapedBasePath = config.basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATIENT_REQUEST_PATH = new RegExp(`^(${escapedBasePath}/api/claims/patients/)[^/]+(/claims.*)$`);
const CLAIM_REQUEST_PATH = new RegExp(
  `^(${escapedBasePath}/api/claims/)(?!(?:patients|worklist-types)(?:/|$))[^/]+(.*)$`,
);

function requestPath(originalUrl) {
  let pathname = "/";
  try {
    pathname = new URL(String(originalUrl || "/"), "http://localhost").pathname;
  } catch {
    // Keep malformed request targets out of logs.
  }

  return pathname
    .replace(PATIENT_REQUEST_PATH, "$1:patientId$2")
    .replace(CLAIM_REQUEST_PATH, "$1:claimId$2");
}

function logMethod(logger, statusCode) {
  if (statusCode >= 500) return logger.error;
  if (statusCode >= 400) return logger.warn;
  return logger.info;
}

export function createRequestLogger({
  logger = console,
  now = () => process.hrtime.bigint(),
} = {}) {
  return function requestLogger(request, response, next) {
    const startedAt = now();
    let logged = false;

    function writeLog(outcome) {
      if (logged) return;
      logged = true;

      const elapsedNanoseconds = now() - startedAt;
      const durationMs = Math.round(Number(elapsedNanoseconds) / 100_000) / 10;
      const statusCode = response.statusCode;
      const write = logMethod(logger, statusCode).bind(logger);

      write("[http] request", {
        method: request.method,
        path: requestPath(request.originalUrl),
        statusCode,
        durationMs,
        outcome,
      });
    }

    response.once("finish", () => writeLog("complete"));
    response.once("close", () => {
      if (!response.writableFinished) writeLog("aborted");
    });
    next();
  };
}
