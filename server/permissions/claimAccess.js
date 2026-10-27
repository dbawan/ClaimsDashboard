function isSalesforceComment(event) {
  return event?.eventType === "salesforce-comment";
}

function isFinancialEvent(event) {
  return event?.paymentAuthority !== "informational"
    || event?.amount != null
    || Number(event?.countedPayment || 0) !== 0;
}

function permittedTimeline(timeline, permissions) {
  return (timeline || []).filter((event) => {
    if (isSalesforceComment(event)) return permissions.supportingRecords;
    if (isFinancialEvent(event)) return permissions.paymentsAndEra;
    return permissions.claimOverview;
  });
}

function permittedProgress(progress, permissions) {
  const visible = (progress || []).filter((step) => {
    if (step.key === "prior-auth") return permissions.supportingRecords;
    if (["payment-posting", "payment-received"].includes(step.key)) return permissions.paymentsAndEra;
    return true;
  });
  if (visible.some((step) => step.state === "current" || step.state === "alert")) return visible;

  const latestComplete = visible.findLastIndex((step) => step.state === "complete");
  if (latestComplete < 0) return visible;
  return visible.map((step, index) => (
    index === latestComplete ? { ...step, state: "current" } : step
  ));
}

function publicClaim(claim, permissions) {
  const result = {
    claimId: claim.claimId,
    encounterId: claim.encounterId,
    status: permissions.claimOverview || permissions.paymentsAndEra
      ? claim.status
      : "Claim located",
  };
  if (permissions.claimOverview) {
    Object.assign(result, {
      alternateIdentifiers: claim.alternateIdentifiers,
      submissionReferences: claim.submissionReferences,
      patientName: claim.patientName,
      dateOfBirth: claim.dateOfBirth,
      medicalRecordNumber: claim.medicalRecordNumber,
      provider: claim.provider,
      location: claim.location,
      payer: claim.payer,
      serviceDate: claim.serviceDate,
      datesOfService: claim.datesOfService,
      procedure: claim.procedure,
      createdAt: claim.createdAt,
      createdAtBasis: claim.createdAtBasis,
      submittedAt: claim.submittedAt,
      lastActivityAt: claim.lastActivityAt,
    });
  }
  if (permissions.supportingRecords) result.salesforceStatus = claim.salesforceStatus;
  return result;
}

function publicProvenance(provenance, permissions) {
  const sources = (provenance.sources || []).filter((source) => {
    if (["ClaimStatus ERA", "EDI 835 ERA", "AdvancedMD ERA"].includes(source)) return permissions.paymentsAndEra;
    if (["EHR prior authorization", "Patient invoices", "Salesforce comments", "Gemini categorization", "RCM Claims API"].includes(source)) {
      return permissions.supportingRecords;
    }
    return permissions.claimOverview;
  });
  return {
    sources,
    transactionRows: permissions.claimOverview ? provenance.transactionRows : 0,
    claimStatusRows: permissions.paymentsAndEra ? provenance.claimStatusRows : 0,
    edi835Rows: permissions.paymentsAndEra ? provenance.edi835Rows : 0,
    advancedMdEraRows: permissions.paymentsAndEra ? provenance.advancedMdEraRows || 0 : 0,
    priorAuthorizationRows: permissions.supportingRecords ? provenance.priorAuthorizationRows : 0,
    patientInvoiceRows: permissions.supportingRecords ? provenance.patientInvoiceRows : 0,
    salesforceCases: permissions.supportingRecords ? provenance.salesforceCases || 0 : 0,
    salesforceComments: permissions.supportingRecords ? provenance.salesforceComments || 0 : 0,
    categorizedComments: permissions.supportingRecords ? provenance.categorizedComments || 0 : 0,
    duplicatesRemoved: permissions.paymentsAndEra ? provenance.duplicatesRemoved : 0,
    eraMatchedPostings: permissions.paymentsAndEra ? provenance.eraMatchedPostings : 0,
    paymentRule: permissions.paymentsAndEra ? provenance.paymentRule : null,
    matchRule: permissions.paymentsAndEra ? provenance.matchRule : null,
  };
}

function publicClaimVitals(vitals = {}, permissions) {
  return {
    asOfDate: vitals.asOfDate || null,
    claimAgeDays: permissions.claimOverview ? vitals.claimAgeDays ?? null : null,
    daysSinceTouch: permissions.claimOverview ? vitals.daysSinceTouch ?? null : null,
    lastTouchDate: permissions.claimOverview ? vitals.lastTouchDate || null : null,
    outstandingArAmount: permissions.paymentsAndEra
      ? vitals.outstandingArAmount ?? null
      : null,
    originalCharge: permissions.paymentsAndEra ? vitals.originalCharge ?? null : null,
    expectedReimbursement: permissions.paymentsAndEra
      ? vitals.expectedReimbursement ?? null
      : null,
    expectedReimbursementBreakdown: permissions.paymentsAndEra
      ? (vitals.expectedReimbursementBreakdown || []).map((line) => ({
        ...line,
        payer: permissions.claimOverview ? line.payer || null : null,
        canonicalPayer: permissions.claimOverview ? line.canonicalPayer || null : null,
      }))
      : [],
    expectedReimbursementMatchedCptCount: permissions.paymentsAndEra
      ? vitals.expectedReimbursementMatchedCptCount ?? 0
      : 0,
    expectedReimbursementTotalCptCount: permissions.paymentsAndEra
      ? vitals.expectedReimbursementTotalCptCount ?? 0
      : 0,
    expectedReimbursementComplete: permissions.paymentsAndEra
      ? Boolean(vitals.expectedReimbursementComplete)
      : false,
    expectedReimbursementPayer: permissions.paymentsAndEra && permissions.claimOverview
      ? vitals.expectedReimbursementPayer || null
      : null,
    paid: permissions.paymentsAndEra ? vitals.paid ?? null : null,
    attempts: permissions.claimOverview ? vitals.attempts ?? null : null,
    filingStartDate: permissions.claimOverview ? vitals.filingStartDate || null : null,
    filingStartReason: permissions.claimOverview ? vitals.filingStartReason || null : null,
    filingLimitDate: permissions.claimOverview ? vitals.filingLimitDate || null : null,
    filingLimitDaysLeft: permissions.claimOverview
      ? vitals.filingLimitDaysLeft ?? null
      : null,
    appealResponseDate: permissions.supportingRecords
      ? vitals.appealResponseDate || null
      : null,
    appealDeadline: permissions.claimOverview || permissions.supportingRecords
      ? vitals.appealDeadline || null
      : null,
    appealDaysLeft: permissions.claimOverview || permissions.supportingRecords
      ? vitals.appealDaysLeft ?? null
      : null,
  };
}

export function filterClaimLifecycleByPermissions(lifecycle, permissions) {
  const access = Object.freeze({
    claimOverview: Boolean(permissions.claimOverview),
    paymentsAndEra: Boolean(permissions.paymentsAndEra),
    supportingRecords: Boolean(permissions.supportingRecords),
    worklistAccess: Boolean(permissions.worklistAccess || permissions.worklistManagement),
    worklistManagement: Boolean(permissions.worklistManagement),
    salesforceNoteCreate: Boolean(
      permissions.supportingRecords && permissions.salesforceNoteCreate,
    ),
    salesforceNoteMaxChars: permissions.supportingRecords && permissions.salesforceNoteCreate
      ? Number(permissions.salesforceNoteMaxChars) || 0
      : 0,
  });
  const timeline = permittedTimeline(lifecycle.timeline, access);
  const response = {
    access,
    claim: publicClaim(lifecycle.claim, access),
    summary: access.paymentsAndEra
      ? lifecycle.summary
      : { eventCount: timeline.length, commentCount: access.supportingRecords ? lifecycle.summary.commentCount || 0 : 0 },
    timeline,
    progress: access.claimOverview ? permittedProgress(lifecycle.progress, access) : [],
    warnings: access.claimOverview && access.paymentsAndEra ? lifecycle.warnings : [],
    provenance: publicProvenance(lifecycle.provenance, access),
    claimVitals: publicClaimVitals(lifecycle.claimVitals, access),
  };

  if (access.paymentsAndEra) {
    response.eras = lifecycle.eras;
    response.cptFinancials = lifecycle.cptFinancials;
  }

  if (access.supportingRecords) {
    response.priorAuthorizations = lifecycle.priorAuthorizations;
    response.patientInvoices = lifecycle.patientInvoices;
    response.invoiceIntegration = lifecycle.invoiceIntegration;
    response.comments = lifecycle.comments;
    response.commentIntegration = lifecycle.commentIntegration;
    response.categorization = lifecycle.categorization;
    response.categorizationIntegration = lifecycle.categorizationIntegration;
  }

  return response;
}
