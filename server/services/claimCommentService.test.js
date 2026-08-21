import test from "node:test";
import assert from "node:assert/strict";
import { attachClaimComments } from "./claimCommentService.js";

test("categorized Salesforce comments join the timeline without affecting payments", () => {
  const lifecycle = {
    claim: { claimId: "81047", lastActivityAt: "2026-07-20" },
    summary: { totalPaid: 1760.54, eventCount: 2 },
    timeline: [
      { id: "created", date: "2026-07-11", title: "Claim created", countedPayment: 0 },
      { id: "paid", date: "2026-07-20", title: "Payment received", countedPayment: 1760.54 },
    ],
    provenance: { sources: ["FlattenTransctions2", "ClaimStatus ERA"] },
  };
  const result = attachClaimComments(lifecycle, {
    comments: [
      {
        commentId: "note-1",
        caseId: "case-1",
        date: "2026-07-14",
        createdAt: "2026-07-14T13:00:00.000Z",
        sequence: 1,
        category: "appeal_submitted",
        categoryLabel: "Appeal submitted",
        confidence: "high",
        summary: "An appeal was submitted.",
        evidence: "submitted appeal",
        text: "We submitted appeal through the portal.",
        action: "SENT APPEAL PORTAL",
        classificationStatus: "categorized",
      },
      {
        commentId: "note-2",
        caseId: "case-1",
        date: "2026-07-15",
        createdAt: "2026-07-15T13:00:00.000Z",
        sequence: 2,
        category: "appeal_follow_up_or_status",
        categoryLabel: "Appeal follow-up / status",
        confidence: "medium",
        summary: "The appeal is under review.",
        evidence: "under review",
        text: "Appeal remains under review.",
        classificationStatus: "categorized",
      },
    ],
    integration: {
      status: "ready",
      caseStatus: "In Process",
      geminiStatus: "ready",
      model: "gemini-test",
      caseCount: 1,
      commentCount: 2,
      categorizedCount: 2,
    },
  });

  assert.equal(result.summary.totalPaid, 1760.54);
  assert.equal(result.claim.salesforceStatus, "In Process");
  assert.equal(result.summary.eventCount, 4);
  assert.equal(result.summary.commentCount, 2);
  assert.deepEqual(result.timeline.map((event) => event.id), [
    "created",
    "salesforce-comment-note-1",
    "salesforce-comment-note-2",
    "paid",
  ]);
  assert.equal(result.timeline[1].countedPayment, 0);
  assert.equal(result.timeline[1].commentOrder, 1);
  assert.equal(result.timeline[1].category, "appeal_submitted");
  assert.ok(result.provenance.sources.includes("Salesforce comments"));
  assert.ok(result.provenance.sources.includes("Gemini categorization"));
});
