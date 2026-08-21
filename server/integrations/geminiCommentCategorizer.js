import { createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";

export const COMMENT_CATEGORIES = Object.freeze({
  appeal_submitted: "The comment says an appeal was actually sent or filed.",
  appeal_planned_or_prepared: "An appeal is planned or prepared but not sent.",
  appeal_follow_up_or_status: "The comment checks or describes appeal status.",
  payment_identified_or_posting: "Payment was found, confirmed, or needs posting.",
  corrected_claim_or_rebill: "The claim was corrected, resubmitted, or rebilled.",
  denial_or_pending: "The claim was denied, rejected, or remains pending.",
  write_off_or_adjustment: "The comment concerns a write-off or adjustment.",
  other: "The comment has useful information outside the categories above.",
  insufficient_evidence: "The comment is empty, unclear, or lacks enough detail.",
});

export const COMMENT_CATEGORY_LABELS = Object.freeze({
  appeal_submitted: "Appeal submitted",
  appeal_planned_or_prepared: "Appeal planned / prepared",
  appeal_follow_up_or_status: "Appeal follow-up / status",
  payment_identified_or_posting: "Payment identified / posting",
  corrected_claim_or_rebill: "Corrected claim / rebill",
  denial_or_pending: "Denial / pending",
  write_off_or_adjustment: "Write-off / adjustment",
  other: "Other action",
  insufficient_evidence: "Insufficient evidence",
});

const CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);
const PROMPT_VERSION = "claim-comment-category-v1";
const classificationCache = new Map();
const MAX_CACHE_ENTRIES = 2_000;
let defaultClient;

export function createGeminiClient(settings = config.gemini) {
  if (settings.provider === "gemini-api") {
    return new GoogleGenAI({ apiKey: settings.apiKey });
  }
  return new GoogleGenAI({
    vertexai: true,
    project: settings.project,
    location: settings.location,
    googleAuthOptions: {
      credentials: settings.serviceAccount,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    },
  });
}

function compact(values) {
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function evidenceText(comment) {
  return compact([comment.action, comment.followUpAction, comment.text]).join("\n");
}

export function buildCommentPrompt(claim, comment) {
  const categoryText = Object.entries(COMMENT_CATEGORIES)
    .map(([name, meaning]) => `- ${name}: ${meaning}`)
    .join("\n");
  const payload = {
    claim: {
      claim_id: claim.claimId,
      payer: claim.payer,
      status: comment.caseStatus || claim.status,
      salesforce_claim_reference: comment.claimReference,
    },
    comment: {
      comment_id: comment.commentId,
      created_at: comment.createdAt,
      action: comment.action,
      follow_up_action: comment.followUpAction,
      text: comment.text,
    },
  };
  return `You categorize comments attached to medical billing claim records.

Choose exactly one primary category:
${categoryText}

Important rules:
- Use appeal_submitted only when the comment says the appeal itself was actually submitted, sent, filed, faxed, mailed, or uploaded.
- Preparing an appeal or saying it should be submitted is not appeal_submitted.
- Do not assume that a completed work status means the claim was paid.
- Treat the structured action and follow-up fields as part of the comment.
- Do not invent facts. Evidence must be a short exact quote from the action, follow-up action, or text.
- If the content is unclear, use insufficient_evidence.

Return one JSON object matching the requested schema.

Input:
${JSON.stringify(payload)}`;
}

export function validateClassification(result, comment) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Gemini did not return a JSON object");
  }
  const category = String(result.category || "").trim();
  const confidence = String(result.confidence || "").trim().toLowerCase();
  const summary = String(result.summary || "").trim().slice(0, 500);
  const evidence = String(result.evidence || "").trim().slice(0, 500);
  if (!Object.hasOwn(COMMENT_CATEGORIES, category)) {
    throw new Error("Gemini returned an unknown category");
  }
  if (!CONFIDENCE_LEVELS.has(confidence)) {
    throw new Error("Gemini returned an unknown confidence level");
  }
  if (evidence && !evidenceText(comment).toLocaleLowerCase().includes(evidence.toLocaleLowerCase())) {
    throw new Error("Gemini evidence was not an exact excerpt from the comment");
  }
  return { category, confidence, summary, evidence };
}

function responseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      category: { type: "string", enum: Object.keys(COMMENT_CATEGORIES) },
      confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
      summary: { type: "string" },
      evidence: { type: "string" },
    },
    required: ["category", "confidence", "summary", "evidence"],
  };
}

function cacheKey(settings, claim, comment) {
  return createHash("sha256").update(JSON.stringify({
    version: PROMPT_VERSION,
    model: settings.model,
    claimId: claim.claimId,
    commentId: comment.commentId,
    createdAt: comment.createdAt,
    action: comment.action,
    followUpAction: comment.followUpAction,
    text: comment.text,
  })).digest("hex");
}

function remember(key, value) {
  if (classificationCache.size >= MAX_CACHE_ENTRIES) {
    classificationCache.delete(classificationCache.keys().next().value);
  }
  classificationCache.set(key, value);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function classifyOne(client, settings, claim, comment) {
  const key = cacheKey(settings, claim, comment);
  if (classificationCache.has(key)) return { ...classificationCache.get(key), fromCache: true };

  const prompt = buildCommentPrompt(claim, comment);
  let finalError;
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    try {
      const response = await client.models.generateContent({
        model: settings.model,
        contents: prompt,
        config: {
          temperature: 0,
          responseMimeType: "application/json",
          responseJsonSchema: responseSchema(),
        },
      });
      const decoded = JSON.parse(response.text || "{}");
      const result = validateClassification(decoded, comment);
      remember(key, result);
      return { ...result, fromCache: false };
    } catch (error) {
      finalError = error;
      if (attempt < settings.maxAttempts) await wait(250 * attempt);
    }
  }
  throw new Error(`Gemini classification failed after ${settings.maxAttempts} attempt(s)`, { cause: finalError });
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function fallbackClassification(status) {
  const message = status === "not_configured"
    ? "Gemini categorization is not configured."
    : "Comment could not be categorized by Gemini.";
  return {
    category: "insufficient_evidence",
    categoryLabel: status === "not_configured" ? "Not categorized" : COMMENT_CATEGORY_LABELS.insufficient_evidence,
    confidence: "low",
    summary: message,
    evidence: "",
    classificationStatus: status,
    fromCache: false,
  };
}

function categorizedComment(comment, classification, sequence) {
  return {
    ...comment,
    sequence,
    category: classification.category,
    categoryLabel: classification.categoryLabel || COMMENT_CATEGORY_LABELS[classification.category],
    confidence: classification.confidence,
    summary: classification.summary,
    evidence: classification.evidence,
    classificationStatus: classification.classificationStatus || "categorized",
    fromCache: Boolean(classification.fromCache),
  };
}

export async function categorizeClaimComments(claim, salesforceResult, options = {}) {
  const settings = options.settings || config.gemini;
  const comments = salesforceResult.comments || [];
  const baseIntegration = salesforceResult.integration;
  if (!comments.length) {
    return {
      comments: [],
      integration: {
        ...baseIntegration,
        geminiStatus: settings.configured ? "ready" : "not_configured",
        model: settings.configured ? settings.model : null,
        categorizedCount: 0,
        failedCount: 0,
        cachedCount: 0,
      },
    };
  }

  if (!settings.configured) {
    return {
      comments: comments.map((comment, index) => categorizedComment(
        comment,
        fallbackClassification("not_configured"),
        index + 1,
      )),
      integration: {
        ...baseIntegration,
        geminiStatus: "not_configured",
        model: null,
        categorizedCount: 0,
        failedCount: comments.length,
        cachedCount: 0,
        message: `${baseIntegration.message} Gemini is not configured, so the comments are ordered but not categorized.`,
      },
    };
  }

  const client = options.client || (defaultClient ||= createGeminiClient(settings));
  const results = await mapWithConcurrency(
    comments,
    settings.concurrency,
    async (comment) => {
      try {
        return await classifyOne(client, settings, claim, comment);
      } catch {
        return fallbackClassification("failed");
      }
    },
  );
  const categorized = comments.map((comment, index) => categorizedComment(comment, results[index], index + 1));
  const failedCount = categorized.filter((comment) => comment.classificationStatus === "failed").length;
  const cachedCount = categorized.filter((comment) => comment.fromCache).length;
  return {
    comments: categorized,
    integration: {
      ...baseIntegration,
      geminiStatus: failedCount ? "partial_error" : "ready",
      model: settings.model,
      provider: settings.provider,
      categorizedCount: categorized.length - failedCount,
      failedCount,
      cachedCount,
      message: failedCount
        ? `${failedCount} of ${categorized.length} Salesforce comments could not be categorized; their original order and text remain available.`
        : `${categorized.length} Salesforce comment${categorized.length === 1 ? " was" : "s were"} categorized by Gemini in Salesforce timestamp order.`,
    },
  };
}
