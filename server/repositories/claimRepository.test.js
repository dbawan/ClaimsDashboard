import test from "node:test";
import assert from "node:assert/strict";
import {
  PATIENT_INVOICE_CPT_MAPPINGS,
  readPatientClaimSources,
  readClaimSources,
  searchPatientsByName,
  searchPatientClaimsByProcedure,
} from "./claimRepository.js";
import { config } from "../config.js";

function fakeSession(handler) {
  return {
    queries: [],
    async select(sql, parameters) {
      this.queries.push({ sql, parameters });
      return handler(sql, parameters);
    },
  };
}

test("patient name suggestions query only the configured EHR patient view", async () => {
  const session = fakeSession((sql) => {
    if (/vw_ODBC_pt_PatientInfo/.test(sql)) {
      return [{
        patientId: "31631",
        fullName: "Doe, Jane",
        firstName: "Jane",
        lastName: "Doe",
        dateOfBirth: "1948-02-10",
        chartNumber: "MRN-42",
        inactiveAt: null,
      }];
    }
    return [];
  });

  const result = await searchPatientsByName(session, "Jane");
  const query = session.queries[0];

  assert.deepEqual(result.patients, [{
    patientId: "31631",
    name: "Jane Doe",
    dateOfBirth: "1948-02-10",
    chartNumber: "MRN-42",
    inactive: false,
  }]);
  assert.equal(result.hasMore, false);
  assert.match(query.sql.trim(), /^SELECT\b/);
  assert.match(query.sql, /Patient_UID IS NOT NULL/);
  assert.match(query.sql, /UPPER\(TRIM\(FullName\)\) LIKE UPPER\(\?\)/);
  assert.match(query.sql, /LIMIT 11/);
  assert.equal(query.parameters[0], config.ehr.licenseKey);
  assert.deepEqual(query.parameters.slice(1, 7), Array(6).fill("Jane%"));
  assert.doesNotMatch(query.sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i);
});

test("selected patient claims are locked to Patient_UID and the configured transaction source", async () => {
  const session = fakeSession((sql) => {
    if (/FROM .*vw_ODBC_pt_PatientInfo/.test(sql)) {
      return [{
        patientId: "31631",
        firstName: "Jane",
        lastName: "Doe",
        dateOfBirth: "1948-02-10",
        chartNumber: "MRN-42",
      }];
    }
    if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: 1 }];
    if (/SELECT CAST\(claim_rows\.ENCOUNTERID AS CHAR\) AS claimId/.test(sql)) {
      return [{
        claimId: "80751",
        serviceDate: "2026-01-03",
        lastActivityDate: "2026-01-20",
        status: "Billed",
        payer: "NJMCR",
        provider: "Provider A",
        location: "Princeton",
        procedureCodes: "78815,A9607",
      }];
    }
    return [];
  });

  const result = await readPatientClaimSources(session, "31631");
  const claimQuery = session.queries.find(
    ({ sql }) => /SELECT CAST\(claim_rows\.ENCOUNTERID AS CHAR\) AS claimId/.test(sql),
  );

  assert.equal(result.patient.name, "Jane Doe");
  assert.deepEqual(result.claimRows, [{
    claimId: "80751",
    serviceDate: "2026-01-03",
    lastActivityDate: "2026-01-20",
    status: "Billed",
    payer: "NJMCR",
    provider: "Provider A",
    location: "Princeton",
    procedureCodes: ["78815", "A9607"],
  }]);
  assert.match(claimQuery.sql, /TRIM\(CAST\(claim_rows\.PATIENTGUID AS CHAR\)\) = \?/);
  assert.match(claimQuery.sql, /UPPER\(TRIM\(claim_rows\.EHR\)\) = UPPER\(\?\)/);
  assert.deepEqual(claimQuery.parameters, ["31631", config.ehr.transactionSource]);
  assert.equal(result.total, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextOffset, null);
  assert.equal(session.queries.length, 3);
  for (const query of session.queries) {
    assert.match(query.sql.trim(), /^SELECT\b/);
    assert.doesNotMatch(query.sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i);
  }
});

test("selected patient claims apply inclusive date-of-service boundaries before the result limit", async () => {
  const session = fakeSession((sql) => {
    if (/FROM .*vw_ODBC_pt_PatientInfo/.test(sql)) {
      return [{ patientId: "31631", firstName: "Jane", lastName: "Doe" }];
    }
    if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: 0 }];
    return [];
  });

  await readPatientClaimSources(session, "31631", {
    startDate: "2026-01-01",
    endDate: "2026-03-31",
  });
  const claimQuery = session.queries.find(
    ({ sql }) => /SELECT CAST\(claim_rows\.ENCOUNTERID AS CHAR\) AS claimId/.test(sql),
  );

  assert.match(claimQuery.sql, /HAVING DATE\(MIN\(claim_rows\.DATEOFSERVICE\)\) >= \?/);
  assert.match(claimQuery.sql, /AND DATE\(MIN\(claim_rows\.DATEOFSERVICE\)\) <= \?/);
  assert.ok(claimQuery.sql.indexOf("HAVING") < claimQuery.sql.indexOf("LIMIT 26"));
  assert.deepEqual(
    claimQuery.parameters,
    ["31631", config.ehr.transactionSource, "2026-01-01", "2026-03-31"],
  );
});

test("financial patient claim lookup loads only the bounded selected claim families", async () => {
  const session = fakeSession((sql) => {
    if (/FROM .*vw_ODBC_pt_PatientInfo/.test(sql)) {
      return [{ patientId: "31631", firstName: "Jane", lastName: "Doe" }];
    }
    if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: 2 }];
    if (/SELECT CAST\(claim_rows\.ENCOUNTERID AS CHAR\) AS claimId/.test(sql)) {
      return [
        { claimId: "80751", serviceDate: "2026-01-03" },
        { claimId: "80999", serviceDate: "2026-02-03" },
      ];
    }
    if (/SELECT \*.*FlattenTransctions2/s.test(sql)) {
      return [{ ENCOUNTERID: "80751", Charges: "100.00" }];
    }
    if (/SELECT \*.*ClaimStatus/s.test(sql)) {
      return [{ PatientControlNumber: "80751A", Payment: "25.00" }];
    }
    if (/SELECT \*.*edi_835/s.test(sql)) {
      return [{ patient_control_number: "80999", paid_amount: "50.00" }];
    }
    return [];
  });

  const result = await readPatientClaimSources(session, "31631", { includeFinancials: true });
  const transactions = session.queries.find(({ sql }) => /SELECT \*.*FlattenTransctions2/s.test(sql));
  const claimStatus = session.queries.find(({ sql }) => /SELECT \*.*ClaimStatus/s.test(sql));
  const edi = session.queries.find(({ sql }) => /SELECT \*.*edi_835/s.test(sql));

  assert.equal(result.transactions.length, 1);
  assert.deepEqual(transactions.parameters, ["80751", "80999"]);
  assert.deepEqual(claimStatus.parameters, ["80751%", "80999%"]);
  assert.deepEqual(edi.parameters, ["80751%", "80999%"]);
  assert.match(claimStatus.sql, /PatientControlNumber LIKE \? OR PatientControlNumber LIKE \?/);
  assert.match(edi.sql, /patient_control_number LIKE \? OR patient_control_number LIKE \?/);
  assert.equal(session.queries.length, 7);
});

test("selected patient claims expose the next lazy-loading offset", async () => {
  const pageRows = Array.from({ length: 26 }, (_, index) => ({
    claimId: String(9000 - index),
    serviceDate: `2026-03-${String(31 - index).padStart(2, "0")}`,
  }));
  const session = fakeSession((sql) => {
    if (/FROM .*vw_ODBC_pt_PatientInfo/.test(sql)) {
      return [{ patientId: "31631", firstName: "Jane", lastName: "Doe" }];
    }
    if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: 46 }];
    if (/SELECT CAST\(claim_rows\.ENCOUNTERID AS CHAR\) AS claimId/.test(sql)) return pageRows;
    return [];
  });

  const result = await readPatientClaimSources(session, "31631", { offset: 0 });
  const claimQuery = session.queries.find(({ sql }) => /LIMIT 26/.test(sql));

  assert.equal(result.total, 46);
  assert.equal(result.claimRows.length, 25);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 25);
  assert.match(claimQuery.sql, /OFFSET 0/);
});

test("selected patient claim pages filter partial procedure codes before counting and limiting", async () => {
  const session = fakeSession((sql) => {
    if (/FROM .*vw_ODBC_pt_PatientInfo/.test(sql)) {
      return [{ patientId: "31631", firstName: "Jane", lastName: "Doe" }];
    }
    if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: 7 }];
    return [];
  });

  const result = await readPatientClaimSources(session, "31631", {
    procedureQuery: "A96",
  });
  const filteredQueries = session.queries.filter(
    ({ sql }) => /procedure_rows\.PROCEDURECODE/.test(sql),
  );

  assert.equal(result.total, 7);
  assert.equal(filteredQueries.length, 2);
  for (const query of filteredQueries) {
    assert.match(query.sql, /procedure_rows\.ENCOUNTERID = claim_rows\.ENCOUNTERID/);
    assert.match(query.sql, /UPPER\(TRIM\(procedure_rows\.PROCEDURECODE\)\) LIKE \?/);
    assert.deepEqual(query.parameters, ["31631", config.ehr.transactionSource, "%A96%"]);
  }
});

test("repository anchors rows on ENCOUNTERID and queries only its letter-suffix ERA family", async () => {
  const session = fakeSession((sql) => {
    if (/SELECT DISTINCT CAST\(ENCOUNTERID/.test(sql)) return [{ encounterId: "78820" }];
    if (/FlattenTransctions2/.test(sql)) return [{ ENCOUNTERID: "78820" }];
    if (/ClaimStatus/.test(sql)) return [{ PatientControlNumber: "78820A" }];
    if (/edi_835/.test(sql)) return [
      { patient_control_number: "78820B" },
      { patient_control_number: "788200" },
    ];
    return [];
  });

  const result = await readClaimSources(session, "78820");

  assert.equal(result.claimId, "78820");
  assert.equal(result.transactions.length, 1);
  assert.deepEqual(result.claimStatus.map((row) => row.PatientControlNumber), ["78820A"]);
  assert.deepEqual(result.edi835.map((row) => row.patient_control_number), ["78820B"]);

  const transactionLoad = session.queries.find(({ sql }) => /SELECT \*.*FlattenTransctions2/s.test(sql));
  assert.match(transactionLoad.sql, /WHERE ENCOUNTERID = \?/);
  const eraLoads = session.queries.filter(({ sql }) => /SELECT \*.*(?:ClaimStatus|edi_835)/s.test(sql));
  assert.equal(eraLoads.length, 2);
  for (const query of eraLoads) {
    assert.deepEqual(query.parameters, ["78820%", "^78820[A-Za-z]*$"]);
  }

  const priorAuthorizationLoad = session.queries.find(
    ({ sql }) => /vw_ODBC_pt_Authorizations/.test(sql),
  );
  assert.ok(priorAuthorizationLoad);
  assert.match(priorAuthorizationLoad.sql.trim(), /^SELECT\b/);
  assert.match(priorAuthorizationLoad.sql, /aa\.AppointmentFID = \?/);
  assert.equal(priorAuthorizationLoad.parameters[1], "78820");
  assert.doesNotMatch(priorAuthorizationLoad.sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i);
});

test("patient claim lookup locks the search to PATIENTGUID and an exact procedure code", async () => {
  const session = fakeSession((sql) => {
    if (/WHERE ENCOUNTERID = \?\s+LIMIT 2/.test(sql)) return [{ encounterId: "80751" }];
    if (/claim\.patient-claim-lookup\.identity/.test(sql)) return [];
    if (/NULLIF\(TRIM\(CAST\(PATIENTGUID/.test(sql)) return [{
      patientGuid: "31631",
      ehr: "AMD",
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1948-02-10",
    }];
    if (/AS matching_claims/.test(sql)) return [{
      claimId: "80999",
      serviceDate: "2026-05-03",
      lastActivityDate: "2026-05-20",
      status: "Billed",
      payer: "NJMCR",
      provider: "Provider A",
      location: "Princeton",
      procedureCodes: "79101,A9607",
    }];
    return [];
  });

  const result = await searchPatientClaimsByProcedure(session, "80751", "a9607");
  const identityQuery = session.queries.find(({ sql }) => /NULLIF\(TRIM\(CAST\(PATIENTGUID/.test(sql));
  const searchQuery = session.queries.find(({ sql }) => /AS matching_claims/.test(sql));

  assert.equal(result.patientName, "Jane Doe");
  assert.equal(result.matchedCode, "A9607");
  assert.equal(result.matchMethod, "patient_guid");
  assert.deepEqual(result.claims, [{
    claimId: "80999",
    serviceDate: "2026-05-03",
    lastActivityDate: "2026-05-20",
    status: "Billed",
    payer: "NJMCR",
    provider: "Provider A",
    location: "Princeton",
    matchedCode: "A9607",
    procedureCodes: ["79101", "A9607"],
  }]);
  assert.deepEqual(identityQuery.parameters, ["80751"]);
  assert.match(searchQuery.sql, /TRIM\(CAST\(PATIENTGUID AS CHAR\)\) = \?/);
  assert.match(searchQuery.sql, /UPPER\(TRIM\(EHR\)\) = UPPER\(\?\)/);
  assert.match(searchQuery.sql, /UPPER\(TRIM\(PROCEDURECODE\)\) = \?/);
  assert.deepEqual(searchQuery.parameters, ["31631", "AMD", "A9607"]);
  assert.match(searchQuery.sql.trim(), /^SELECT\b/);
  assert.doesNotMatch(searchQuery.sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i);
});

test("patient claim lookup uses exact name and DOB only when PATIENTGUID is unavailable", async () => {
  const session = fakeSession((sql) => {
    if (/WHERE ENCOUNTERID = \?\s+LIMIT 2/.test(sql)) return [{ encounterId: "80751" }];
    if (/NULLIF\(TRIM\(CAST\(PATIENTGUID/.test(sql)) return [{
      patientGuid: null,
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1948-02-10",
    }];
    if (/AS matching_claims/.test(sql)) return [];
    return [];
  });

  const result = await searchPatientClaimsByProcedure(session, "80751", "78815");
  const searchQuery = session.queries.find(({ sql }) => /AS matching_claims/.test(sql));

  assert.equal(result.matchMethod, "name_and_date_of_birth");
  assert.match(searchQuery.sql, /UPPER\(TRIM\(FIRSTNAME\)\) = UPPER\(\?\)/);
  assert.match(searchQuery.sql, /UPPER\(TRIM\(LASTNAME\)\) = UPPER\(\?\)/);
  assert.match(searchQuery.sql, /DATE\(DOB\) = \?/);
  assert.deepEqual(searchQuery.parameters, ["Jane", "Doe", "1948-02-10", "78815"]);
});

test("a suffixed ERA reference resolves back to its canonical ENCOUNTERID", async () => {
  const session = fakeSession((sql, parameters) => {
    if (/SELECT DISTINCT CAST\(ENCOUNTERID/.test(sql)) {
      return parameters.includes("78820") ? [{ encounterId: "78820" }] : [];
    }
    if (/SELECT DISTINCT PatientControlNumber/.test(sql)) return [];
    if (/SELECT DISTINCT patient_control_number/.test(sql)) {
      return [{ patient_control_number: "78820C" }];
    }
    if (/FlattenTransctions2/.test(sql)) return [{ ENCOUNTERID: "78820" }];
    return [];
  });

  const result = await readClaimSources(session, "78820C");
  assert.equal(result.claimId, "78820");
});

test("a derived rebill suffix resolves to its base ENCOUNTERID without an ERA row", async () => {
  const session = fakeSession((sql, parameters) => {
    if (/SELECT DISTINCT CAST\(ENCOUNTERID/.test(sql)) {
      return parameters.includes("80118") ? [{ encounterId: "80118" }] : [];
    }
    if (/SELECT DISTINCT (?:PatientControlNumber|patient_control_number)/.test(sql)) return [];
    if (/SELECT \*.*FlattenTransctions2/s.test(sql)) return [{ ENCOUNTERID: "80118" }];
    return [];
  });

  const result = await readClaimSources(session, "80118A");
  assert.equal(result.claimId, "80118");
});

test("an exact ENCOUNTERID wins over matching internal claim aliases", async () => {
  const session = fakeSession((sql) => {
    if (/WHERE ENCOUNTERID = \?\s+LIMIT 2/.test(sql)) {
      return [{ encounterId: "1003" }];
    }
    if (/OR Claim835ID = \?/.test(sql)) {
      return [{ encounterId: "1003" }, { encounterId: "9999" }];
    }
    if (/SELECT \*.*FlattenTransctions2/s.test(sql)) return [{ ENCOUNTERID: "1003" }];
    return [];
  });

  const result = await readClaimSources(session, "1003");

  assert.equal(result.claimId, "1003");
  assert.equal(session.queries.some(({ sql }) => /OR Claim835ID = \?/.test(sql)), false);
});

test("patient invoices require an exact patient name and date-of-service SELECT", async () => {
  const session = fakeSession((sql) => {
    if (/SELECT DISTINCT CAST\(ENCOUNTERID/.test(sql)) return [{ encounterId: "80751" }];
    if (/SELECT \*.*FlattenTransctions2/s.test(sql)) {
      return [{
        ENCOUNTERID: "80751",
        FIRSTNAME: "Jane",
        LASTNAME: "Doe",
        DATEOFSERVICE: "2026-01-03",
      }];
    }
    if (/patient_invoices/.test(sql)) {
      return [{
        id: 41,
        InvoiceNumber: "INV-41",
        pt_FirstName: "Jane",
        pt_LastName: "Doe",
        DateOfService: "2026-01-03",
      }];
    }
    return [];
  });

  const result = await readClaimSources(session, "80751");
  const invoiceQuery = session.queries.find(({ sql }) => /patient_invoices/.test(sql));

  assert.equal(result.patientInvoices.length, 1);
  assert.equal(result.patientInvoiceLookup.status, "ready");
  assert.equal(result.patientInvoiceLookup.matchMethod, "patient_and_service_date");
  assert.ok(invoiceQuery);
  assert.match(invoiceQuery.sql.trim(), /^SELECT\b/);
  assert.match(invoiceQuery.sql, /DateOfService IN \(\?\)/);
  assert.match(invoiceQuery.sql, /UPPER\(TRIM\(pt_FirstName\)\) = UPPER\(\?\)/);
  assert.match(invoiceQuery.sql, /UPPER\(TRIM\(pt_LastName\)\) = UPPER\(\?\)/);
  assert.deepEqual(invoiceQuery.parameters, ["2026-01-03", "Jane", "Doe"]);
  assert.doesNotMatch(invoiceQuery.sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i);
});

test("invoice fallback mappings include the five configured products and CPT codes", () => {
  assert.deepEqual(
    PATIENT_INVOICE_CPT_MAPPINGS.map(({ product, cpt }) => ({ product, cpt })),
    [
      { product: "Pluvicto", cpt: "A9607" },
      { product: "Lutathera", cpt: "A9513" },
      { product: "Xofigo", cpt: "A9606" },
      { product: "Illuccix", cpt: "A9596" },
      { product: "I-313 Therapy doses", cpt: "A9517" },
    ],
  );
});

test("patient invoice fallback requires both service date and a mapped CPT product", async () => {
  const pluvictoLine = {
    id: 51,
    vendor: "CARDINAL_HEALTH",
    InvoiceNumber: "INV-PLUVICTO",
    DateOfService: "2026-01-03",
    ProductName: "Pluvicto patient dose",
    ExtPrice: "45000.00",
    LineIndex: 1,
  };
  const session = fakeSession((sql) => {
    if (/SELECT DISTINCT CAST\(ENCOUNTERID/.test(sql)) return [{ encounterId: "80751" }];
    if (/SELECT \*.*FlattenTransctions2/s.test(sql)) {
      return [{
        ENCOUNTERID: "80751",
        FIRSTNAME: "Jane",
        LASTNAME: "Doe",
        DATEOFSERVICE: "2026-01-03",
        PROCEDURECODE: "A9607",
      }];
    }
    if (/patient_invoices/.test(sql) && /TRIM\(pt_FirstName\)/.test(sql)) return [];
    if (/patient_invoices/.test(sql) && /InvoiceNumber IN/.test(sql)) {
      return [pluvictoLine, {
        ...pluvictoLine,
        id: 52,
        ProductName: "Delivery fee",
        ExtPrice: "25.00",
        LineIndex: 2,
      }];
    }
    if (/patient_invoices/.test(sql) && /CONCAT_WS/.test(sql)) return [pluvictoLine];
    return [];
  });

  const result = await readClaimSources(session, "80751");
  const fallbackQueries = session.queries.filter(({ sql }) => /patient_invoices/.test(sql));
  const candidateQuery = fallbackQueries.find(({ sql }) => /CONCAT_WS/.test(sql));

  assert.equal(result.patientInvoices.length, 2);
  assert.equal(result.patientInvoiceLookup.status, "ready_cpt_fallback");
  assert.equal(result.patientInvoiceLookup.matchMethod, "service_date_and_cpt");
  assert.deepEqual(result.patientInvoiceLookup.matchedCpts, ["A9607"]);
  assert.deepEqual(result.patientInvoiceLookup.matchedProducts, ["Pluvicto"]);
  assert.ok(candidateQuery);
  assert.deepEqual(candidateQuery.parameters, ["2026-01-03", "%PLUVICTO%"]);
  for (const query of fallbackQueries) {
    assert.match(query.sql.trim(), /^SELECT\b/);
    assert.doesNotMatch(query.sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i);
  }
});

test("mapped-CPT fallback flags a shared invoice pool across same-date claims", async () => {
  const productRows = [1, 2, 3, 4].map((number) => ({
    id: 70 + number,
    vendor: "CARDINAL_HEALTH",
    InvoiceNumber: `INV-PLUVICTO-${number}`,
    DateOfService: "2026-02-10",
    ProductName: "Pluvicto patient dose",
    ExtPrice: "5000.00",
    LineIndex: 1,
  }));
  const session = fakeSession((sql) => {
    if (/SELECT DISTINCT CAST\(ENCOUNTERID/.test(sql)) return [{ encounterId: "81001" }];
    if (/GROUP BY DATE\(DATEOFSERVICE\), ENCOUNTERID/.test(sql)) {
      return ["81001", "81002", "81003", "81004"].map((claimId) => ({
        serviceDate: "2026-02-10",
        claimId,
      }));
    }
    if (/SELECT \*.*FlattenTransctions2/s.test(sql)) {
      return [{
        ENCOUNTERID: "81001",
        DATEOFSERVICE: "2026-02-10",
        PROCEDURECODE: "A9607",
      }];
    }
    if (/patient_invoices/.test(sql) && /InvoiceNumber IN/.test(sql)) return productRows;
    if (/patient_invoices/.test(sql) && /CONCAT_WS/.test(sql)) return productRows;
    return [];
  });

  const result = await readClaimSources(session, "81001");
  const candidateQuery = session.queries.find(({ sql }) => (
    /GROUP BY DATE\(DATEOFSERVICE\), ENCOUNTERID/.test(sql)
  ));

  assert.equal(result.patientInvoiceLookup.status, "ambiguous_cpt_fallback");
  assert.equal(result.patientInvoiceLookup.isAmbiguous, true);
  assert.deepEqual(result.patientInvoiceLookup.candidateClaimIds, ["81001", "81002", "81003", "81004"]);
  assert.ok(candidateQuery);
  assert.match(candidateQuery.sql, /UPPER\(TRIM\(PROCEDURECODE\)\) IN \(\?\)/);
  assert.deepEqual(candidateQuery.parameters, ["2026-02-10", "2026-02-10", "A9607"]);
});

test("date-only invoice fallback returns rows and flags claims that share the service date", async () => {
  const invoiceLine = {
    id: 61,
    InvoiceNumber: "INV-DATE-ONLY",
    DateOfService: "2026-01-03",
    Description: "Delivery and handling",
    ExtPrice: "25.00",
  };
  const session = fakeSession((sql) => {
    if (/SELECT DISTINCT CAST\(ENCOUNTERID/.test(sql)) return [{ encounterId: "80751" }];
    if (/GROUP BY DATE\(DATEOFSERVICE\), ENCOUNTERID/.test(sql)) {
      return [
        { serviceDate: "2026-01-03", claimId: "80751" },
        { serviceDate: "2026-01-03", claimId: "80999" },
      ];
    }
    if (/SELECT \*.*FlattenTransctions2/s.test(sql)) {
      return [{
        ENCOUNTERID: "80751",
        FIRSTNAME: "",
        LASTNAME: "",
        DATEOFSERVICE: "2026-01-03",
        PROCEDURECODE: "78832",
      }];
    }
    if (/patient_invoices/.test(sql)) return [invoiceLine];
    return [];
  });

  const result = await readClaimSources(session, "80751");
  const dateOnlyQuery = session.queries.find(({ sql }) => (
    /patient_invoices/.test(sql)
    && /WHERE DateOfService IN \(\?\)/.test(sql)
    && !/UPPER\(TRIM|CONCAT_WS|InvoiceNumber IN/.test(sql)
  ));

  assert.equal(result.patientInvoices.length, 1);
  assert.equal(result.patientInvoiceLookup.status, "ambiguous_date_fallback");
  assert.equal(result.patientInvoiceLookup.matchMethod, "service_date_only");
  assert.equal(result.patientInvoiceLookup.isAmbiguous, true);
  assert.deepEqual(result.patientInvoiceLookup.candidateClaimIds, ["80751", "80999"]);
  assert.deepEqual(result.patientInvoiceLookup.candidateClaimsByServiceDate, [{
    serviceDate: "2026-01-03",
    candidateClaimIds: ["80751", "80999"],
  }]);
  assert.ok(dateOnlyQuery);
  assert.deepEqual(dateOnlyQuery.parameters, ["2026-01-03"]);
  assert.match(result.patientInvoiceLookup.message, /Review required/);
});
