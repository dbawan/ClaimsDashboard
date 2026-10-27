import { createHash } from "node:crypto";
import express, { Router } from "express";
import { config } from "../config.js";
import { createIdempotencyStore } from "../lib/idempotencyStore.js";
import { requireSameOrigin } from "../lib/sameOrigin.js";
import { filterClaimLifecycleByPermissions } from "../permissions/claimAccess.js";
import {
  canCreateSalesforceNotes,
  requireSalesforceNoteCreate,
} from "../permissions/salesforceNoteAccess.js";
import {
  CLAIM_PERMISSION_KEYS,
  requireAnyPermission,
  requirePermission,
} from "../permissions/userPermissions.js";
import {
  getCachedClaimLifecycle,
  getClaimLifecycle,
} from "../services/claimLifecycleService.js";
import { getPatientClaimsByProcedure } from "../services/patientClaimLookupService.js";
import {
  findPatientsByName,
  getClaimsForPatient,
} from "../services/patientSearchService.js";
import {
  createSalesforceClaimNote,
  createSalesforceDiagnosisSelectionNote,
  SalesforceNoteRequestError,
} from "../services/salesforceNoteService.js";
import {
  assignClaimDiagnosis,
  createWorklistType,
  getClaimWorklists,
  listWorklistTypes,
  removeWorklistType,
  updateClaimWorklistChecks,
  WorklistRequestError,
} from "../services/worklistService.js";

export const claimsRouter = Router();
const parseSalesforceNoteBody = express.json({ limit: "40kb", strict: true });
const parseWorklistBody = express.json({ limit: "32kb", strict: true });
const salesforceNoteRequests = createIdempotencyStore();
const diagnosisAssignmentRequests = createIdempotencyStore();
const WORKLIST_USE_PERMISSIONS = Object.freeze(["worklistAccess", "worklistManagement"]);
claimsRouter.use(requireAnyPermission(CLAIM_PERMISSION_KEYS));

function requireJson(request, response, next) {
  if (request.is("application/json")) {
    next();
    return;
  }
  next(new SalesforceNoteRequestError("Salesforce notes must be submitted as JSON.", {
    code: "JSON_REQUIRED",
    statusCode: 415,
  }));
}

function requireWorklistJson(request, response, next) {
  if (request.is("application/json")) {
    next();
    return;
  }
  next(new WorklistRequestError("Worklist updates must be submitted as JSON.", {
    code: "JSON_REQUIRED",
    statusCode: 415,
  }));
}

function idempotencyKey(request) {
  const key = String(request.get("x-idempotency-key") || "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new SalesforceNoteRequestError("A valid idempotency key is required.", {
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
  }
  return key;
}

function worklistIdempotencyKey(request) {
  const key = String(request.get("x-idempotency-key") || "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new WorklistRequestError("A valid request identifier is required for diagnosis assignment.", {
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
  }
  return key;
}

function diagnosisNotificationFailure(error) {
  return Object.freeze({
    status: "failed",
    code: String(error?.code || "SALESFORCE_DIAGNOSIS_NOTIFICATION_FAILED"),
    message: error?.expose
      ? error.message
      : "Salesforce could not be notified of the diagnosis assignment.",
  });
}

claimsRouter.get("/worklist-types", requirePermission("worklistManagement"), async (request, response, next) => {
  try {
    const types = await listWorklistTypes();
    response.set("Cache-Control", "no-store, max-age=0");
    response.json({ types });
  } catch (error) {
    next(error);
  }
});

claimsRouter.post(
  "/worklist-types",
  requirePermission("worklistManagement"),
  requireSameOrigin,
  requireWorklistJson,
  parseWorklistBody,
  async (request, response, next) => {
    try {
      const type = await createWorklistType(request.body, request.user);
      console.info("[worklist] type created", {
        actorId: request.user.id,
        worklistTypeId: type.id,
      });
      response.status(201).json({ type });
    } catch (error) {
      next(error);
    }
  },
);

claimsRouter.delete(
  "/worklist-types/:typeId",
  requirePermission("worklistManagement"),
  requireSameOrigin,
  async (request, response, next) => {
    try {
      const type = await removeWorklistType(request.params.typeId, request.user);
      console.info("[worklist] type removed", {
        actorId: request.user.id,
        worklistTypeId: type.id,
      });
      response.json({ type });
    } catch (error) {
      next(error);
    }
  },
);

claimsRouter.get("/:claimId/worklist", requireAnyPermission(WORKLIST_USE_PERMISSIONS), async (request, response, next) => {
  try {
    const worklists = await getClaimWorklists(request.params.claimId);
    response.set("Cache-Control", "no-store, max-age=0");
    response.json({ worklists, worklist: worklists[0] || null });
  } catch (error) {
    next(error);
  }
});

claimsRouter.put(
  "/:claimId/worklist",
  requirePermission("worklistManagement"),
  requireSameOrigin,
  requireWorklistJson,
  parseWorklistBody,
  async (request, response, next) => {
    try {
      const key = worklistIdempotencyKey(request);
      const rawNote = typeof request.body?.note === "string" ? request.body.note : "";
      const fingerprint = createHash("sha256")
        .update(`${request.params.claimId}\u0000${request.body?.worklistTypeId}\u0000${rawNote}`)
        .digest("base64url");
      const result = await diagnosisAssignmentRequests.run({
        scope: `${request.user.id}:${key}`,
        fingerprint,
      }, async () => {
        const assignment = await assignClaimDiagnosis(
          request.params.claimId,
          request.body,
          request.user,
        );
        if (!assignment.diagnosisChanged) {
          return Object.freeze({
            worklist: assignment.worklist,
            salesforceNotification: Object.freeze({ status: "not-needed" }),
          });
        }

        try {
          const notification = await createSalesforceDiagnosisSelectionNote(
            assignment.worklist.claimId,
            assignment.worklist,
            request.user,
          );
          return Object.freeze({
            worklist: assignment.worklist,
            salesforceNotification: Object.freeze({
              status: "created",
              noteId: notification.noteId,
            }),
          });
        } catch (error) {
          console.error("[salesforce-note] diagnosis notification failed", {
            actorId: request.user.id,
            code: error?.code || error?.name || "unknown error",
          });
          return Object.freeze({
            worklist: assignment.worklist,
            salesforceNotification: diagnosisNotificationFailure(error),
          });
        }
      });
      const { worklist, salesforceNotification } = result;
      console.info("[worklist] claim type assigned", {
        actorId: request.user.id,
        worklistTypeId: worklist.type.id,
        salesforceNotification: salesforceNotification.status,
      });
      response.json({ worklist, salesforceNotification });
    } catch (error) {
      next(error);
    }
  },
);

claimsRouter.patch(
  "/:claimId/worklist/checks",
  requireAnyPermission(WORKLIST_USE_PERMISSIONS),
  requireSameOrigin,
  requireWorklistJson,
  parseWorklistBody,
  async (request, response, next) => {
    try {
      const worklist = await updateClaimWorklistChecks(
        request.params.claimId,
        request.body,
        request.user,
      );
      console.info("[worklist] claim checklist updated", {
        actorId: request.user.id,
        worklistTypeId: worklist.type.id,
        completedItems: worklist.checkedItemIds.length,
      });
      response.json({ worklist });
    } catch (error) {
      next(error);
    }
  },
);

claimsRouter.get("/patients/search", requirePermission("claimOverview"), async (request, response, next) => {
  try {
    const result = await findPatientsByName(request.query.q);
    response.set("Cache-Control", "no-store, max-age=0");
    response.json(result);
  } catch (error) {
    next(error);
  }
});

claimsRouter.get("/patients/:patientId/claims", requirePermission("claimOverview"), async (request, response, next) => {
  try {
    const result = await getClaimsForPatient(request.params.patientId, {
      includeFinancials: Boolean(request.user.permissions?.paymentsAndEra),
      startDate: request.query.startDate,
      endDate: request.query.endDate,
      offset: request.query.offset,
      procedureQuery: request.query.procedureQuery,
    });
    response.set("Cache-Control", "no-store, max-age=0");
    response.json(result);
  } catch (error) {
    next(error);
  }
});

claimsRouter.get("/:claimId/patient-claims", requirePermission("claimOverview"), async (request, response, next) => {
  try {
    const result = await getPatientClaimsByProcedure(request.params.claimId, request.query.code);
    response.set("Cache-Control", "no-store, max-age=0");
    response.json(result);
  } catch (error) {
    next(error);
  }
});

claimsRouter.post(
  "/:claimId/salesforce-notes",
  requireSalesforceNoteCreate,
  requireSameOrigin,
  requireJson,
  parseSalesforceNoteBody,
  async (request, response, next) => {
    try {
      const key = idempotencyKey(request);
      const rawText = typeof request.body?.text === "string" ? request.body.text : "";
      const fingerprint = createHash("sha256")
        .update(`${request.params.claimId}\u0000${rawText}`)
        .digest("base64url");
      const result = await salesforceNoteRequests.run({
        scope: `${request.user.id}:${key}`,
        fingerprint,
      }, () => createSalesforceClaimNote(
        request.params.claimId,
        request.body,
        request.user,
      ));

      console.info("[salesforce-note] create confirmed", {
        actorId: request.user.id,
        salesforceCaseId: result.salesforceCaseId,
        noteId: result.noteId,
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

claimsRouter.get("/:claimId/realtime", async (request, response, next) => {
  try {
    const lifecycle = await getClaimLifecycle(request.params.claimId);
    response.set("Cache-Control", "no-store, max-age=0");
    response.json(filterClaimLifecycleByPermissions(lifecycle, {
      ...request.user.permissions,
      salesforceNoteCreate: canCreateSalesforceNotes(request.user),
      salesforceNoteMaxChars: config.salesforce.noteMaxChars,
    }));
  } catch (error) {
    next(error);
  }
});

claimsRouter.get("/:claimId", async (request, response, next) => {
  try {
    const lifecycle = await getCachedClaimLifecycle(request.params.claimId);
    response.set("Cache-Control", "no-store, max-age=0");
    response.json(filterClaimLifecycleByPermissions(lifecycle, {
      ...request.user.permissions,
      salesforceNoteCreate: canCreateSalesforceNotes(request.user),
      salesforceNoteMaxChars: config.salesforce.noteMaxChars,
    }));
  } catch (error) {
    next(error);
  }
});
