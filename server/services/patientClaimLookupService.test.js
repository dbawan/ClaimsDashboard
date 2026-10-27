import test from "node:test";
import assert from "node:assert/strict";
import { assertValidProcedureCode } from "./patientClaimLookupService.js";

test("patient claim lookup accepts CPT and HCPCS code formats", () => {
  assert.equal(assertValidProcedureCode("78815"), "78815");
  assert.equal(assertValidProcedureCode("a9607"), "A9607");
  assert.equal(assertValidProcedureCode("J-2405"), "J2405");
  assert.equal(assertValidProcedureCode("0123T"), "0123T");
});

test("patient claim lookup rejects partial or descriptive procedure searches", () => {
  for (const invalid of ["", "A96", "J24055", "Pluvicto", "9607"] ) {
    assert.throws(
      () => assertValidProcedureCode(invalid),
      (error) => error.statusCode === 400 && error.code === "INVALID_PROCEDURE_CODE",
    );
  }
});
