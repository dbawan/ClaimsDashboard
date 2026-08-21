import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommentPrompt,
  categorizeClaimComments,
  createGeminiClient,
  validateClassification,
} from "./geminiCommentCategorizer.js";

function comment(overrides = {}) {
  return {
    commentId: "note-gemini-test",
    caseId: "case-1",
    claimReference: "81047Z70886",
    caseStatus: "In Process",
    createdAt: "2026-07-14T15:00:00.000Z",
    date: "2026-07-14",
    action: "SENT APPEAL PORTAL",
    followUpAction: "APPEAL FOLLOWUP",
    text: "Appeal was submitted through Availity.",
    ...overrides,
  };
}

test("Gemini prompt carries the categorizer taxonomy and minimal claim context", () => {
  const prompt = buildCommentPrompt({ claimId: "81047", payer: "Payer", status: "Open" }, comment());
  assert.match(prompt, /appeal_submitted/);
  assert.match(prompt, /Preparing an appeal.*not appeal_submitted/);
  assert.match(prompt, /"claim_id":"81047"/);
  assert.doesNotMatch(prompt, /patient/i);
});

test("Gemini client supports Vertex AI service-account configuration", () => {
  const client = createGeminiClient({
    provider: "vertex-ai",
    project: "example-project",
    location: "us-central1",
    serviceAccount: {
      type: "service_account",
      project_id: "example-project",
      private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
      client_email: "example@example-project.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
    },
  });
  assert.equal(client.vertexai, true);
});

test("Gemini classification requires a known category and exact comment evidence", () => {
  assert.deepEqual(validateClassification({
    category: "appeal_submitted",
    confidence: "high",
    summary: "An appeal was sent.",
    evidence: "Appeal was submitted",
  }, comment()), {
    category: "appeal_submitted",
    confidence: "high",
    summary: "An appeal was sent.",
    evidence: "Appeal was submitted",
  });
  assert.throws(() => validateClassification({
    category: "appeal_submitted",
    confidence: "high",
    summary: "Invented",
    evidence: "Mailed yesterday",
  }, comment()), /exact excerpt/);
});

test("each Salesforce comment is categorized independently and remains ordered", async () => {
  const calls = [];
  const client = { models: { async generateContent(request) {
    calls.push(request);
    const followup = request.contents.includes("under review");
    return { text: JSON.stringify({
      category: followup ? "appeal_follow_up_or_status" : "appeal_submitted",
      confidence: "high",
      summary: followup ? "The appeal remains under review." : "An appeal was submitted.",
      evidence: followup ? "under review" : "Appeal was submitted",
    }) };
  } } };
  const salesforceResult = {
    comments: [
      comment(),
      comment({
        commentId: "note-gemini-test-2",
        createdAt: "2026-07-15T15:00:00.000Z",
        date: "2026-07-15",
        action: "APPEAL FOLLOWUP",
        text: "The appeal is still under review.",
      }),
    ],
    integration: { status: "ready", caseCount: 1, commentCount: 2, message: "ready" },
  };
  const result = await categorizeClaimComments(
    { claimId: "81047", payer: "Payer", status: "Open" },
    salesforceResult,
    {
      client,
      settings: {
        configured: true,
        apiKey: "not-used-by-fake",
        model: "gemini-test",
        maxAttempts: 1,
        concurrency: 2,
      },
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].config.responseMimeType, "application/json");
  assert.deepEqual(result.comments.map((item) => item.sequence), [1, 2]);
  assert.deepEqual(result.comments.map((item) => item.category), [
    "appeal_submitted",
    "appeal_follow_up_or_status",
  ]);
  assert.equal(result.integration.categorizedCount, 2);
  assert.equal(result.integration.geminiStatus, "ready");
});
