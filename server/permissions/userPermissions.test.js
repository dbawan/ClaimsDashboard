import test from "node:test";
import assert from "node:assert/strict";
import {
  PermissionDeniedError,
  loadUserPermissions,
  permissionsFromRow,
  provisionUserPermissions,
  requireAnyPermission,
  requirePermission,
} from "./userPermissions.js";

test("database permission columns map to explicit booleans", () => {
  assert.deepEqual(permissionsFromRow({
    claim_overview: 1,
    payments_and_era: 0,
    supporting_records: "1",
    high_level_operations: false,
    worklist_access: 0,
    worklist_management: 1,
  }), {
    claimOverview: true,
    paymentsAndEra: false,
    supportingRecords: true,
    highLevelOperations: false,
    worklistAccess: false,
    worklistManagement: true,
  });
});

test("SSO provisioning inserts defaults without resetting an existing user's flags", async () => {
  const calls = [];
  await provisionUserPermissions("cognito-sub-123", {
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [{ affectedRows: 1 }];
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO `UniLocus`\.`claims_dashboard_user_permissions`/);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE last_login_at = UTC_TIMESTAMP\(\)/);
  assert.doesNotMatch(calls[0].sql, /claim_overview\s*=/);
  assert.doesNotMatch(calls[0].sql, /payments_and_era\s*=/);
  assert.deepEqual(calls[0].parameters, ["cognito-sub-123"]);
});

test("missing users are provisioned and reloaded with database defaults", async () => {
  let selectCount = 0;
  const calls = [];
  const execute = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (/^\s*SELECT/.test(sql)) {
      selectCount += 1;
      return [selectCount === 1 ? [] : [{
        claim_overview: 1,
        payments_and_era: 1,
        supporting_records: 1,
        high_level_operations: 1,
        worklist_access: 0,
        worklist_management: 0,
      }]];
    }
    return [{ affectedRows: 1 }];
  };

  const permissions = await loadUserPermissions("new-user", { execute });

  assert.deepEqual(permissions, {
    claimOverview: true,
    paymentsAndEra: true,
    supportingRecords: true,
    highLevelOperations: true,
    worklistAccess: false,
    worklistManagement: false,
  });
  assert.equal(calls.filter(({ sql }) => /^\s*SELECT/.test(sql)).length, 2);
  assert.equal(calls.filter(({ sql }) => /^\s*INSERT/.test(sql)).length, 1);
  assert.ok(calls.every(({ parameters }) => parameters[0] === "new-user"));
});

test("permission middleware fails closed", () => {
  let denied;
  requirePermission("highLevelOperations")(
    { user: { permissions: { highLevelOperations: false } } },
    {},
    (error) => { denied = error; },
  );
  assert.ok(denied instanceof PermissionDeniedError);
  assert.equal(denied.statusCode, 403);

  let allowed = false;
  requireAnyPermission(["claimOverview", "paymentsAndEra"])(
    { user: { permissions: { claimOverview: false, paymentsAndEra: true } } },
    {},
    (error) => { allowed = !error; },
  );
  assert.equal(allowed, true);

  let worklistDenied;
  requirePermission("worklistManagement")(
    { user: { permissions: { worklistManagement: false } } },
    {},
    (error) => { worklistDenied = error; },
  );
  assert.ok(worklistDenied instanceof PermissionDeniedError);

  let worklistUseAllowed = false;
  requireAnyPermission(["worklistAccess", "worklistManagement"])(
    { user: { permissions: { worklistAccess: true, worklistManagement: false } } },
    {},
    (error) => { worklistUseAllowed = !error; },
  );
  assert.equal(worklistUseAllowed, true);
});
