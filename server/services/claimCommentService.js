import { categorizeClaimComments } from "../integrations/geminiCommentCategorizer.js";
import { readSalesforceClaimComments } from "../integrations/salesforceComments.js";

function text(value) {
  return String(value ?? "").trim();
}

function compact(values) {
  return values.map(text).filter(Boolean);
}

function commentStatus(category) {
  if (category === "payment_identified_or_posting") return "success";
  if (category === "denial_or_pending") return "danger";
  if ([
    "appeal_submitted",
    "appeal_planned_or_prepared",
    "appeal_follow_up_or_status",
    "corrected_claim_or_rebill",
    "write_off_or_adjustment",
  ].includes(category)) return "warning";
  return "neutral";
}

function commentEvent(comment) {
  const structuredMoney = compact([
    comment.paid != null ? `Paid ${comment.paid.toLocaleString("en-US", { style: "currency", currency: "USD" })}` : null,
    comment.allowed != null ? `Allowed ${comment.allowed.toLocaleString("en-US", { style: "currency", currency: "USD" })}` : null,
    comment.amount != null ? `Amount ${comment.amount.toLocaleString("en-US", { style: "currency", currency: "USD" })}` : null,
    comment.checkEft ? `Check/EFT ${comment.checkEft}` : null,
    comment.issueDate ? `Issue date ${comment.issueDate}` : null,
    comment.clearedDate ? `Cleared date ${comment.clearedDate}` : null,
    comment.paymentPostingIssue ? "Payment posting issue flagged" : null,
  ]);
  const description = compact([
    `Comment ${comment.sequence} of its claim comment sequence`,
    comment.summary,
    comment.action ? `Action ${comment.action}` : null,
    comment.followUpAction ? `Follow-up ${comment.followUpAction}` : null,
    comment.evidence ? `Evidence “${comment.evidence}”` : null,
    ...structuredMoney,
  ]).join(" · ");

  return {
    id: `salesforce-comment-${comment.commentId}`,
    date: comment.date,
    occurredAt: comment.createdAt || comment.date,
    title: comment.categoryLabel,
    description: description || "Salesforce claim comment.",
    source: comment.classificationStatus === "categorized"
      ? "Salesforce comment + Gemini"
      : "Salesforce comment",
    status: commentStatus(comment.category),
    amount: null,
    countedPayment: 0,
    paymentAuthority: "informational",
    submissionReference: null,
    eventType: "salesforce-comment",
    commentOrder: comment.sequence,
    category: comment.category,
    categoryLabel: comment.categoryLabel,
    confidence: comment.confidence,
    commentText: comment.text,
    commentTextTruncated: comment.textTruncated,
    commentId: comment.commentId,
    salesforceCaseId: comment.caseId,
    action: comment.action,
    followUpAction: comment.followUpAction,
    classificationStatus: comment.classificationStatus,
  };
}

function eventSortKey(event) {
  const base = text(event.occurredAt || event.date) || "9999-12-31";
  return base.length === 10 ? `${base}T00:00:00.000Z` : base;
}

function compareTimelineEvents(left, right) {
  return eventSortKey(left).localeCompare(eventSortKey(right))
    || Number(left.commentOrder || 0) - Number(right.commentOrder || 0);
}

export function attachClaimComments(lifecycle, commentResult) {
  const latestCommentCaseStatus = [...(commentResult.comments || [])]
    .reverse()
    .find((comment) => text(comment.caseStatus))?.caseStatus;
  const commentEvents = (commentResult.comments || []).map(commentEvent);
  const timeline = [
    ...lifecycle.timeline.map((event, index) => ({ event, originalIndex: index })),
    ...commentEvents.map((event, index) => ({
      event,
      originalIndex: lifecycle.timeline.length + index,
    })),
  ].sort((left, right) => compareTimelineEvents(left.event, right.event)
    || left.originalIndex - right.originalIndex)
    .map((entry) => entry.event);
  const sourceNames = [...lifecycle.provenance.sources];
  if (commentEvents.length) sourceNames.push("Salesforce comments");
  if (commentResult.integration.geminiStatus === "ready" || commentResult.integration.geminiStatus === "partial_error") {
    sourceNames.push("Gemini categorization");
  }
  const lastDatedEvent = timeline.filter((event) => event.date).at(-1);

  return {
    ...lifecycle,
    claim: {
      ...lifecycle.claim,
      lastActivityAt: lastDatedEvent?.date || lifecycle.claim.lastActivityAt,
      salesforceStatus: text(commentResult.integration.caseStatus)
        || text(latestCommentCaseStatus)
        || null,
    },
    summary: {
      ...lifecycle.summary,
      eventCount: timeline.length,
      commentCount: commentEvents.length,
    },
    timeline,
    comments: commentResult.comments || [],
    commentIntegration: commentResult.integration,
    provenance: {
      ...lifecycle.provenance,
      sources: [...new Set(sourceNames)],
      salesforceCases: commentResult.integration.caseCount || 0,
      salesforceComments: commentResult.integration.commentCount || 0,
      categorizedComments: commentResult.integration.categorizedCount || 0,
    },
  };
}

function failedCommentResult(message) {
  return {
    comments: [],
    integration: {
      status: "error",
      caseStatus: null,
      geminiStatus: "not_run",
      model: null,
      caseCount: 0,
      commentCount: 0,
      categorizedCount: 0,
      failedCount: 0,
      cachedCount: 0,
      truncated: false,
      message,
    },
  };
}

export async function enrichClaimWithComments(lifecycle, options = {}) {
  const readComments = options.readComments || readSalesforceClaimComments;
  const categorizeComments = options.categorizeComments || categorizeClaimComments;
  try {
    const salesforceResult = await readComments(lifecycle.claim);
    const categorized = await categorizeComments(lifecycle.claim, salesforceResult);
    return attachClaimComments(lifecycle, categorized);
  } catch (error) {
    console.error("Salesforce/Gemini claim comment enrichment failed:", error?.code || error?.name || "unknown error");
    return attachClaimComments(
      lifecycle,
      failedCommentResult("Salesforce comments could not be loaded. The MySQL and ERA claim lifecycle remains available."),
    );
  }
}
