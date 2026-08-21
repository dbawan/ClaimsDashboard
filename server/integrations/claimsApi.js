import { config } from "../config.js";

function text(value) {
  const candidate = String(value ?? "").trim();
  return candidate || null;
}

function number(value) {
  if (value == null || value === "") return null;
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : null;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))];
}

function category(value) {
  if (value && typeof value === "object") {
    return {
      label: text(value.label),
      display: text(value.display) || text(value.label),
    };
  }
  const label = text(value);
  return { label, display: label };
}

function publicLineItem(item = {}) {
  return {
    lineItemId: text(item.line_item_id),
    rcmCaseId: text(item.rcm_case_id),
    cptCode: text(item.cpt_code),
    modifier: text(item.modifier),
    units: number(item.units),
    chargeAmount: number(item.charge_amount),
    paidAmount: number(item.paid_amount),
    owedAmount: number(item.owed_amount),
    carcCodes: stringList(item.carc_codes),
    rarcCodes: stringList(item.rarc_codes),
  };
}

function publicNote(note = {}) {
  return {
    sourceId: text(note.source_id),
    rcmCaseId: text(note.rcm_case_id),
    title: text(note.title),
    body: text(note.body),
    createdDate: text(note.created_date),
    createdBy: text(note.created_by),
    lastModifiedDate: text(note.last_modified_date),
    action: text(note.action),
    followUpAction: text(note.follow_up_action),
    followUpDate: text(note.follow_up_date),
    category: text(note.category),
    denialReason: text(note.denial_reason),
    resolution: text(note.resolution),
  };
}

export function publicCategorizedClaim(claim = {}) {
  return {
    claimId: text(claim.claim_id),
    rcmCaseId: text(claim.rcm_case_id),
    caseName: text(claim.case_name),
    patient: text(claim.patient),
    payer: text(claim.payer),
    dateOfService: text(claim.date_of_service),
    workflow: text(claim.workflow),
    pipelineStatus: text(claim.pipeline_status),
    salesforceStatus: text(claim.salesforce_status),
    llmStatus: text(claim.llm_status),
    category: category(claim.category),
    clusterLabel: text(claim.cluster_label),
    clusterDisplay: text(claim.cluster_display),
    normalizedReason: text(claim.normalized_reason),
    reasonDisplay: text(claim.reason_display) || text(claim.normalized_reason),
    primaryIssueType: text(claim.primary_issue_type),
    confidence: number(claim.confidence),
    requiresHumanReview: Boolean(claim.requires_human_review),
    conflictingSignals: Boolean(claim.conflicting_signals),
    carcCodes: stringList(claim.carc_codes),
    rarcCodes: stringList(claim.rarc_codes),
    summary: text(claim.summary),
    evidence: text(claim.evidence),
    totalChargeAmount: number(claim.total_charge_amount),
    totalInsuranceOwed: number(claim.total_insurance_owed),
    lineItems: Array.isArray(claim.line_items) ? claim.line_items.map(publicLineItem) : [],
    notes: Array.isArray(claim.notes) ? claim.notes.map(publicNote) : [],
  };
}

function result(status, message, claim = null) {
  return {
    claim,
    integration: {
      status,
      message,
      source: "RCM Claims API",
    },
  };
}

export async function readCategorizedClaim(
  claimId,
  { settings = config.claimsApi, fetchImpl = globalThis.fetch } = {},
) {
  if (!settings.configured) {
    return result(
      "not_configured",
      "Add CLAIMS_API_KEY to the server environment to load categorized claim data.",
    );
  }

  const endpoint = new URL(`${settings.baseUrl}/claims/${encodeURIComponent(claimId)}`);
  endpoint.searchParams.set("workflow", settings.workflow);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        "X-API-Key": settings.apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return result(
      timedOut ? "timeout" : "error",
      timedOut
        ? "The categorized claim request timed out."
        : "The categorized claim service could not be reached.",
    );
  }

  const payload = await response.json().catch(() => null);
  if (response.status === 404) {
    return result("not_found", "No categorized record was found for this claim.");
  }
  if (response.status === 401) {
    return result("misconfigured", "The Claims API key was rejected.");
  }
  if (response.status === 503) {
    return result("unavailable", "The categorized claim service is not configured or unavailable.");
  }
  if (!response.ok || !payload?.claim) {
    return result("error", "The categorized claim data could not be loaded.");
  }

  return result("ready", "Categorized claim data loaded.", publicCategorizedClaim(payload.claim));
}
