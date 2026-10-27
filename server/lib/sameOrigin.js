import { config } from "../config.js";

export class SameOriginRequiredError extends Error {
  constructor() {
    super("This action must be submitted from the Claim Lifecycle application.");
    this.name = "SameOriginRequiredError";
    this.code = "SAME_ORIGIN_REQUIRED";
    this.statusCode = 403;
    this.expose = true;
  }
}

export function requireSameOrigin(request, response, next) {
  if (String(request.get("origin") || "") === config.appOrigin) {
    next();
    return;
  }
  next(new SameOriginRequiredError());
}
