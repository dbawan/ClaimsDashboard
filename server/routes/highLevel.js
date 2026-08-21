import { Router } from "express";
import {
  getClaimsWithoutResponse,
  getHighLevelDashboard,
  getHighLevelClaims,
  getUnsubmittedAppointments,
} from "../services/highLevelService.js";

export const highLevelRouter = Router();

highLevelRouter.get("/dashboard", async (request, response, next) => {
  try {
    response.json(await getHighLevelDashboard(request.query));
  } catch (error) {
    next(error);
  }
});

highLevelRouter.get("/claims", async (request, response, next) => {
  try {
    response.json(await getHighLevelClaims(request.query));
  } catch (error) {
    next(error);
  }
});

highLevelRouter.get("/unsubmitted", async (request, response, next) => {
  try {
    response.json(await getUnsubmittedAppointments(request.query));
  } catch (error) {
    next(error);
  }
});

highLevelRouter.get("/no-response", async (request, response, next) => {
  try {
    response.json(await getClaimsWithoutResponse(request.query));
  } catch (error) {
    next(error);
  }
});
