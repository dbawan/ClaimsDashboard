import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimLifecycle,
  MYSQL_CLAIM_CACHE_TTL_MS,
} from "./claimLifecycleService.js";
import { buildClaimVitals } from "./claimVitalsService.js";

test("claim MySQL lifecycle results remain cached for 24 hours", () => {
  assert.equal(MYSQL_CLAIM_CACHE_TTL_MS, 24 * 60 * 60 * 1_000);
});

test("exact patient invoice rows are grouped into a read-only claim invoice feed", () => {
  const result = buildClaimLifecycle({
    claimId: "80751",
    transactions: [transaction({
      CLAIMTRANSACTIONID: "100",
      POSTINGDATE: "2026-01-03",
      CLAIMTRANSACTIONTYPENAME: "Claim created",
    })],
    claimStatus: [],
    edi835: [],
    priorAuthorizations: [],
    patientInvoiceLookup: {
      status: "ready",
      matchMethod: "patient_and_service_date",
      matchedCpts: [],
      matchedProducts: [],
      message: "Exact patient and service-date match.",
    },
    patientInvoices: [
      {
        id: 11,
        vendor: "CARDINAL_HEALTH_CREDIT",
        InvoiceNumber: "8004120984",
        pt_FirstName: "Jane",
        pt_LastName: "Doe",
        DateOfService: "2026-01-03",
        RX: "833446",
        ProductName: "F-18 FDG UD",
        ProcedureName: "082-Tumor Imaging",
        Amount: "12 mCi",
        Price: "159.65",
        ExtPrice: "159.65",
        Tax: "0.00",
        RedactedInvoicePDF: "https://example.test/redacted/invoice.pdf",
        LineIndex: 1,
      },
      {
        id: 12,
        vendor: "CARDINAL_HEALTH_CREDIT",
        InvoiceNumber: "8004120984",
        pt_FirstName: "Jane",
        pt_LastName: "Doe",
        DateOfService: "2026-01-03",
        ProductName: "Delivery",
        ExtPrice: "10.00",
        Tax: "1.00",
        LineIndex: 2,
      },
    ],
  });

  assert.equal(result.patientInvoices.length, 1);
  assert.equal(result.patientInvoices[0].invoiceNumber, "8004120984");
  assert.equal(result.patientInvoices[0].total, 170.65);
  assert.equal(result.patientInvoices[0].lines.length, 2);
  assert.equal(result.patientInvoices[0].lines[0].amount, "12 mCi");
  assert.equal(result.patientInvoices[0].redactedPdfUrl, "https://example.test/redacted/invoice.pdf");
  assert.deepEqual(result.invoiceIntegration, {
    status: "ready",
    rowCount: 2,
    invoiceCount: 1,
    matchMethod: "patient_and_service_date",
    matchedCpts: [],
    matchedProducts: [],
    isAmbiguous: false,
    candidateClaimIds: [],
    candidateClaimsByServiceDate: [],
    allocations: [],
    matchRule: "Exact patient first name + exact patient last name + date of service",
    message: "Exact patient and service-date match.",
  });
  assert.ok(result.provenance.sources.includes("Patient invoices"));
});

test("invoice integration discloses a service-date and mapped-CPT fallback", () => {
  const result = buildClaimLifecycle({
    claimId: "80751",
    transactions: [transaction({
      PROCEDURECODE: "A9607",
      CLAIMTRANSACTIONID: "100",
      POSTINGDATE: "2026-01-03",
      CLAIMTRANSACTIONTYPENAME: "Claim created",
    })],
    claimStatus: [],
    edi835: [],
    priorAuthorizations: [],
    patientInvoiceLookup: {
      status: "ready_cpt_fallback",
      matchMethod: "service_date_and_cpt",
      matchedCpts: ["A9607"],
      matchedProducts: ["Pluvicto"],
      message: "Matched by service date and mapped CPT A9607.",
    },
    patientInvoices: [{
      id: 51,
      InvoiceNumber: "INV-PLUVICTO",
      DateOfService: "2026-01-03",
      ProductName: "Pluvicto patient dose",
      ExtPrice: "45000.00",
    }],
  });

  assert.equal(result.invoiceIntegration.status, "ready_cpt_fallback");
  assert.equal(result.invoiceIntegration.matchMethod, "service_date_and_cpt");
  assert.deepEqual(result.invoiceIntegration.matchedCpts, ["A9607"]);
  assert.deepEqual(result.invoiceIntegration.matchedProducts, ["Pluvicto"]);
  assert.equal(result.invoiceIntegration.matchRule, "Date of service + mapped claim CPT (A9607)");
});

test("invoice integration exposes ambiguous date-only fallback candidates", () => {
  const result = buildClaimLifecycle({
    claimId: "80751",
    transactions: [transaction({
      CLAIMTRANSACTIONID: "100",
      POSTINGDATE: "2026-01-03",
      CLAIMTRANSACTIONTYPENAME: "Claim created",
    })],
    claimStatus: [],
    edi835: [],
    priorAuthorizations: [],
    patientInvoiceLookup: {
      status: "ambiguous_date_fallback",
      matchMethod: "service_date_only",
      matchedCpts: [],
      matchedProducts: [],
      isAmbiguous: true,
      candidateClaimIds: ["80751", "80999"],
      candidateClaimsByServiceDate: [{
        serviceDate: "2026-01-03",
        candidateClaimIds: ["80751", "80999"],
      }],
      message: "Matched by date only; review required.",
    },
    patientInvoices: [{
      id: 61,
      InvoiceNumber: "INV-DATE-ONLY",
      DateOfService: "2026-01-03",
      Description: "Delivery and handling",
      ExtPrice: "25.00",
    }],
  });

  assert.equal(result.invoiceIntegration.status, "ambiguous_date_fallback");
  assert.equal(result.invoiceIntegration.matchMethod, "service_date_only");
  assert.equal(result.invoiceIntegration.isAmbiguous, true);
  assert.deepEqual(result.invoiceIntegration.candidateClaimIds, ["80751", "80999"]);
  assert.equal(result.invoiceIntegration.matchRule, "Date of service only · ambiguous claim match");
  assert.equal(result.invoiceIntegration.allocations[0].status, "unresolved_pool");
  assert.equal(result.invoiceIntegration.allocations[0].estimatedAmount, null);
});

test("equal ambiguous radiopharmaceutical pools allocate one estimated invoice per claim", () => {
  const candidateClaimIds = ["81001", "81002", "81003", "81004"];
  const result = buildClaimLifecycle({
    claimId: "81001",
    transactions: [transaction({
      ENCOUNTERID: "81001",
      PROCEDURECODE: "A9607",
      CLAIMTRANSACTIONID: "100",
      POSTINGDATE: "2026-02-10",
      DATEOFSERVICE: "2026-02-10",
      CLAIMTRANSACTIONTYPENAME: "Claim created",
    })],
    claimStatus: [],
    edi835: [],
    priorAuthorizations: [],
    patientInvoiceLookup: {
      status: "ambiguous_cpt_fallback",
      matchMethod: "service_date_and_cpt",
      matchedCpts: ["A9607"],
      matchedProducts: ["Pluvicto"],
      isAmbiguous: true,
      candidateClaimIds,
      candidateClaimsByServiceDate: [{ serviceDate: "2026-02-10", candidateClaimIds }],
      message: "Multiple claims share the mapped CPT invoice pool.",
    },
    patientInvoices: candidateClaimIds.map((_, index) => ({
      id: 100 + index,
      vendor: "CARDINAL_HEALTH",
      InvoiceNumber: `INV-PLUVICTO-${index + 1}`,
      DateOfService: "2026-02-10",
      ProductName: "Pluvicto patient dose",
      ExtPrice: "5000.00",
    })),
  });

  assert.equal(result.patientInvoices.length, 4);
  assert.equal(result.invoiceIntegration.allocations.length, 1);
  assert.equal(result.invoiceIntegration.candidateInvoiceCount, 4);
  assert.equal(result.invoiceIntegration.displayInvoiceCount, 1);
  assert.equal(result.invoiceIntegration.estimatedInvoiceCount, 1);
  assert.deepEqual(result.invoiceIntegration.allocations[0], {
    id: "2026-02-10|PLUVICTO|81001,81002,81003,81004",
    status: "estimated_equal_pool",
    serviceDate: "2026-02-10",
    product: "Pluvicto",
    vendor: "CARDINAL_HEALTH",
    invoiceCount: 4,
    claimCount: 4,
    shareNumerator: 1,
    shareDenominator: 4,
    poolTotal: 20000,
    estimatedAmount: 5000,
    candidateClaimIds,
    candidateInvoiceNumbers: [
      "INV-PLUVICTO-1",
      "INV-PLUVICTO-2",
      "INV-PLUVICTO-3",
      "INV-PLUVICTO-4",
    ],
    reason: "4 indistinguishable Pluvicto invoices match 4 claims. The exact invoice-to-claim assignment is unknown.",
  });
});

test("unequal ambiguous invoice pools remain unresolved and unallocated", () => {
  const candidateClaimIds = ["81001", "81002", "81003", "81004"];
  const result = buildClaimLifecycle({
    claimId: "81001",
    transactions: [transaction({ DATEOFSERVICE: "2026-02-10" })],
    claimStatus: [],
    edi835: [],
    priorAuthorizations: [],
    patientInvoiceLookup: {
      status: "ambiguous_cpt_fallback",
      matchMethod: "service_date_and_cpt",
      matchedCpts: ["A9607"],
      matchedProducts: ["Pluvicto"],
      isAmbiguous: true,
      candidateClaimIds,
      candidateClaimsByServiceDate: [{ serviceDate: "2026-02-10", candidateClaimIds }],
      message: "Multiple claims share the mapped CPT invoice pool.",
    },
    patientInvoices: [1, 2, 3].map((number) => ({
      id: number,
      vendor: "CARDINAL_HEALTH",
      InvoiceNumber: `INV-${number}`,
      DateOfService: "2026-02-10",
      ProductName: "Pluvicto patient dose",
      ExtPrice: "5000.00",
    })),
  });

  assert.equal(result.invoiceIntegration.allocations[0].status, "unresolved_pool");
  assert.equal(result.invoiceIntegration.displayInvoiceCount, 1);
  assert.equal(result.invoiceIntegration.estimatedInvoiceCount, 0);
  assert.equal(result.invoiceIntegration.allocations[0].estimatedAmount, null);
  assert.equal(result.invoiceIntegration.allocations[0].shareDenominator, null);
  assert.match(result.invoiceIntegration.allocations[0].reason, /3 candidate invoices match 4 claims/);
});

function transaction(overrides) {
  return {
    ENCOUNTERID: "80751",
    Claim835ID: "80751Z70886",
    FIRSTNAME: "Jane",
    LASTNAME: "Doe",
    Provider: "United Theranostics",
    DATEOFSERVICE: "2026-01-03",
    PROCEDURECODE: "78802",
    MOD1: "59",
    Charges: "500.00",
    Balance: "350.00",
    ...overrides,
  };
}

function claimStatus(overrides = {}) {
  return {
    ClaimStatusId: 1,
    PatientControlNumber: "80751A",
    ClaimNumber: "PAYER-1",
    CheckEftTraceNumber: "TRACE-1",
    CheckEftDate: "2026-01-20",
    DateOfServiceStart: "2026-01-03",
    LineControlNumber: "500",
    AdjudProcedure: "78802",
    AdjudModifier: "59",
    AdjudUnits: "1",
    ChargeAmount: "500.00",
    Payment: "100.00",
    AdjustmentCodes: "45",
    PayerName: "Health Plan",
    ...overrides,
  };
}

function edi(overrides = {}) {
  return {
    id: 9,
    patient_control_number: "80751A",
    payer_claim_control: "PAYER-1",
    trace_number: "TRACE-1",
    payment_date: "20260120",
    service_date: "20260103",
    reference_id: "500",
    service_code: "78802",
    modifiers: "59",
    units: "1",
    charge_amount: "500.00",
    paid_amount: "100.00",
    service_adjustments: '[{"group":"CO","reason":"45","amount":"400.00"}]',
    payer_name: "Health Plan",
    ...overrides,
  };
}

test("ERA receipts and posted payments remain separate even when they match", () => {
  const sources = {
    claimId: "80751",
    transactions: [
      transaction({ CLAIMTRANSACTIONID: "100", POSTINGDATE: "2026-01-03", CLAIMTRANSACTIONTYPENAME: "Claim Created" }),
      transaction({ CLAIMTRANSACTIONID: "101", POSTINGDATE: "2026-01-04", CLAIMTRANSACTIONTYPENAME: "Billed" }),
      transaction({
        CLAIMTRANSACTIONID: "102",
        PAYMENTCLAIMID: "500",
        POSTINGDATE: "2026-01-25",
        CLAIMTRANSACTIONTYPENAME: "Applied payment",
        Amount: "100.00",
      }),
      transaction({
        CLAIMTRANSACTIONID: "103",
        PAYMENTCLAIMID: "501",
        POSTINGDATE: "2026-01-26",
        CLAIMTRANSACTIONTYPENAME: "Applied payment",
        Amount: "50.00",
        DATEOFSERVICE: "2026-01-04",
        PROCEDURECODE: "99215",
      }),
    ],
    claimStatus: [claimStatus(), claimStatus({ ClaimStatusId: 2 })],
    edi835: [edi()],
  };

  const result = buildClaimLifecycle(sources);

  assert.equal(result.summary.eraPaid, 100);
  assert.equal(result.summary.postedPaid, 150);
  assert.equal(result.summary.receivedPaid, 100);
  assert.equal(result.summary.totalPaid, 150);
  assert.equal(result.provenance.eraMatchedPostings, 0);
  assert.equal(result.provenance.duplicatesRemoved, 2);
  assert.equal(result.claim.createdAt, "2026-01-03");
  assert.deepEqual(result.claim.submissionReferences, ["80751A"]);
  assert.equal(result.eras.length, 1);
  assert.deepEqual(result.eras[0].observedSources, ["ClaimStatus ERA", "EDI 835 ERA"]);
  assert.equal(result.eras[0].paid, 100);
  assert.equal(result.eras[0].lineCount, 1);
  const receipt = result.timeline.find((event) => event.paymentAuthority === "era");
  assert.equal(receipt.countedPayment, 0);
  assert.equal(receipt.receivedPayment, 100);
  const postings = result.timeline.filter((event) => event.paymentAuthority === "posted");
  assert.deepEqual(postings.map((event) => event.countedPayment), [100, 50]);
  assert.deepEqual(postings[1].cptPayments, [{ procedure: "99215", paid: 50 }]);
  assert.deepEqual(postings[1].procedures, ["99215"]);
  assert.deepEqual(postings[1].cptActivity, [{
    procedure: "99215",
    lineCount: 1,
    posted: 50,
    received: 0,
    billed: 500,
    allowed: null,
    patientResponsibility: null,
    adjusted: null,
    balance: 350,
    adjustments: [],
  }]);
  assert.ok(result.cptFinancials.some((cpt) => cpt.procedure === "99215" && cpt.charged === 500));
});

test("claim vital sources retain original charges, latest Flatten touch, and submission attempts", () => {
  const result = buildClaimLifecycle({
    claimId: "80751",
    transactions: [
      transaction({
        CLAIMTRANSACTIONID: "100",
        POSTINGDATE: "2026-01-03",
        CLAIMTRANSACTIONTYPENAME: "Claim created",
        PROCEDURECODE: "78802",
        Charges: "600.00",
      }),
      transaction({
        CLAIMTRANSACTIONID: "101",
        POSTINGDATE: "2026-01-03",
        CLAIMTRANSACTIONTYPENAME: "Claim created",
        PROCEDURECODE: "A9607",
        Charges: "400.00",
      }),
      transaction({
        CLAIMTRANSACTIONID: "102",
        POSTINGDATE: "2026-01-20",
        CLAIMTRANSACTIONTYPENAME: "Re-billed claim",
        PROCEDURECODE: "78802",
        Charges: "1,200.00",
      }),
    ],
    claimStatus: [
      claimStatus({ ClaimStatusId: 1, PatientControlNumber: "80751A" }),
      claimStatus({ ClaimStatusId: 2, PatientControlNumber: "80751B", CheckEftTraceNumber: "TRACE-2" }),
    ],
    edi835: [],
  });

  assert.deepEqual(result.claimVitalSources, {
    lastTransactionDate: "2026-01-20",
    latestAppealRebillDate: "2026-01-20",
    originalCharge: 1_000,
    attempts: 2,
    payerNames: ["Health Plan"],
  });
  assert.equal(result.summary.latestCharge, 1_200);
});

test("filing reset sources use actual dated appeal/rebill actions, not routine billing or ERA observations", () => {
  const sources = {
    claimId: "80751",
    transactions: [
      transaction({ CLAIMTRANSACTIONID: "1", POSTINGDATE: "2026-01-03", CLAIMTRANSACTIONTYPENAME: "Claim created" }),
      transaction({ CLAIMTRANSACTIONID: "2", POSTINGDATE: "2026-01-10", CLAIMTRANSACTIONTYPENAME: "Re-billed" }),
      transaction({ CLAIMTRANSACTIONID: "3", POSTINGDATE: "2026-01-15", CLAIMTRANSACTIONTYPENAME: "Appeal submitted" }),
      transaction({ CLAIMTRANSACTIONID: "4", POSTINGDATE: "2026-01-17", CLAIMTRANSACTIONTYPENAME: "Appeal follow-up" }),
      transaction({ CLAIMTRANSACTIONID: "5", POSTINGDATE: "2026-01-18", CLAIMTRANSACTIONTYPENAME: "Appeal planned" }),
      transaction({ CLAIMTRANSACTIONID: "6", POSTINGDATE: "2026-01-19", CLAIMTRANSACTIONTYPENAME: "Billed" }),
      transaction({ CLAIMTRANSACTIONID: "7", POSTINGDATE: null, CLAIMTRANSACTIONTYPENAME: "Re-billed claim" }),
    ],
    claimStatus: [claimStatus({ PatientControlNumber: "80751B", CheckEftDate: "2026-01-25" })],
    edi835: [],
  };
  const result = buildClaimLifecycle(sources);
  assert.equal(result.claimVitalSources.latestAppealRebillDate, "2026-01-15");
  const vitals = buildClaimVitals(result, { referenceDate: "2026-01-20" });
  assert.equal(vitals.filingStartDate, "2026-01-15");
  assert.equal(vitals.filingLimitDate, "2026-04-15");
  assert.equal(vitals.filingLimitDaysLeft, 85);

  const noAction = buildClaimLifecycle({ ...sources, transactions: sources.transactions.slice(0, 1) });
  assert.equal(noAction.claimVitalSources.latestAppealRebillDate, null);
  assert.equal(buildClaimVitals(noAction).filingStartReason, "service_date");
});

test("AR counts charge/write-off snapshots once per line and payments once across posting and ERA", () => {
  const result = buildClaimLifecycle({
    claimId: "80751",
    transactions: [
      transaction({ CLAIMTRANSACTIONID: "1", POSTINGDATE: "2026-01-03", CLAIMTRANSACTIONTYPENAME: "Claim created", Adjustments: 50 }),
      transaction({ CLAIMTRANSACTIONID: "2", POSTINGDATE: "2026-01-04", CLAIMTRANSACTIONTYPENAME: "Billed", Adjustments: 50 }),
      transaction({ CLAIMTRANSACTIONID: "3", POSTINGDATE: "2026-01-20", CLAIMTRANSACTIONTYPENAME: "Applied payment", Amount: 100, Adjustments: 50 }),
      transaction({ CLAIMTRANSACTIONID: "3", POSTINGDATE: "2026-01-20", CLAIMTRANSACTIONTYPENAME: "Applied payment", Amount: 100, Adjustments: 50 }),
      transaction({ CLAIMTRANSACTIONID: "4", POSTINGDATE: "2026-01-03", CLAIMTRANSACTIONTYPENAME: "Claim created", PROCEDURECODE: "99215", Charges: 200, Adjustments: 25 }),
    ],
    claimStatus: [claimStatus()],
    edi835: [edi()],
  });
  assert.equal(result.summary.charges, 700);
  assert.equal(result.summary.adjustments, 75);
  assert.equal(result.summary.totalPaid, 100);
  assert.equal(buildClaimVitals(result).outstandingArAmount, 525);
});

test("negative ERA amounts reverse received payments without changing posted totals", () => {
  const result = buildClaimLifecycle({
    claimId: "80751",
    transactions: [
      transaction({ CLAIMTRANSACTIONID: "100", POSTINGDATE: "2026-01-03", CLAIMTRANSACTIONTYPENAME: "Claim Created" }),
    ],
    claimStatus: [claimStatus()],
    edi835: [
      edi({
        id: 10,
        trace_number: "TRACE-2",
        reference_id: "600",
        payment_date: "20260124",
        paid_amount: "-25.00",
        service_adjustments: "[]",
      }),
    ],
  });

  assert.equal(result.summary.eraPaid, 75);
  assert.equal(result.summary.receivedPaid, 75);
  assert.equal(result.summary.totalPaid, 0);
  assert.ok(result.timeline.some((event) => event.title === "Payment reversed" && event.amount === -25));
});

test("claim summary reports days until aggregated payments reach half the latest charge", () => {
  const result = buildClaimLifecycle({
    claimId: "80751",
    transactions: [transaction({
      CLAIMTRANSACTIONID: "1",
      POSTINGDATE: "2026-09-01",
      DATEOFSERVICE: "2026-09-01",
      CLAIMTRANSACTIONTYPENAME: "Claim created",
      Charges: "1000.00",
    }),
      transaction({ CLAIMTRANSACTIONID: "2", CLAIMTRANSACTIONTYPENAME: "Applied payment", POSTINGDATE: "2026-09-06", Amount: 250, Charges: 1000 }),
      transaction({ CLAIMTRANSACTIONID: "3", CLAIMTRANSACTIONTYPENAME: "Applied payment", POSTINGDATE: "2026-09-12", Amount: 250, Charges: 1000 }),
    ],
    claimStatus: [],
    edi835: [
      edi({ id: 1, trace_number: "TRACE-1", reference_id: "1", payment_date: "20260904", service_date: "20260901", charge_amount: "1000.00", paid_amount: "250.00" }),
      edi({ id: 2, trace_number: "TRACE-2", reference_id: "2", payment_date: "20260910", service_date: "20260901", charge_amount: "1000.00", paid_amount: "250.00" }),
    ],
  });

  assert.equal(result.summary.paidThresholdPercent, 50);
  assert.equal(result.summary.paidThresholdAmount, 500);
  assert.equal(result.summary.paidThresholdDate, "2026-09-12");
  assert.equal(result.summary.daysToPaid, 11);
});

test("letter suffixes stay in one ENCOUNTERID claim while events remain chronological", () => {
  const result = buildClaimLifecycle({
    claimId: "78820",
    transactions: [
      transaction({
        ENCOUNTERID: "78820",
        CLAIMTRANSACTIONID: "1",
        POSTINGDATE: "2026-01-01",
        CLAIMTRANSACTIONTYPENAME: "Claim created",
      }),
    ],
    claimStatus: [],
    edi835: [
      edi({ id: 1, patient_control_number: "78820D", claim_received_date: "20260720", payment_date: "20260720", paid_amount: "611.55" }),
      edi({ id: 2, patient_control_number: "78820A", claim_received_date: "20260303", payment_date: "20260303", paid_amount: "0" }),
      edi({ id: 3, patient_control_number: "78820C", claim_received_date: "20260720", payment_date: "20260720", paid_amount: "2318.93" }),
      edi({ id: 4, patient_control_number: "78820B", claim_received_date: "20260806", payment_date: "20260806", paid_amount: "0" }),
    ],
  });

  assert.deepEqual(result.claim.submissionReferences, ["78820A", "78820B", "78820C", "78820D"]);
  assert.equal(result.summary.eraPaid, 2930.48);
  const observedChronology = result.timeline
    .filter((event) => event.submissionReference)
    .map((event) => event.submissionReference);
  assert.deepEqual(observedChronology, ["78820A", "78820C", "78820D", "78820B"]);
});

test("patient, DOS, and CPT changes are informational and numeric lookalikes are excluded", () => {
  const result = buildClaimLifecycle({
    claimId: "75258",
    transactions: [
      transaction({
        ENCOUNTERID: "75258",
        FIRSTNAME: "Donna",
        LASTNAME: "Reed",
        DATEOFSERVICE: "2025-08-07",
        PROCEDURECODE: "78802",
        CLAIMTRANSACTIONID: "1",
        POSTINGDATE: "2025-08-01",
        CLAIMTRANSACTIONTYPENAME: "Claim created",
      }),
    ],
    claimStatus: [],
    edi835: [
      edi({
        id: 1,
        patient_control_number: "75258B",
        patient_first: "Donna L",
        patient_last: "Reed",
        service_date: "20250808",
        service_code: "77470",
        paid_amount: "100.00",
      }),
      edi({
        id: 2,
        patient_control_number: "752580",
        paid_amount: "999.00",
      }),
    ],
  });

  assert.deepEqual(result.claim.submissionReferences, ["75258B"]);
  assert.equal(result.summary.eraPaid, 100);
  assert.ok(result.warnings.some((warning) => /patient text differs/.test(warning)));
  assert.ok(result.warnings.some((warning) => /DOS added/.test(warning)));
  assert.ok(result.warnings.some((warning) => /CPT added/.test(warning)));
});

test("Flatten service-line rows are displayed once per actual claim event", () => {
  const procedures = [
    ["99215", "25"],
    ["99417", ""],
    ["G2211", ""],
    ["77263", "59"],
    ["77470", "59"],
    ["77300", "59"],
  ];
  const rowsForEvent = (type, postingDate, idStart, additions = {}) =>
    procedures.map(([procedure, modifier], index) => transaction({
      ENCOUNTERID: "90001",
      DATEOFSERVICE: "2025-11-04",
      PROCEDURECODE: procedure,
      MOD1: modifier,
      CLAIMTRANSACTIONID: String(idStart + index),
      POSTINGDATE: postingDate,
      CLAIMTRANSACTIONTYPENAME: type,
      ...additions,
    }));

  const paymentRows = rowsForEvent("Applied payment", "2025-12-15", 30, {
    PAYMENTID: "CHECK-1",
    Amount: "0.00",
    PaymentNotes: "CHECK RECD IN TEBRA -YR",
  });
  paymentRows.at(-1).Amount = "522.09";

  const result = buildClaimLifecycle({
    claimId: "90001",
    transactions: [
      ...rowsForEvent("Claim created", "2025-11-14", 1),
      ...rowsForEvent("Billed", "2025-11-16", 10),
      ...paymentRows,
      ...rowsForEvent("Adjusted charges", "2025-12-17", 40),
      ...rowsForEvent("Settled", "2025-12-17", 50),
    ],
    claimStatus: [],
    edi835: [],
  });

  const flattenEvents = result.timeline.filter((event) => event.source === "FlattenTransctions2");
  for (const title of ["Claim created", "Billed", "Posted payment", "Adjusted charges", "Settled"]) {
    assert.equal(flattenEvents.filter((event) => event.title === title).length, 1);
  }
  assert.equal(flattenEvents.length, 5);
  assert.ok(flattenEvents.every((event) => !/\bCPT\b/.test(event.description)));

  const payment = flattenEvents.find((event) => event.title === "Posted payment");
  assert.equal(payment.amount, 522.09);
  assert.match(payment.description, /6 service lines/);
  assert.equal(payment.countedPayment, 522.09);
  assert.equal(result.summary.postedPaid, 522.09);
  assert.equal(result.summary.receivedPaid, 0);
});

test("ERA service lines are displayed as one remittance event", () => {
  const result = buildClaimLifecycle({
    claimId: "80751",
    transactions: [
      transaction({ CLAIMTRANSACTIONID: "1", POSTINGDATE: "2026-01-03", CLAIMTRANSACTIONTYPENAME: "Claim created" }),
    ],
    claimStatus: [],
    edi835: [
      edi({ id: 1, reference_id: "LINE-1", service_code: "78802", paid_amount: "100.00" }),
      edi({ id: 2, reference_id: "LINE-2", service_code: "78832", paid_amount: "50.00" }),
    ],
  });

  const eraPayments = result.timeline.filter(
    (event) => event.source === "EDI 835 ERA" && event.title === "Payment received",
  );
  assert.equal(eraPayments.length, 1);
  assert.equal(eraPayments[0].amount, 150);
  assert.match(eraPayments[0].description, /2 service lines/);
  assert.doesNotMatch(eraPayments[0].description, /\bCPT\b/);
  assert.deepEqual(eraPayments[0].procedures, ["78802", "78832"]);
  const cptActivity = eraPayments[0].cptActivity.find((item) => item.procedure === "78802");
  assert.equal(cptActivity.lineCount, 1);
  assert.equal(cptActivity.billed, 500);
  assert.equal(cptActivity.received, 100);
  assert.match(cptActivity.adjustments.join(" "), /45/);
  const submission = result.timeline.find((event) => event.title === "Submission/correction/rebill observed");
  assert.deepEqual(submission.procedures, ["78802", "78832"]);
  assert.equal(result.eras.length, 1);
  assert.equal(result.eras[0].source, "EDI 835 ERA");
  assert.equal(result.eras[0].lineCount, 2);
  assert.equal(result.eras[0].paid, 150);
  assert.equal(result.eras[0].serviceLines[1].procedure, "78832");
});

test("appointment-linked prior authorization and transaction evidence drive claim milestones", () => {
  const result = buildClaimLifecycle({
    claimId: "80751",
    transactions: [
      transaction({ CLAIMTRANSACTIONID: "1", POSTINGDATE: "2026-01-03", CLAIMTRANSACTIONTYPENAME: "Claim created" }),
      transaction({ CLAIMTRANSACTIONID: "2", POSTINGDATE: "2026-01-04", CLAIMTRANSACTIONTYPENAME: "Billed" }),
    ],
    claimStatus: [],
    edi835: [],
    priorAuthorizations: [
      {
        authorizationId: "38787",
        authorizationNumber: "NAR",
        authorizationDescription: "NO AUTH REQ",
        authorizationStatus: "AUTH NOT REQUIRED",
        effectiveDate: "2026-07-07",
        appointmentId: "80751",
        appointmentDateTime: "2026-07-21 09:30:00",
        authorizationCountId: "10",
        authorizedVisits: "1",
        remainingVisits: "0",
        procedureCode: "78832",
      },
      {
        authorizationId: "38787",
        authorizationNumber: "NAR",
        authorizationDescription: "NO AUTH REQ",
        authorizationStatus: "AUTH NOT REQUIRED",
        effectiveDate: "2026-07-07",
        appointmentId: "80751",
        appointmentDateTime: "2026-07-21 09:30:00",
        authorizationCountId: "10",
        authorizedVisits: "1",
        remainingVisits: "0",
        procedureCode: "78835",
      },
    ],
  });

  assert.equal(result.priorAuthorizations.length, 1);
  assert.equal(result.priorAuthorizations[0].appointment.id, "80751");
  assert.deepEqual(result.priorAuthorizations[0].counts[0].procedureCodes, ["78832", "78835"]);
  assert.equal(result.progress.find((step) => step.key === "prior-auth").state, "complete");
  assert.equal(result.progress.find((step) => step.key === "payer-pending").state, "current");
  assert.equal(result.progress.find((step) => step.key === "adjudicated").state, "upcoming");
});
