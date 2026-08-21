import { Router } from "express";
import { getClaimLifecycle } from "../services/claimLifecycleService.js";

export const claimsRouter = Router();

claimsRouter.get("/:claimId", async (request, response, next) => {
  try {
    const lifecycle = await getClaimLifecycle(request.params.claimId);
    response.set("Cache-Control", "no-store, max-age=0");
    response.json(lifecycle);
  } catch (error) {
    next(error);
  }
});

