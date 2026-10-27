import test from "node:test";
import assert from "node:assert/strict";
import {
  assignClaimDiagnosis,
  assignClaimWorklist,
  createWorklistType,
  getClaimWorklists,
  removeWorklistType,
  updateClaimWorklistChecks,
} from "./worklistService.js";

const actor = Object.freeze({ id: "cognito-user-1", name: "Alex Morgan" });
const type = Object.freeze({
  id: 7,
  name: "Denial follow-up",
  checkboxes: Object.freeze([
    Object.freeze({ id: "check-1", label: "Confirm denial reason" }),
    Object.freeze({ id: "check-2", label: "Prepare appeal" }),
  ]),
});

test("worklist types store normalized names and server-generated checkbox definitions", async () => {
  const calls = [];
  let nextId = 0;
  const result = await createWorklistType({
    name: "  Denial   follow-up ",
    checkboxes: [" Confirm denial reason ", { label: "Prepare appeal" }],
  }, actor, {
    createId: () => `generated-${++nextId}`,
    repository: {
      async insertWorklistType(input) {
        calls.push(input);
        return { id: 7, ...input };
      },
    },
  });

  assert.deepEqual(calls, [{
    name: "Denial follow-up",
    actorId: "cognito-user-1",
    checkboxes: [
      { id: "generated-1", label: "Confirm denial reason" },
      { id: "generated-2", label: "Prepare appeal" },
    ],
  }]);
  assert.equal(result.id, 7);
});

test("worklist type validation rejects duplicate or empty checkbox definitions", async () => {
  const repository = { insertWorklistType: async () => assert.fail("database should not be called") };
  await assert.rejects(
    createWorklistType({ name: "Appeal", checkboxes: ["Review", " review "] }, actor, { repository }),
    (error) => error.code === "DUPLICATE_WORKLIST_CHECKBOX",
  );
  await assert.rejects(
    createWorklistType({ name: "Appeal", checkboxes: [] }, actor, { repository }),
    (error) => error.code === "WORKLIST_CHECKBOX_REQUIRED",
  );
});

test("catalog removal preserves and reports existing claim assignments", async () => {
  let deactivateCalled = false;
  const removed = await removeWorklistType(7, actor, {
    repository: {
      findWorklistTypeById: async () => ({ ...type, assignmentCount: 2 }),
      deactivateWorklistType: async () => {
        deactivateCalled = true;
        return true;
      },
    },
  });
  assert.equal(deactivateCalled, true);
  assert.deepEqual(removed, { id: 7, name: "Denial follow-up", preservedAssignmentCount: 2 });
});

test("an already removed diagnosis reports not found", async () => {
  await assert.rejects(
    removeWorklistType(7, actor, {
      repository: {
        findWorklistTypeById: async () => ({ ...type, assignmentCount: 0 }),
        deactivateWorklistType: async () => false,
      },
    }),
    (error) => error.code === "WORKLIST_TYPE_NOT_FOUND" && error.statusCode === 404,
  );
});

test("an existing type is assigned to the resolved canonical claim", async () => {
  const calls = [];
  const repository = {
    async findWorklistTypeById(typeId) {
      assert.equal(typeId, 7);
      return type;
    },
    async findClaimWorklist() {
      return null;
    },
    async upsertClaimWorklist(input) {
      calls.push(input);
      return { claimId: input.claimId, type, checkedItemIds: [] };
    },
  };

  const result = await assignClaimWorklist("payer-alias", {
    worklistTypeId: "7",
    note: "Call payer before filing the appeal.\r\nReference case 42.",
  }, actor, {
    repository,
    getClaim: async () => ({ claim: { claimId: "81047" } }),
  });

  assert.deepEqual(calls, [{
    claimId: "81047",
    typeId: 7,
    note: "Call payer before filing the appeal.\nReference case 42.",
    actorId: "cognito-user-1",
    actorName: "Alex Morgan",
  }]);
  assert.equal(result.claimId, "81047");
});

test("diagnosis assignment reports only an actual type change", async () => {
  let current = { claimId: "81047", type, checkedItemIds: [], note: "" };
  const repository = {
    async findWorklistTypeById() {
      return type;
    },
    async findClaimWorklist() {
      return current;
    },
    async upsertClaimWorklist(input) {
      current = { ...current, claimId: input.claimId, note: input.note };
      return current;
    },
  };

  const unchanged = await assignClaimDiagnosis(
    "81047",
    { worklistTypeId: "7", note: "Updated context" },
    actor,
    { repository, getClaim: async () => ({ claim: { claimId: "81047" } }) },
  );
  assert.equal(unchanged.diagnosisChanged, false);

  current = null;
  const changed = await assignClaimDiagnosis(
    "81047",
    { worklistTypeId: "7", note: "" },
    actor,
    { repository, getClaim: async () => ({ claim: { claimId: "81047" } }) },
  );
  assert.equal(changed.diagnosisChanged, true);
});

test("diagnosis notes are length-limited before assignment", async () => {
  await assert.rejects(
    assignClaimWorklist("81047", {
      worklistTypeId: "7",
      note: "x".repeat(4_001),
    }, actor, {
      getClaim: async () => ({ claim: { claimId: "81047" } }),
      repository: {
        findWorklistTypeById: async () => assert.fail("database should not be called"),
      },
    }),
    (error) => error.code === "WORKLIST_NOTE_TOO_LONG",
  );
});

test("assignment fails safely when the database has not enabled multiple worklists", async () => {
  await assert.rejects(
    assignClaimWorklist("81047", { worklistTypeId: "7", note: "" }, actor, {
      getClaim: async () => ({ claim: { claimId: "81047" } }),
      repository: {
        findWorklistTypeById: async () => type,
        findClaimWorklist: async () => null,
        upsertClaimWorklist: async () => null,
      },
    }),
    (error) => error.code === "MULTIPLE_WORKLISTS_MIGRATION_REQUIRED" && error.statusCode === 409,
  );
});

test("claim checkbox updates accept only item IDs from the assigned type", async () => {
  let update;
  const current = { claimId: "81047", type, checkedItemIds: [], completionDetails: {} };
  const repository = {
    async findClaimWorklist() {
      return update ? { ...current, checkedItemIds: update.checkedItemIds } : current;
    },
    async updateClaimWorklistChecks(input) {
      update = input;
      return { ...current, checkedItemIds: input.checkedItemIds };
    },
  };
  const options = {
    repository,
    getClaim: async () => ({ claim: { claimId: "81047" } }),
    now: () => new Date("2026-09-11T16:42:00.000Z"),
  };

  const result = await updateClaimWorklistChecks(
    "81047",
    { checkedItemIds: ["check-2", "check-2"] },
    actor,
    options,
  );
  assert.deepEqual(update, {
    claimId: "81047",
    typeId: 7,
    checkedItemIds: ["check-2"],
    completionDetails: {
      "check-2": {
        completedBy: { id: "cognito-user-1", name: "Alex Morgan" },
        completedAt: "2026-09-11T16:42:00.000Z",
      },
    },
    actorId: "cognito-user-1",
  });
  assert.deepEqual(result.checkedItemIds, ["check-2"]);

  update = null;
  await assert.rejects(
    updateClaimWorklistChecks("81047", { checkedItemIds: ["not-on-type"] }, actor, options),
    (error) => error.code === "UNKNOWN_WORKLIST_CHECKBOX" && error.statusCode === 409,
  );
});

test("completion attribution is preserved until a task is unchecked and completed again", async () => {
  const originalCompletion = {
    completedBy: { id: "first-user", name: "First User" },
    completedAt: "2026-09-10T14:00:00.000Z",
  };
  let current = {
    claimId: "81047",
    type,
    checkedItemIds: ["check-1"],
    completionDetails: { "check-1": originalCompletion },
  };
  const repository = {
    async findClaimWorklist() {
      return current;
    },
    async updateClaimWorklistChecks(input) {
      current = { ...current, ...input };
      return current;
    },
  };
  const options = {
    repository,
    getClaim: async () => ({ claim: { claimId: "81047" } }),
    now: () => new Date("2026-09-11T16:42:00.000Z"),
  };

  const completed = await updateClaimWorklistChecks(
    "81047",
    { checkedItemIds: ["check-1", "check-2"] },
    actor,
    options,
  );
  assert.deepEqual(completed.completionDetails["check-1"], originalCompletion);
  assert.equal(completed.completionDetails["check-2"].completedBy.name, "Alex Morgan");

  const reopened = await updateClaimWorklistChecks(
    "81047",
    { checkedItemIds: ["check-2"] },
    actor,
    options,
  );
  assert.equal(reopened.completionDetails["check-1"], undefined);
});

test("legacy checked tasks are not attributed to a later user", async () => {
  let update;
  const current = {
    claimId: "81047",
    type,
    checkedItemIds: ["check-1"],
    completionDetails: {},
  };
  const result = await updateClaimWorklistChecks(
    "81047",
    { checkedItemIds: ["check-1", "check-2"] },
    actor,
    {
      getClaim: async () => ({ claim: { claimId: "81047" } }),
      now: () => new Date("2026-09-11T16:42:00.000Z"),
      repository: {
        findClaimWorklist: async () => current,
        updateClaimWorklistChecks: async (input) => {
          update = input;
          return { ...current, ...input };
        },
      },
    },
  );

  assert.equal(update.completionDetails["check-1"], undefined);
  assert.equal(result.completionDetails["check-2"].completedBy.name, "Alex Morgan");
});

test("multiple diagnosis assignments remain independently addressable", async () => {
  const secondType = {
    id: 8,
    name: "Coding review",
    checkboxes: [{ id: "code-1", label: "Confirm code" }],
  };
  const assigned = [
    { claimId: "81047", type, checkedItemIds: [], completionDetails: {} },
    { claimId: "81047", type: secondType, checkedItemIds: [], completionDetails: {} },
  ];
  let lookedUpTypeId;
  const repository = {
    async findClaimWorklists() {
      return assigned;
    },
    async findClaimWorklistByTypeId(claimId, typeId) {
      assert.equal(claimId, "81047");
      lookedUpTypeId = typeId;
      return assigned.find((worklist) => worklist.type.id === typeId) || null;
    },
    async updateClaimWorklistChecks(input) {
      return { ...assigned[1], ...input };
    },
  };

  const worklists = await getClaimWorklists("81047", { repository });
  assert.equal(worklists.length, 2);

  const updated = await updateClaimWorklistChecks(
    "81047",
    { worklistTypeId: 8, checkedItemIds: ["code-1"] },
    actor,
    {
      repository,
      getClaim: async () => ({ claim: { claimId: "81047" } }),
      now: () => new Date("2026-09-11T17:00:00.000Z"),
    },
  );
  assert.equal(lookedUpTypeId, 8);
  assert.deepEqual(updated.checkedItemIds, ["code-1"]);
  assert.equal(updated.completionDetails["code-1"].completedBy.name, "Alex Morgan");
});
