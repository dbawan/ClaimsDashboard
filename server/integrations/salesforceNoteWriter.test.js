import test from "node:test";
import assert from "node:assert/strict";
import { SalesforceNoteWriter, SalesforceNoteWriteError } from "./salesforceNoteWriter.js";

const settings = Object.freeze({
  apiVersion: "v61.0",
  noteObject: "UniSuite_RCM_Case_Note__c",
  noteCaseField: "UniSuite_RCM_Case__c",
  noteTextField: "UniSuite_Text__c",
  noteRecordType: "Claim",
  timeoutMs: 1_000,
});

function readClient(query) {
  return {
    instanceUrl: "https://example.my.salesforce.com",
    accessToken: "test-token",
    authenticate: async () => {},
    query,
  };
}

test("Salesforce note writer posts only a new note with its parent, text, and Claim record type", async () => {
  const requests = [];
  const writer = new SalesforceNoteWriter(settings, {
    readClient: readClient(async (soql) => {
      assert.match(soql, /^SELECT Id,DeveloperName,Name FROM RecordType/);
      return [{ Id: "012V5000004zRkBIAU", DeveloperName: "Claim", Name: "Claim" }];
    }),
    fetchImplementation: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ id: "a01V50000012345IAA", success: true, errors: [] }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const result = await writer.createNote({
    caseId: "a00V50000012345IAA",
    text: "Payer follow-up completed.",
  });

  assert.deepEqual(result, {
    noteId: "a01V50000012345IAA",
    caseId: "a00V50000012345IAA",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(
    requests[0].url,
    "https://example.my.salesforce.com/services/data/v61.0/sobjects/UniSuite_RCM_Case_Note__c",
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    UniSuite_RCM_Case__c: "a00V50000012345IAA",
    UniSuite_Text__c: "Payer follow-up completed.",
    RecordTypeId: "012V5000004zRkBIAU",
  });
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
});

test("Salesforce validation failures are sanitized and never retried as another write", async () => {
  let requestCount = 0;
  const writer = new SalesforceNoteWriter(settings, {
    readClient: readClient(async () => [{ Id: "012V5000004zRkBIAU" }]),
    fetchImplementation: async () => {
      requestCount += 1;
      return new Response(JSON.stringify([{
        errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION",
        message: "Sensitive internal validation detail",
      }]), { status: 400, headers: { "Content-Type": "application/json" } });
    },
  });

  await assert.rejects(
    writer.createNote({ caseId: "a00V50000012345IAA", text: "Test" }),
    (error) => error instanceof SalesforceNoteWriteError
      && error.code === "SALESFORCE_NOTE_REJECTED"
      && !error.message.includes("Sensitive"),
  );
  assert.equal(requestCount, 1);
});
