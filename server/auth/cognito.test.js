import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  parseCookies,
  safeReturnTo,
} from "./cognito.js";

const sso = Object.freeze({
  baseUri: "https://example.auth.us-east-1.amazoncognito.com",
  clientId: "client-id",
  redirectUri: "http://localhost:4200/callback",
  logoutUri: "http://localhost:4200",
  scopes: ["openid", "profile", "email"],
});

test("Cognito authorization URL uses the exact localhost callback with state and nonce", () => {
  const url = new URL(buildAuthorizeUrl(sso, "state-value", "nonce-value"));
  assert.equal(url.origin, "https://example.auth.us-east-1.amazoncognito.com");
  assert.equal(url.pathname, "/login");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:4200/callback");
  assert.equal(url.searchParams.get("scope"), "openid profile email");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("nonce"), "nonce-value");
});

test("Cognito logout returns to the configured localhost origin", () => {
  const url = new URL(buildLogoutUrl(sso));
  assert.equal(url.pathname, "/logout");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("logout_uri"), "http://localhost:4200");
});

test("return paths remain local and exclude auth callback loops", () => {
  assert.equal(safeReturnTo("/?claim=78820#high-level"), "/?claim=78820#high-level");
  assert.equal(safeReturnTo("https://attacker.example"), "/");
  assert.equal(safeReturnTo("//attacker.example"), "/");
  assert.equal(safeReturnTo("/callback?code=stale"), "/");
  assert.equal(safeReturnTo("/auth/logout"), "/");
});

test("cookie parsing decodes values without failing on malformed input", () => {
  assert.deepEqual(parseCookies("one=hello%20world; token=a.b-c; broken=%E0%A4%A"), {
    one: "hello world",
    token: "a.b-c",
    broken: "%E0%A4%A",
  });
});
