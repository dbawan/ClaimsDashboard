import test from "node:test";
import assert from "node:assert/strict";
import {
  createSalesforceClaimNote,
  createSalesforceDiagnosisSelectionNote,
  formatSalesforceDiagnosisSelection,
  formatSalesforceNoteText,
  resolveSalesforceNoteTarget,
  salesforceNoteAttribution,
  validateSalesforceNoteText,
} from "./salesforceNoteService.js";

const settings = Object.freeze({
  configured: true,
  noteWritesEnabled: true,
  noteWriterGroups: ["note-writers"],
  noteMaxChars: 50,
  caseObject: "UniSuite_RCM_Case__c",
  statusField: "UniSuite_Status__c",
  claimIdField: "UniSuite_Claim_ID__c",
  icnField: "UniSuite_ICN__c",
});

const actor = Object.freeze({
  id: "user-1",
  name: "Alex Morgan",
  email: "alex.morgan@unithera.com",
  groups: ["note-writers"],
  permissions: { supportingRecords: true, worklistManagement: true },
});

const diagnosisWorklist = Object.freeze({
  claimId: "81047",
  type: Object.freeze({
    id: 7,
    name: "Denial follow-up",
    checkboxes: Object.freeze([
      Object.freeze({ id: "check-1", label: "Confirm denial reason" }),
      Object.freeze({ id: "check-2", label: "Prepare appeal" }),
    ]),
  }),
});

test("Salesforce note text validation trims input and enforces the configured limit", () => {
  assert.equal(validateSalesforceNoteText("  Followed up with payer.  ", 50), "Followed up with payer.");
  assert.throws(() => validateSalesforceNoteText("   ", 50), /Enter a message/);
  assert.throws(() => validateSalesforceNoteText("x".repeat(51), 50), /50 characters or fewer/);
});

test("Salesforce note attribution is generated from the signed-in user", () => {
  assert.equal(
    salesforceNoteAttribution(actor),
    [
      "—",
      "Submission source: United Theranostics Claim Lifecycle application",
      "Submitted by: Alex Morgan (alex.morgan@unithera.com)",
    ].join("\n"),
  );
  assert.equal(
    formatSalesforceNoteText("Followed up with payer.", actor),
    [
      "Followed up with payer.",
      "",
      "—",
      "Submission source: United Theranostics Claim Lifecycle application",
      "Submitted by: Alex Morgan (alex.morgan@unithera.com)",
    ].join("\n"),
  );
});

test("diagnosis selection message names the diagnosis and every assigned task", () => {
  assert.equal(
    formatSalesforceDiagnosisSelection(diagnosisWorklist),
    [
      "Diagnosis chosen: Denial follow-up",
      "",
      "Tasks assigned to this claim:",
      "1. Confirm denial reason",
      "2. Prepare appeal",
    ].join("\n"),
  );
});

test("note target resolution prefers one primary claim ticket over correction-family tickets", () => {
  const claim = { claimId: "81047", encounterId: "81047", alternateIdentifiers: ["81047Z70886"] };
  const target = resolveSalesforceNoteTarget(claim, [
    { Id: "a00V50000012345IAB", UniSuite_Claim_ID__c: "81047A" },
    { Id: "a00V50000012345IAA", UniSuite_Claim_ID__c: "81047" },
  ], settings);
  assert.equal(target.Id, "a00V50000012345IAA");
});

test("note target resolution fails closed when more than one exact ticket matches", () => {
  const claim = { claimId: "81047", encounterId: "81047" };
  assert.throws(
    () => resolveSalesforceNoteTarget(claim, [
      { Id: "a00V50000012345IAA", UniSuite_Claim_ID__c: "81047" },
      { Id: "a00V50000012345IAB", UniSuite_Claim_ID__c: "81047" },
    ], settings),
    (error) => error.code === "SALESFORCE_CASE_AMBIGUOUS" && error.statusCode === 409,
  );
});

test("claim-note service resolves through reads and invokes one injected create operation", async () => {
  const calls = [];
  let invalidations = 0;
  const writer = {
    readClient: {
      async query() {
        return [{
          Id: "a00V50000012345IAA",
          UniSuite_Claim_ID__c: "81047",
          UniSuite_Status__c: "In Process",
        }];
      },
    },
    async createNote(payload) {
      calls.push(payload);
      return { ...payload, noteId: "a01V50000012345IAA" };
    },
  };

  const result = await createSalesforceClaimNote(
    "81047",
    { text: "  Followed up with payer.  " },
    actor,
    {
      settings,
      writer,
      invalidateClaimEnrichments: () => { invalidations += 1; },
      getClaim: async () => ({
        claim: { claimId: "81047", encounterId: "81047", alternateIdentifiers: [] },
      }),
    },
  );

  assert.deepEqual(calls, [{
    caseId: "a00V50000012345IAA",
    text: [
      "Followed up with payer.",
      "",
      "—",
      "Submission source: United Theranostics Claim Lifecycle application",
      "Submitted by: Alex Morgan (alex.morgan@unithera.com)",
    ].join("\n"),
  }]);
  assert.deepEqual(result, {
    status: "created",
    claimId: "81047",
    salesforceCaseId: "a00V50000012345IAA",
    noteId: "a01V50000012345IAA",
  });
  assert.equal(invalidations, 1);
});

test("diagnosis assignment writes its generated message to the exact Salesforce claim", async () => {
  const calls = [];
  const diagnosisActor = {
    id: "diagnosis-user-1",
    name: "Jordan Lee",
    email: "jordan.lee@unithera.com",
    groups: [],
    permissions: { worklistManagement: true },
  };
  const writer = {
    readClient: {
      async query() {
        return [{
          Id: "a00V50000012345IAA",
          UniSuite_Claim_ID__c: "81047",
          UniSuite_Status__c: "In Process",
        }];
      },
    },
    async createNote(payload) {
      calls.push(payload);
      return { ...payload, noteId: "a01V50000012345IAA" };
    },
  };

  await createSalesforceDiagnosisSelectionNote(
    "81047",
    diagnosisWorklist,
    diagnosisActor,
    {
      settings: { ...settings, noteMaxChars: 5_000, noteWriterGroups: [] },
      writer,
      invalidateClaimEnrichments: () => {},
      getClaim: async () => ({
        claim: { claimId: "81047", encounterId: "81047", alternateIdentifiers: ["81047A"] },
      }),
    },
  );

  assert.deepEqual(calls, [{
    caseId: "a00V50000012345IAA",
    text: [
      "Diagnosis chosen: Denial follow-up",
      "",
      "Tasks assigned to this claim:",
      "1. Confirm denial reason",
      "2. Prepare appeal",
      "",
      "—",
      "Submission source: United Theranostics Claim Lifecycle application",
      "Submitted by: Jordan Lee (jordan.lee@unithera.com)",
    ].join("\n"),
  }]);
});

test("claim-note service blocks disabled writes before any lookup", async () => {
  let lookupCalled = false;
  await assert.rejects(
    createSalesforceClaimNote("81047", { text: "Test" }, actor, {
      settings: { ...settings, noteWritesEnabled: false },
      getClaim: async () => { lookupCalled = true; },
    }),
    (error) => error.code === "PERMISSION_DENIED" && error.statusCode === 403,
  );
  assert.equal(lookupCalled, false);
});
