import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { resolveApplicationProfile } from "../appEnvironment.js";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(serverDirectory, "..");

dotenv.config({ path: path.join(projectRoot, ".env") });
const applicationProfile = resolveApplicationProfile(process.env);

function asBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on", "required"].includes(
    String(value).trim().toLowerCase(),
  );
}

function safeIdentifier(value, fallback) {
  const candidate = value || fallback;
  if (!/^[A-Za-z0-9_]+$/.test(candidate)) {
    throw new Error(`Invalid database identifier: ${candidate}`);
  }
  return candidate;
}

function safeHost(value) {
  const candidate = value || "127.0.0.1";
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(candidate)) {
    throw new Error(`Invalid application host: ${candidate}`);
  }
  return candidate;
}

function positiveInteger(value, fallback, name) {
  const candidate = Number(value ?? fallback);
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return candidate;
}

function percentage(value, fallback, name) {
  const candidate = Number(value ?? fallback);
  if (!Number.isFinite(candidate) || candidate <= 0 || candidate > 100) {
    throw new Error(`${name} must be greater than 0 and no more than 100`);
  }
  return candidate;
}

function httpsUrl(value, fallback, name) {
  const candidate = String(value || fallback).trim().replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return parsed.toString().replace(/\/$/, "");
}

function applicationOrigin(value) {
  const candidate = String(value || "http://localhost:4200").trim();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("APP_ORIGIN must be a valid URL");
  }
  const isLocalHttp = parsed.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw new Error("APP_ORIGIN must use HTTPS unless it is a localhost URL");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("APP_ORIGIN must contain only the scheme, host, and port");
  }
  return parsed.origin;
}

function applicationBasePath(value) {
  const candidate = String(value || "").trim();
  if (!candidate || candidate === "/") return "";
  if (!candidate.startsWith("/")
    || candidate.endsWith("/")
    || candidate.includes("//")
    || !/^\/[A-Za-z0-9._~/-]+$/.test(candidate)) {
    throw new Error("APP_BASE_PATH must be empty or a URL path such as /dashboardapp without a trailing slash");
  }
  return candidate;
}

function pathWithinApplication(basePath, value = "/") {
  const pathValue = String(value || "/").startsWith("/")
    ? String(value || "/")
    : `/${value}`;
  return pathValue === "/" ? `${basePath}/` || "/" : `${basePath}${pathValue}`;
}

function commaSeparated(value, fallback = "") {
  return [...new Set(String(value ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function salesforceApiVersion(value) {
  const candidate = String(value || "v61.0").trim();
  if (!/^v\d+\.\d+$/i.test(candidate)) {
    throw new Error("SF_API_VERSION must use a value such as v61.0");
  }
  return candidate;
}

function salesforceRecordTypeName(value) {
  const candidate = String(value || "Claim").trim();
  if (!candidate || candidate.length > 80 || /[\u0000-\u001F\u007F]/.test(candidate)) {
    throw new Error("SF_NOTE_RECORD_TYPE must be a valid Salesforce record type name");
  }
  return candidate;
}

function claimsApiWorkflow(value) {
  const candidate = String(value || "presubmission").trim().toLowerCase();
  if (!["presubmission", "escalated"].includes(candidate)) {
    throw new Error("CLAIMS_API_WORKFLOW must be presubmission or escalated");
  }
  return candidate;
}

function optionalIntegration(values) {
  const populated = values.filter((value) => String(value || "").trim()).length;
  return Object.freeze({ configured: populated === values.length, partial: populated > 0 && populated < values.length });
}

const salesforceCredentials = [
  process.env.SF_CLIENT_ID,
  process.env.SF_CLIENT_SECRET,
  process.env.SF_REFRESH_TOKEN,
];
const vertexCredentials = [
  process.env.GOOGLE_SERVICE_ACCOUNT_PROJECT_ID,
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL,
];
const geminiApiKeyIntegration = optionalIntegration([process.env.GEMINI_API_KEY]);
const vertexIntegration = optionalIntegration(vertexCredentials);
const geminiConfigured = geminiApiKeyIntegration.configured || vertexIntegration.configured;
const geminiPartial = !geminiConfigured && (geminiApiKeyIntegration.partial || vertexIntegration.partial);
const appOrigin = applicationOrigin(applicationProfile.appOrigin);
const appBasePath = applicationBasePath(applicationProfile.appBasePath);
const appPath = (value) => pathWithinApplication(appBasePath, value);
const cognitoBaseUri = httpsUrl(
  process.env.COGNITO_BASE_URI,
  "https://unithera.auth.us-east-1.amazoncognito.com",
  "COGNITO_BASE_URI",
);
const cognitoClientId = String(
  process.env.COGNITO_CLIENT_ID || "6j6b3e9k2pbtolusk7jfbq8d8s",
).trim();
const cognitoClientSecret = String(process.env.COGNITO_CLIENT_SECRET || "").trim();
const cognitoUserPoolId = String(
  process.env.COGNITO_USER_POOL_ID || "us-east-1_wA4ljIC93",
).trim();
const cognitoRegion = String(process.env.COGNITO_REGION || "us-east-1").trim();
const ssoEnabled = asBoolean(process.env.SSO_ENABLED, true);
const permissionsDbHost = String(process.env.PERMISSIONS_DB_HOST || "").trim();
const permissionsDbUser = String(process.env.PERMISSIONS_DB_USER || "").trim();

export const config = Object.freeze({
  environment: applicationProfile.name,
  port: applicationProfile.port,
  host: safeHost(applicationProfile.host),
  isProduction: process.env.NODE_ENV === "production",
  appOrigin,
  basePath: appBasePath,
  appUrl: `${appOrigin}${appBasePath}`,
  appPath,
  sso: Object.freeze({
    enabled: ssoEnabled,
    configured: Boolean(cognitoBaseUri && cognitoClientId && cognitoClientSecret && cognitoUserPoolId),
    baseUri: cognitoBaseUri,
    clientId: cognitoClientId,
    clientSecret: cognitoClientSecret,
    userPoolId: cognitoUserPoolId,
    region: cognitoRegion,
    issuer: `https://cognito-idp.${cognitoRegion}.amazonaws.com/${cognitoUserPoolId}`,
    redirectUri: new URL(appPath("/callback"), `${appOrigin}/`).toString(),
    logoutUri: `${appOrigin}${appBasePath}`,
    scopes: commaSeparated(process.env.COGNITO_SCOPES, "openid,profile,email"),
    allowedGroups: commaSeparated(
      process.env.COGNITO_ALLOWED_GROUPS,
      "",
    ),
    secureCookies: new URL(appOrigin).protocol === "https:",
    sessionDays: positiveInteger(
      process.env.COGNITO_SESSION_DAYS ?? process.env.COGNITO_REFRESH_COOKIE_DAYS,
      30,
      "COGNITO_SESSION_DAYS",
    ),
    maxSessions: positiveInteger(
      process.env.COGNITO_MAX_SESSIONS,
      2_000,
      "COGNITO_MAX_SESSIONS",
    ),
    requestTimeoutMs: positiveInteger(
      process.env.COGNITO_REQUEST_TIMEOUT_MS,
      10_000,
      "COGNITO_REQUEST_TIMEOUT_MS",
    ),
  }),
  db: Object.freeze({
    host: process.env.DB_HOST || process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || process.env.MYSQL_PORT || 3306),
    user: process.env.DB_USER || process.env.MYSQL_USER,
    password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || "",
    database: process.env.DB_NAME || process.env.MYSQL_DATABASE,
    ssl: asBoolean(process.env.DB_SSL ?? process.env.MYSQL_SSL, false),
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
    queryTimeoutMs: positiveInteger(process.env.DB_QUERY_TIMEOUT_MS, 20_000, "DB_QUERY_TIMEOUT_MS"),
  }),
  permissionsDb: Object.freeze({
    configured: Boolean(permissionsDbHost && permissionsDbUser),
    host: permissionsDbHost,
    port: positiveInteger(
      process.env.PERMISSIONS_DB_PORT,
      3306,
      "PERMISSIONS_DB_PORT",
    ),
    user: permissionsDbUser,
    password: process.env.PERMISSIONS_DB_PASSWORD || "",
    ssl: asBoolean(process.env.PERMISSIONS_DB_SSL, false),
    connectionLimit: positiveInteger(
      process.env.PERMISSIONS_DB_CONNECTION_LIMIT,
      2,
      "PERMISSIONS_DB_CONNECTION_LIMIT",
    ),
    queryTimeoutMs: positiveInteger(
      process.env.PERMISSIONS_DB_QUERY_TIMEOUT_MS,
      10_000,
      "PERMISSIONS_DB_QUERY_TIMEOUT_MS",
    ),
  }),
  userPermissions: Object.freeze({
    schema: safeIdentifier(process.env.USER_PERMISSIONS_SCHEMA, "UniLocus"),
    table: safeIdentifier(
      process.env.USER_PERMISSIONS_TABLE,
      "claims_dashboard_user_permissions",
    ),
  }),
  worklists: Object.freeze({
    schema: safeIdentifier(
      process.env.WORKLIST_SCHEMA || process.env.USER_PERMISSIONS_SCHEMA,
      "UniLocus",
    ),
    typesTable: safeIdentifier(
      process.env.WORKLIST_TYPES_TABLE,
      "claims_dashboard_worklist_types",
    ),
    claimsTable: safeIdentifier(
      process.env.CLAIM_WORKLISTS_TABLE,
      "claims_dashboard_claim_worklists",
    ),
  }),
  schemas: Object.freeze({
    transactions: safeIdentifier(process.env.UNIDATA_SCHEMA, "unidata"),
    claimStatus: safeIdentifier(process.env.UNICOIN_SCHEMA, "uniCoin"),
    edi: safeIdentifier(process.env.RCM_SCHEMA, "RCM"),
    ehr: safeIdentifier(process.env.EHR_SCHEMA, "EHR"),
  }),
  ehr: Object.freeze({
    licenseKey: positiveInteger(process.env.EHR_LICENSE_KEY, 161549, "EHR_LICENSE_KEY"),
    transactionSource: String(process.env.EHR_TRANSACTION_SOURCE || "AMD").trim() || "AMD",
  }),
  claims: Object.freeze({
    paidThresholdPercent: percentage(
      process.env.CLAIM_PAID_THRESHOLD_PERCENT,
      50,
      "CLAIM_PAID_THRESHOLD_PERCENT",
    ),
  }),
  tables: Object.freeze({
    transactions: safeIdentifier(
      process.env.TRANSACTIONS_TABLE,
      "FlattenTransctions2",
    ),
    claimStatus: safeIdentifier(process.env.CLAIM_STATUS_TABLE, "ClaimStatus"),
    patientInvoices: safeIdentifier(process.env.PATIENT_INVOICE_TABLE, "patient_invoices"),
    patientInfo: safeIdentifier(process.env.EHR_PATIENT_TABLE, "vw_ODBC_pt_PatientInfo"),
    edi: safeIdentifier(process.env.EDI_835_TABLE, "edi_835"),
  }),
  claimsApi: Object.freeze({
    configured: Boolean(String(process.env.CLAIMS_API_KEY || "").trim()),
    baseUrl: httpsUrl(
      process.env.CLAIMS_API_BASE_URL,
      "https://apps.unithera.com/rcm-clustering/presubmission/api/v1",
      "CLAIMS_API_BASE_URL",
    ),
    apiKey: String(process.env.CLAIMS_API_KEY || "").trim(),
    workflow: claimsApiWorkflow(process.env.CLAIMS_API_WORKFLOW),
    timeoutMs: positiveInteger(process.env.CLAIMS_API_TIMEOUT_MS, 30_000, "CLAIMS_API_TIMEOUT_MS"),
  }),
  salesforce: Object.freeze({
    ...optionalIntegration(salesforceCredentials),
    loginUrl: httpsUrl(process.env.SF_LOGIN_URL, "https://login.salesforce.com", "SF_LOGIN_URL"),
    clientId: process.env.SF_CLIENT_ID || "",
    clientSecret: process.env.SF_CLIENT_SECRET || "",
    refreshToken: process.env.SF_REFRESH_TOKEN || "",
    apiVersion: salesforceApiVersion(process.env.SF_API_VERSION),
    caseObject: safeIdentifier(process.env.SF_CASE_OBJECT, "UniSuite_RCM_Case__c"),
    noteObject: safeIdentifier(process.env.SF_NOTE_OBJECT, "UniSuite_RCM_Case_Note__c"),
    statusField: safeIdentifier(process.env.SF_STATUS_FIELD, "UniSuite_Status__c"),
    claimIdField: safeIdentifier(process.env.SF_CLAIM_ID_FIELD, "UniSuite_Claim_ID__c"),
    icnField: safeIdentifier(process.env.SF_ICN_FIELD, "UniSuite_ICN__c"),
    noteCaseField: safeIdentifier(process.env.SF_NOTE_CASE_FIELD, "UniSuite_RCM_Case__c"),
    noteActionField: safeIdentifier(process.env.SF_NOTE_ACTION_FIELD, "UniSuite_Action__c"),
    noteFollowupField: safeIdentifier(process.env.SF_NOTE_FOLLOWUP_FIELD, "UniSuite_Follow_Up_Action__c"),
    noteTextField: safeIdentifier(process.env.SF_NOTE_TEXT_FIELD, "UniSuite_Text__c"),
    notePaidField: safeIdentifier(process.env.SF_NOTE_PAID_FIELD, "UniSuite_Paid__c"),
    noteAllowedField: safeIdentifier(process.env.SF_NOTE_ALLOWED_FIELD, "UniSuite_Allowed_Amount__c"),
    noteAmountField: safeIdentifier(process.env.SF_NOTE_AMOUNT_FIELD, "UniSuite_Amount__c"),
    noteCheckField: safeIdentifier(process.env.SF_NOTE_CHECK_FIELD, "UniSuite_Check_EFT_Number__c"),
    noteClearedField: safeIdentifier(process.env.SF_NOTE_CLEARED_FIELD, "UniSuite_Cleared_Date__c"),
    noteIssueField: safeIdentifier(process.env.SF_NOTE_ISSUE_FIELD, "UniSuite_Issue_Date__c"),
    notePostingIssueField: safeIdentifier(process.env.SF_NOTE_POSTING_ISSUE_FIELD, "UniSuite_Payment_Posting_Issue__c"),
    noteWritesEnabled: asBoolean(process.env.SF_NOTE_WRITES_ENABLED, false),
    noteWriterGroups: commaSeparated(process.env.SF_NOTE_WRITER_GROUPS, ""),
    noteRecordType: salesforceRecordTypeName(process.env.SF_NOTE_RECORD_TYPE),
    noteMaxChars: Math.min(
      positiveInteger(process.env.SF_NOTE_MAX_CHARS, 5_000, "SF_NOTE_MAX_CHARS"),
      32_768,
    ),
    timeoutMs: positiveInteger(process.env.SF_TIMEOUT_MS, 30_000, "SF_TIMEOUT_MS"),
    maxComments: positiveInteger(process.env.SF_MAX_COMMENTS, 100, "SF_MAX_COMMENTS"),
  }),
  gemini: Object.freeze({
    configured: geminiConfigured,
    partial: geminiPartial,
    provider: geminiApiKeyIntegration.configured ? "gemini-api" : "vertex-ai",
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    project: process.env.GOOGLE_SERVICE_ACCOUNT_PROJECT_ID || "",
    location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
    serviceAccount: Object.freeze({
      type: process.env.GOOGLE_SERVICE_ACCOUNT_TYPE || "service_account",
      project_id: process.env.GOOGLE_SERVICE_ACCOUNT_PROJECT_ID || "",
      private_key_id: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_ID || "",
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "",
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL || "",
      client_id: process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_ID || "",
      auth_uri: process.env.GOOGLE_SERVICE_ACCOUNT_AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
      token_uri: process.env.GOOGLE_SERVICE_ACCOUNT_TOKEN_URI || "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: process.env.GOOGLE_SERVICE_ACCOUNT_AUTH_PROVIDER_X509_CERT_URL || "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_X509_CERT_URL || "",
      universe_domain: process.env.GOOGLE_SERVICE_ACCOUNT_UNIVERSE_DOMAIN || "googleapis.com",
    }),
    maxAttempts: positiveInteger(
      process.env.GEMINI_MAX_ATTEMPTS || process.env.LLM_MAX_ATTEMPTS,
      3,
      "GEMINI_MAX_ATTEMPTS",
    ),
    concurrency: positiveInteger(process.env.GEMINI_CONCURRENCY, 3, "GEMINI_CONCURRENCY"),
    maxCommentChars: positiveInteger(
      process.env.GEMINI_MAX_COMMENT_CHARS || process.env.LLM_MAX_NOTE_CHARS,
      5000,
      "GEMINI_MAX_COMMENT_CHARS",
    ),
  }),
});
