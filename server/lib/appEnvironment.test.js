import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationEnvironment,
  resolveApplicationProfile,
} from "../../appEnvironment.js";

test("development profile selects localhost port 4200 and a root base path", () => {
  assert.deepEqual(resolveApplicationProfile({
    APP_ENV: "development",
    DEVELOPMENT_HOST: "127.0.0.1",
    DEVELOPMENT_PORT: "4200",
    DEVELOPMENT_APP_ORIGIN: "http://localhost:4200",
    DEVELOPMENT_APP_BASE_PATH: "",
    PRODUCTION_PORT: "43127",
  }), {
    name: "development",
    host: "127.0.0.1",
    port: 4200,
    appOrigin: "http://localhost:4200",
    appBasePath: "",
  });
});

test("production profile selects the EC2 origin, port, and base path", () => {
  assert.deepEqual(resolveApplicationProfile({
    APP_ENV: "production",
    DEVELOPMENT_PORT: "4200",
    PRODUCTION_HOST: "127.0.0.1",
    PRODUCTION_PORT: "43127",
    PRODUCTION_APP_ORIGIN: "https://apps.unithera.com",
    PRODUCTION_APP_BASE_PATH: "/dashboardapp",
  }), {
    name: "production",
    host: "127.0.0.1",
    port: 43127,
    appOrigin: "https://apps.unithera.com",
    appBasePath: "/dashboardapp",
  });
});

test("generic runtime values override a profile for the Docker container", () => {
  const profile = resolveApplicationProfile({
    APP_ENV: "production",
    PRODUCTION_PORT: "43127",
    PORT: "3000",
    HOST: "0.0.0.0",
    APP_BASE_PATH: "/dashboardapp",
  });

  assert.equal(profile.port, 3000);
  assert.equal(profile.host, "0.0.0.0");
  assert.equal(profile.appBasePath, "/dashboardapp");
});

test("invalid application environments fail during startup", () => {
  assert.throws(
    () => applicationEnvironment({ APP_ENV: "staging" }),
    /APP_ENV must be development or production/,
  );
});
