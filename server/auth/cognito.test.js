import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  createBrowserSession,
  parseCookies,
  safeReturnTo,
} from "./cognito.js";
import { config } from "../config.js";

const sso = Object.freeze({
  baseUri: "https://example.auth.us-east-1.amazoncognito.com",
  clientId: "client-id",
  redirectUri: "https://apps.unithera.com/dashboardapp/callback",
  logoutUri: "https://apps.unithera.com/dashboardapp",
  scopes: ["openid", "profile", "email"],
});

test("Cognito authorization URL uses the exact dashboard callback with state and nonce", () => {
  const url = new URL(buildAuthorizeUrl(sso, "state-value", "nonce-value"));
  assert.equal(url.origin, "https://example.auth.us-east-1.amazoncognito.com");
  assert.equal(url.pathname, "/login");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "https://apps.unithera.com/dashboardapp/callback");
  assert.equal(url.searchParams.get("scope"), "openid profile email");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("nonce"), "nonce-value");
});

test("Cognito logout returns to the configured dashboard path", () => {
  const url = new URL(buildLogoutUrl(sso));
  assert.equal(url.pathname, "/logout");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("logout_uri"), "https://apps.unithera.com/dashboardapp");
});

test("return paths remain local and exclude auth callback loops", () => {
  const homePath = config.appPath("/");
  const claimPath = `${config.basePath}/?claim=78820#high-level`;
  assert.equal(safeReturnTo(claimPath), claimPath);
  assert.equal(safeReturnTo("https://attacker.example"), homePath);
  assert.equal(safeReturnTo("//attacker.example"), homePath);
  assert.equal(safeReturnTo(`${config.appPath("/callback")}?code=stale`), homePath);
  assert.equal(safeReturnTo(config.appPath("/auth/logout")), homePath);
  if (config.basePath) assert.equal(safeReturnTo("/?claim=other-app"), homePath);
});

test("cookie parsing decodes values without failing on malformed input", () => {
  assert.deepEqual(parseCookies("one=hello%20world; token=a.b-c; broken=%E0%A4%A"), {
    one: "hello world",
    token: "a.b-c",
    broken: "%E0%A4%A",
  });
});

test("browser sessions never put Cognito tokens in response cookies", () => {
  const setCookies = [];
  const response = {
    append(name, value) {
      assert.equal(name, "Set-Cookie");
      setCookies.push(value);
    },
  };
  const largeIdToken = `id.${"a".repeat(6_000)}.signature`;
  const largeRefreshToken = `refresh-${"b".repeat(6_000)}`;

  createBrowserSession(response, {
    id_token: largeIdToken,
    refresh_token: largeRefreshToken,
  });

  const headers = setCookies.join("\n");
  assert.match(headers, /ut_sso_session=/);
  assert.equal(headers.includes(largeIdToken), false);
  assert.equal(headers.includes(largeRefreshToken), false);
  assert.ok(Buffer.byteLength(headers) < 1_024);
});
