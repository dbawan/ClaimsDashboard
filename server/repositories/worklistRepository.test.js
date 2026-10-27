import test from "node:test";
import assert from "node:assert/strict";
import {
  deactivateWorklistType,
  findClaimWorklist,
  findClaimWorklistByTypeId,
  findClaimWorklists,
  insertWorklistType,
  listClaimWorklistOwners,
  listWorklistTypes,
  updateClaimWorklistChecks,
  upsertClaimWorklist,
} from "./worklistRepository.js";

test("worklist type queries use only the configured UniLocus tables and parse JSON", async () => {
  const calls = [];
  const types = await listWorklistTypes({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[{
        id: 3,
        type_name: "Appeal",
        checkboxes_json: JSON.stringify([{ id: "one", label: "Review response" }]),
        assignment_count: 2,
        created_at: "2026-08-28 12:00:00",
        updated_at: "2026-08-28 12:00:00",
      }]];
    },
  });

  assert.match(calls[0].sql, /FROM `UniLocus`\.`claims_dashboard_worklist_types`/);
  assert.match(calls[0].sql, /WHERE type\.is_active = TRUE/);
  assert.deepEqual(types[0].checkboxes, [{ id: "one", label: "Review response" }]);
  assert.equal(types[0].assignmentCount, 2);
});

test("creating a type writes its checkbox definitions as JSON", async () => {
  let call;
  const type = await insertWorklistType({
    name: "Appeal",
    checkboxes: [{ id: "one", label: "Review response" }],
    actorId: "user-1",
  }, {
    execute: async (sql, parameters) => {
      call = { sql, parameters };
      return [{ insertId: 12 }];
    },
  });

  assert.match(call.sql, /INSERT INTO `UniLocus`\.`claims_dashboard_worklist_types`/);
  assert.equal(call.parameters[0], "Appeal");
  assert.equal(call.parameters[1], '[{"id":"one","label":"Review response"}]');
  assert.equal(type.id, 12);
});

test("removing a reusable type is a catalog-only soft removal", async () => {
  let call;
  const removed = await deactivateWorklistType(12, {
    execute: async (sql, parameters) => {
      call = { sql, parameters };
      return [{ affectedRows: 1 }];
    },
  });

  assert.equal(removed, true);
  assert.match(call.sql, /SET is_active = FALSE/);
  assert.doesNotMatch(call.sql, /DELETE FROM/);
  assert.doesNotMatch(call.sql, /claims_dashboard_claim_worklists.*UPDATE/s);
  assert.deepEqual(call.parameters, [12]);
});

test("claim assignment and checklist updates are confined to one canonical claim", async () => {
  const calls = [];
  const row = {
    claim_id: "81047",
    checkbox_state_json: '["one"]',
    note_text: "Confirm the payer reference before closing.",
    completion_details_json: JSON.stringify({
      one: {
        completedBy: { id: "user-2", name: "Jamie Rivera" },
        completedAt: "2026-09-11T15:30:00.000Z",
      },
    }),
    id: 3,
    type_name: "Appeal",
    checkboxes_json: '[{"id":"one","label":"Review response"}]',
  };
  const execute = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (/^\s*SELECT/.test(sql)) return [[row]];
    return [{ affectedRows: 1 }];
  };

  const assigned = await upsertClaimWorklist({
    claimId: "81047",
    typeId: 3,
    note: "Confirm the payer reference before closing.",
    actorId: "user-1",
    actorName: "Alex Morgan",
  }, { execute });
  assert.match(calls[0].sql, /INSERT INTO `UniLocus`\.`claims_dashboard_claim_worklists`/);
  assert.doesNotMatch(calls[0].sql, /^\s*worklist_type_id = VALUES\(worklist_type_id\)/m);
  assert.deepEqual(calls[0].parameters, [
    "81047",
    "Confirm the payer reference before closing.",
    "user-1",
    "Alex Morgan",
    "user-1",
    3,
  ]);
  assert.deepEqual(assigned.checkedItemIds, ["one"]);
  assert.equal(assigned.note, "Confirm the payer reference before closing.");
  assert.equal(assigned.completionDetails.one.completedBy.name, "Jamie Rivera");

  calls.length = 0;
  await updateClaimWorklistChecks({
    claimId: "81047",
    typeId: 3,
    checkedItemIds: [],
    completionDetails: {},
    actorId: "user-2",
  }, { execute });
  assert.match(calls[0].sql, /WHERE claim_id = \?\s+AND worklist_type_id = \?/);
  assert.deepEqual(calls[0].parameters, ["[]", "{}", "user-2", "81047", 3]);

  const fetched = await findClaimWorklist("81047", { execute });
  assert.equal(fetched.type.name, "Appeal");
});

test("claim assignment fallback qualifies target columns when owner names are unavailable", async () => {
  const calls = [];
  const row = {
    claim_id: "81047",
    checkbox_state_json: "[]",
    completion_details_json: "{}",
    id: 3,
    type_name: "Appeal",
    checkboxes_json: '[{"id":"one","label":"Review response"}]',
  };
  let insertAttempts = 0;
  const execute = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (/^\s*SELECT/.test(sql)) return [[row]];
    insertAttempts += 1;
    if (insertAttempts === 1) {
      const error = new Error("Unknown column assigned_by_name");
      error.code = "ER_BAD_FIELD_ERROR";
      throw error;
    }
    return [{ affectedRows: 1 }];
  };

  const assigned = await upsertClaimWorklist({
    claimId: "81047",
    typeId: 3,
    note: "Confirm the payer reference.",
    actorId: "user-1",
    actorName: "Alex Morgan",
  }, { execute });

  const fallback = calls[1].sql;
  assert.equal(insertAttempts, 2);
  assert.match(fallback, /`UniLocus`\.`claims_dashboard_claim_worklists`\.worklist_type_id/);
  assert.match(fallback, /CURRENT_TIMESTAMP, `UniLocus`\.`claims_dashboard_claim_worklists`\.updated_at/);
  assert.equal(assigned.type.name, "Appeal");
});

test("Claim ICU worklist owners are returned with their current type", async () => {
  let call;
  const owners = await listClaimWorklistOwners(["81047", "81048", "81047"], {
    execute: async (sql, parameters) => {
      call = { sql, parameters };
      return [[{
        claim_id: "81047",
        assigned_by_cognito_uid: "user-1",
        assigned_by_name: "Alex Morgan",
        type_name: "Appeal",
      }]];
    },
  });

  assert.match(call.sql, /assignment\.assigned_by_name/);
  assert.deepEqual(call.parameters, ["81047", "81048"]);
  assert.deepEqual(owners, [{
    claimId: "81047",
    ownerId: "user-1",
    ownerName: "Alex Morgan",
    worklistType: "Appeal",
  }]);
});

test("all worklists for a claim are returned without collapsing distinct types", async () => {
  const calls = [];
  const rows = [
    {
      claim_id: "81047",
      checkbox_state_json: "[]",
      completion_details_json: "{}",
      id: 3,
      type_name: "Appeal",
      checkboxes_json: '[{"id":"one","label":"Review response"}]',
    },
    {
      claim_id: "81047",
      checkbox_state_json: '["two"]',
      completion_details_json: "{}",
      id: 4,
      type_name: "Coding review",
      checkboxes_json: '[{"id":"two","label":"Confirm code"}]',
    },
  ];
  const execute = async (sql, parameters) => {
    calls.push({ sql, parameters });
    return [[...rows]];
  };

  const worklists = await findClaimWorklists("81047", { execute });
  assert.equal(worklists.length, 2);
  assert.deepEqual(worklists.map(({ type }) => type.name), ["Appeal", "Coding review"]);
  assert.doesNotMatch(calls[0].sql, /LIMIT 1/);

  calls.length = 0;
  await findClaimWorklistByTypeId("81047", 4, { execute });
  assert.match(calls[0].sql, /assignment\.worklist_type_id = \?/);
  assert.deepEqual(calls[0].parameters, ["81047", 4]);
});
