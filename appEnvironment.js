const DEFAULTS = Object.freeze({
  development: Object.freeze({
    host: "127.0.0.1",
    port: 4200,
    appOrigin: "http://localhost:4200",
    appBasePath: "",
  }),
  production: Object.freeze({
    host: "127.0.0.1",
    port: 43127,
    appOrigin: "https://apps.unithera.com",
    appBasePath: "/dashboardapp",
  }),
});

function environmentValue(environment, profile, name, fallback) {
  if (Object.prototype.hasOwnProperty.call(environment, name)) return environment[name];
  const profileName = `${profile.toUpperCase()}_${name}`;
  if (Object.prototype.hasOwnProperty.call(environment, profileName)) {
    return environment[profileName];
  }
  return fallback;
}

export function applicationEnvironment(environment = {}) {
  const selected = String(environment.APP_ENV || "development").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, selected)) {
    throw new Error("APP_ENV must be development or production");
  }
  return selected;
}

export function resolveApplicationProfile(environment = {}) {
  const name = applicationEnvironment(environment);
  const defaults = DEFAULTS[name];
  const port = Number(environmentValue(environment, name, "PORT", defaults.port));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${name.toUpperCase()}_PORT must be an integer from 1 through 65535`);
  }

  return Object.freeze({
    name,
    host: String(environmentValue(environment, name, "HOST", defaults.host)).trim(),
    port,
    appOrigin: String(
      environmentValue(environment, name, "APP_ORIGIN", defaults.appOrigin),
    ).trim(),
    appBasePath: String(
      environmentValue(environment, name, "APP_BASE_PATH", defaults.appBasePath),
    ).trim(),
  });
}
