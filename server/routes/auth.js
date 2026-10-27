import { Router } from "express";
import {
  beginLogin,
  completeLogin,
  endSession,
  readSession,
} from "../auth/cognito.js";

export const authRouter = Router();

authRouter.get("/login", (request, response, next) => {
  try {
    beginLogin(request, response);
  } catch (error) {
    next(error);
  }
});

authRouter.get("/logout", (request, response, next) => {
  try {
    endSession(request, response);
  } catch (error) {
    next(error);
  }
});

export async function callbackHandler(request, response, next) {
  try {
    await completeLogin(request, response);
  } catch (error) {
    next(error);
  }
}

export async function sessionHandler(request, response, next) {
  try {
    await readSession(request, response);
  } catch (error) {
    next(error);
  }
}
