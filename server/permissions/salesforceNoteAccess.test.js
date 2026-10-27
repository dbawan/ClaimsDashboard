import test from "node:test";
import assert from "node:assert/strict";
import { canCreateSalesforceNotes } from "./salesforceNoteAccess.js";

const enabled = Object.freeze({
  configured: true,
  noteWritesEnabled: true,
  noteWriterGroups: ["claims-note-writers"],
});

test("Salesforce note creation requires the switch, supporting-record access, and an allowed group", () => {
  const user = {
    groups: ["claims-note-writers"],
    permissions: { supportingRecords: true },
  };

  assert.equal(canCreateSalesforceNotes(user, enabled), true);
  assert.equal(canCreateSalesforceNotes(user, { ...enabled, noteWritesEnabled: false }), false);
  assert.equal(canCreateSalesforceNotes(user, { ...enabled, noteWriterGroups: [] }), false);
  assert.equal(canCreateSalesforceNotes({ ...user, groups: ["other"] }, enabled), false);
  assert.equal(canCreateSalesforceNotes({ ...user, permissions: { supportingRecords: false } }, enabled), false);
});
