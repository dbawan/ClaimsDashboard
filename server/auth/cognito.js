import { createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { config } from "../config.js";

const COOKIE_NAMES = Object.freeze({
  idToken: "ut_sso_id",
  refreshToken: "ut_sso_refresh",
  state: "ut_sso_state",
  nonce: "ut_sso_nonce",
  returnTo: "ut_sso_return",
});
const LOGIN_COOKIE_SECONDS = 10 * 60;
const JWKS_CACHE_MS = 60 * 60 * 1_000;

let jwksCache = null;
let jwksLoadedAt = 0;

export class AuthError extends Error {
  constructor(message, { code = "UNAUTHORIZED", statusCode = 401 } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = statusCode;
    this.expose = true;
  }
}

export function parseCookies(header = "") {
  return String(header)
    .split(";")
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator < 1) return cookies;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
      return cookies;
    }, {});
}

function serializeCookie(name, value, {
  maxAge,
  path = "/",
  httpOnly = true,
  secure = config.sso.secureCookies,
  sameSite = "Lax",
} = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (Number.isFinite(maxAge)) attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (httpOnly) attributes.push("HttpOnly");
  if (secure) attributes.push("Secure");
  if (sameSite) attributes.push(`SameSite=${sameSite}`);
  return attributes.join("; ");
}

function appendCookie(response, name, value, options) {
  response.append("Set-Cookie", serializeCookie(name, value, options));
}

function clearCookie(response, name, path = "/") {
  appendCookie(response, name, "", { maxAge: 0, path });
}

export function clearSessionCookies(response) {
  clearCookie(response, COOKIE_NAMES.idToken);
  clearCookie(response, COOKIE_NAMES.refreshToken);
}

function clearLoginCookies(response) {
  clearCookie(response, COOKIE_NAMES.state, "/callback");
  clearCookie(response, COOKIE_NAMES.nonce, "/callback");
  clearCookie(response, COOKIE_NAMES.returnTo, "/callback");
}

export function safeReturnTo(value) {
  if (typeof value !== "string" || value.length > 2_048) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (value === "/callback" || value.startsWith("/callback?")) return "/";
  if (value.startsWith("/auth/")) return "/";
  return value;
}

function secureEqual(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function randomUrlSafeValue() {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizeUrl(sso, state, nonce) {
  const url = new URL("/login", `${sso.baseUri}/`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", sso.clientId);
  url.searchParams.set("redirect_uri", sso.redirectUri);
  url.searchParams.set("scope", sso.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

export function buildLogoutUrl(sso) {
  const url = new URL("/logout", `${sso.baseUri}/`);
  url.searchParams.set("client_id", sso.clientId);
  url.searchParams.set("logout_uri", sso.logoutUri);
  return url.toString();
}

function assertSsoConfigured() {
  if (!config.sso.enabled) return;
  if (!config.sso.configured) {
    throw new AuthError(
      "SSO is enabled but COGNITO_CLIENT_SECRET is not configured.",
      { code: "SSO_NOT_CONFIGURED", statusCode: 503 },
    );
  }
}

export function beginLogin(request, response) {
  assertSsoConfigured();
  const canonicalHost = new URL(config.appOrigin).host;
  if (request.get("host") !== canonicalHost) {
    const canonicalLogin = new URL("/auth/login", config.appOrigin);
    canonicalLogin.searchParams.set("returnTo", safeReturnTo(request.query.returnTo));
    response.redirect(302, canonicalLogin.toString());
    return;
  }
  const state = randomUrlSafeValue();
  const nonce = randomUrlSafeValue();
  const returnTo = safeReturnTo(request.query.returnTo);
  const cookieOptions = { maxAge: LOGIN_COOKIE_SECONDS, path: "/callback" };

  appendCookie(response, COOKIE_NAMES.state, state, cookieOptions);
  appendCookie(response, COOKIE_NAMES.nonce, nonce, cookieOptions);
  appendCookie(response, COOKIE_NAMES.returnTo, returnTo, cookieOptions);
  response.redirect(302, buildAuthorizeUrl(config.sso, state, nonce));
}

function decodeJwtPart(value, label) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new AuthError(`The SSO ${label} is malformed.`, { code: "INVALID_SSO_TOKEN" });
  }
}

function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new AuthError("The SSO token is malformed.", { code: "INVALID_SSO_TOKEN" });
  }
  return {
    header: decodeJwtPart(parts[0], "token header"),
    payload: decodeJwtPart(parts[1], "token payload"),
    signature: Buffer.from(parts[2], "base64url"),
    signedValue: `${parts[0]}.${parts[1]}`,
  };
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error_description: text };
  }
}

async function loadJwks(force = false) {
  if (!force && jwksCache && Date.now() - jwksLoadedAt < JWKS_CACHE_MS) return jwksCache;
  let response;
  try {
    response = await fetch(`${config.sso.issuer}/.well-known/jwks.json`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(config.sso.requestTimeoutMs),
    });
  } catch (error) {
    throw new AuthError(`The SSO signing keys could not be loaded: ${error.message}`, {
      code: "SSO_UNAVAILABLE",
      statusCode: 503,
    });
  }
  if (!response.ok) {
    throw new AuthError("The SSO signing keys could not be loaded.", {
      code: "SSO_UNAVAILABLE",
      statusCode: 503,
    });
  }
  const body = await responseBody(response);
  if (!Array.isArray(body.keys)) {
    throw new AuthError("The SSO signing-key response was invalid.", {
      code: "SSO_UNAVAILABLE",
      statusCode: 503,
    });
  }
  jwksCache = new Map(body.keys.map((key) => [key.kid, key]));
  jwksLoadedAt = Date.now();
  return jwksCache;
}

async function signingKey(kid) {
  let keys = await loadJwks();
  let key = keys.get(kid);
  if (!key) {
    keys = await loadJwks(true);
    key = keys.get(kid);
  }
  if (!key) throw new AuthError("The SSO token used an unknown signing key.", { code: "INVALID_SSO_TOKEN" });
  return createPublicKey({ key, format: "jwk" });
}

function groupsFromPayload(payload) {
  const groups = payload["custom:groups"] ?? payload["cognito:groups"] ?? [];
  if (Array.isArray(groups)) return groups.map(String);
  if (typeof groups === "string") {
    try {
      const parsed = JSON.parse(groups);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return groups.split(/[ ,]+/).filter(Boolean);
    }
  }
  return [];
}

function assertAllowedGroup(payload) {
  if (config.sso.allowedGroups.length === 0) return;
  const groups = groupsFromPayload(payload);
  if (!config.sso.allowedGroups.some((group) => groups.includes(group))) {
    throw new AuthError("Your SSO account is not authorized for this application.", {
      code: "SSO_GROUP_FORBIDDEN",
      statusCode: 403,
    });
  }
}

export async function verifyIdToken(token, { nonce } = {}) {
  const decoded = decodeJwt(token);
  if (decoded.header.alg !== "RS256" || !decoded.header.kid) {
    throw new AuthError("The SSO token used an unsupported signing method.", { code: "INVALID_SSO_TOKEN" });
  }
  const key = await signingKey(decoded.header.kid);
  const validSignature = verify(
    "RSA-SHA256",
    Buffer.from(decoded.signedValue),
    key,
    decoded.signature,
  );
  if (!validSignature) {
    throw new AuthError("The SSO token signature is invalid.", { code: "INVALID_SSO_TOKEN" });
  }

  const now = Math.floor(Date.now() / 1_000);
  const payload = decoded.payload;
  if (payload.iss !== config.sso.issuer
    || payload.token_use !== "id"
    || payload.aud !== config.sso.clientId) {
    throw new AuthError("The SSO token was not issued for this application.", { code: "INVALID_SSO_TOKEN" });
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= now) {
    throw new AuthError("The SSO session has expired.", { code: "SSO_TOKEN_EXPIRED" });
  }
  if (nonce && payload.nonce !== nonce) {
    throw new AuthError("The SSO callback could not be verified.", { code: "INVALID_SSO_NONCE" });
  }
  assertAllowedGroup(payload);
  return payload;
}

function userRole(groups) {
  if (groups.includes("cf87404c-94bf-44ca-967f-ccc5b1aecdbc")) return "admin";
  if (groups.includes("3eb0bf58-b7fb-4e7f-b429-848ccf41e8ed")) return "nmt";
  if (groups.includes("b3cc11c1-daf9-4ea9-aae7-d2bf9bb9d7e8")) return "provider";
  return "unknown";
}

function publicUser(payload) {
  const groups = groupsFromPayload(payload);
  const fullName = String(payload.name || [payload.given_name, payload.family_name]
    .filter(Boolean)
    .join(" ") || payload.email || "SSO user");
  return {
    id: payload.sub,
    name: fullName,
    email: payload.email || null,
    site: payload.site || null,
    role: userRole(groups),
    groups,
  };
}

async function tokenRequest(parameters) {
  assertSsoConfigured();
  let response;
  try {
    response = await fetch(`${config.sso.baseUri}/oauth2/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${config.sso.clientId}:${config.sso.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: config.sso.clientId, ...parameters }),
      signal: AbortSignal.timeout(config.sso.requestTimeoutMs),
    });
  } catch (error) {
    throw new AuthError(`The SSO token service could not be reached: ${error.message}`, {
      code: "SSO_UNAVAILABLE",
      statusCode: 503,
    });
  }
  const body = await responseBody(response);
  if (!response.ok || !body.id_token) {
    throw new AuthError(
      body.error_description || "The SSO token exchange failed.",
      { code: "SSO_TOKEN_EXCHANGE_FAILED" },
    );
  }
  return body;
}

async function exchangeCode(code) {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.sso.redirectUri,
  });
}

async function refreshSession(refreshToken) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

function storeSessionCookies(response, tokens, payload, existingRefreshToken = "") {
  const now = Math.floor(Date.now() / 1_000);
  appendCookie(response, COOKIE_NAMES.idToken, tokens.id_token, {
    maxAge: Math.max(1, payload.exp - now),
  });
  const refreshToken = tokens.refresh_token || existingRefreshToken;
  if (refreshToken) {
    appendCookie(response, COOKIE_NAMES.refreshToken, refreshToken, {
      maxAge: config.sso.refreshCookieDays * 24 * 60 * 60,
    });
  }
}

export async function completeLogin(request, response) {
  assertSsoConfigured();
  const cookies = parseCookies(request.headers.cookie);
  const code = typeof request.query.code === "string" ? request.query.code : "";
  const state = typeof request.query.state === "string" ? request.query.state : "";
  const providerError = typeof request.query.error_description === "string"
    ? request.query.error_description
    : request.query.error;
  let returnTo = "/";

  try {
    if (providerError) {
      throw new AuthError(`SSO sign-in was not completed: ${providerError}`, {
        code: "SSO_LOGIN_FAILED",
      });
    }
    if (!code
      || !cookies[COOKIE_NAMES.nonce]
      || !secureEqual(state, cookies[COOKIE_NAMES.state])) {
      throw new AuthError("The SSO callback state could not be verified.", {
        code: "INVALID_SSO_STATE",
      });
    }
    const tokens = await exchangeCode(code);
    const payload = await verifyIdToken(tokens.id_token, {
      nonce: cookies[COOKIE_NAMES.nonce],
    });
    storeSessionCookies(response, tokens, payload);
    returnTo = safeReturnTo(cookies[COOKIE_NAMES.returnTo]);
  } finally {
    clearLoginCookies(response);
  }
  response.redirect(302, returnTo);
}

async function authenticatedUser(request, response) {
  if (!config.sso.enabled) {
    return { id: "local", name: "Local development", email: null, site: null, role: "admin", groups: [] };
  }
  assertSsoConfigured();

  const authorization = String(request.headers.authorization || "");
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return publicUser(await verifyIdToken(bearerMatch[1]));

  const cookies = parseCookies(request.headers.cookie);
  const idToken = cookies[COOKIE_NAMES.idToken];
  if (idToken) {
    try {
      return publicUser(await verifyIdToken(idToken));
    } catch (error) {
      if (error.code !== "SSO_TOKEN_EXPIRED") throw error;
    }
  }

  const refreshToken = cookies[COOKIE_NAMES.refreshToken];
  if (!refreshToken) throw new AuthError("An SSO session is required.");
  const tokens = await refreshSession(refreshToken);
  const payload = await verifyIdToken(tokens.id_token);
  storeSessionCookies(response, tokens, payload, refreshToken);
  return publicUser(payload);
}

export async function requireSso(request, response, next) {
  try {
    request.user = await authenticatedUser(request, response);
    next();
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 403) clearSessionCookies(response);
    next(error);
  }
}

export async function readSession(request, response) {
  try {
    const user = await authenticatedUser(request, response);
    response.json({ authenticated: true, user });
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 403) clearSessionCookies(response);
    throw error;
  }
}

export function endSession(response) {
  clearSessionCookies(response);
  if (!config.sso.enabled || !config.sso.configured) {
    response.redirect(302, config.appOrigin);
    return;
  }
  response.redirect(302, buildLogoutUrl(config.sso));
}
