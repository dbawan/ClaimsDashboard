import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReadOnlySoql,
  canonicalSalesforceClaimToken,
  claimIdentifierCandidates,
  readSalesforceClaimComments,
  soqlQuote,
} from "./salesforceComments.js";

const settings = Object.freeze({
  configured: true,
  partial: false,
  caseObject: "UniSuite_RCM_Case__c",
  noteObject: "UniSuite_RCM_Case_Note__c",
  statusField: "UniSuite_Status__c",
  claimIdField: "UniSuite_Claim_ID__c",
  icnField: "UniSuite_ICN__c",
  noteCaseField: "UniSuite_RCM_Case__c",
  noteActionField: "UniSuite_Action__c",
  noteFollowupField: "UniSuite_Follow_Up_Action__c",
  noteTextField: "UniSuite_Text__c",
  notePaidField: "UniSuite_Paid__c",
  noteAllowedField: "UniSuite_Allowed_Amount__c",
  noteAmountField: "UniSuite_Amount__c",
  noteCheckField: "UniSuite_Check_EFT_Number__c",
  noteClearedField: "UniSuite_Cleared_Date__c",
  noteIssueField: "UniSuite_Issue_Date__c",
  notePostingIssueField: "UniSuite_Payment_Posting_Issue__c",
  maxComments: 10,
});

test("Salesforce guard accepts one SELECT and rejects locking or mutation queries", () => {
  assert.equal(assertReadOnlySoql(" SELECT Id FROM Example__c "), "SELECT Id FROM Example__c");
  assert.throws(() => assertReadOnlySoql("UPDATE Example__c SET Name='x'"), /Only Salesforce SELECT/);
  assert.throws(() => assertReadOnlySoql("SELECT Id FROM Example__c FOR UPDATE"), /non-locking SELECT/);
  assert.throws(() => assertReadOnlySoql("SELECT Id FROM Example__c; DELETE"), /non-locking SELECT/);
  assert.equal(soqlQuote("A'B\\C"), "'A\\'B\\\\C'");
});

test("Salesforce claim normalization includes corrections and archives but not numeric lookalikes", () => {
  assert.equal(canonicalSalesforceClaimToken("81047"), "81047");
  assert.equal(canonicalSalesforceClaimToken("81047A"), "81047");
  assert.equal(canonicalSalesforceClaimToken("81047Z70886"), "81047");
  assert.equal(canonicalSalesforceClaimToken("ARCHIVE-81047-OLD"), "81047");
  assert.equal(canonicalSalesforceClaimToken("810470"), "810470");
});

test("Salesforce comment lookup uses exact claim identifiers and preserves timestamp order", async () => {
  const queries = [];
  const client = {
    async query(soql) {
      queries.push(soql);
      if (queries.length === 1) {
        return [
          {
            Id: "case-1",
            UniSuite_Claim_ID__c: "81047Z70886",
            UniSuite_Status__c: "In Process",
          },
          {
            Id: "numeric-lookalike",
            UniSuite_Claim_ID__c: "810470",
            UniSuite_Status__c: "In Process",
          },
        ];
      }
      return [
        {
          Id: "note-1",
          UniSuite_RCM_Case__c: "case-1",
          CreatedDate: "2026-07-14T15:00:00.000Z",
          UniSuite_Action__c: "SENT APPEAL PORTAL",
          UniSuite_Text__c: "Appeal submitted through the payer portal.",
          UniSuite_Paid__c: "125.50",
          UniSuite_Check_EFT_Number__c: "CHECK-9",
        },
        {
          Id: "note-2",
          UniSuite_RCM_Case__c: "case-1",
          CreatedDate: "2026-07-15T15:00:00.000Z",
          UniSuite_Action__c: "APPEAL FOLLOWUP",
          UniSuite_Text__c: "Payer says appeal remains under review.",
        },
      ];
    },
  };
  const claim = {
    claimId: "81047",
    encounterId: "81047",
    alternateIdentifiers: ["81047Z70886", "81047Z70886"],
  };
  const result = await readSalesforceClaimComments(claim, { settings, client });

  assert.deepEqual(claimIdentifierCandidates(claim), ["81047", "81047Z70886"]);
  assert.match(queries[0], /UniSuite_Claim_ID__c IN \('81047','81047Z70886'\)/);
  assert.match(queries[0], /UniSuite_Claim_ID__c LIKE '81047%'/);
  assert.match(queries[0], /UniSuite_Claim_ID__c LIKE 'ARCHIVE-81047%'/);
  assert.match(queries[1], /WHERE UniSuite_RCM_Case__c IN \('case-1'\)/);
  assert.match(queries[1], /ORDER BY CreatedDate,Id LIMIT 11$/);
  assert.equal(result.integration.status, "ready");
  assert.equal(result.integration.caseStatus, "In Process");
  assert.equal(result.integration.caseCount, 1);
  assert.equal(result.comments[0].commentId, "note-1");
  assert.equal(result.comments[0].date, "2026-07-14");
  assert.equal(result.comments[0].paid, 125.5);
  assert.equal(result.comments[0].checkEft, "CHECK-9");
  assert.equal(result.comments[1].commentId, "note-2");
});

test("missing Salesforce credentials leave the claim available without a network call", async () => {
  const result = await readSalesforceClaimComments(
    { claimId: "81047" },
    { settings: { ...settings, configured: false, partial: false } },
  );
  assert.equal(result.integration.status, "not_configured");
  assert.deepEqual(result.comments, []);
});
