import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimStory,
  plainSourceLabel,
  scopeClaimDataToProcedure,
} from "./claimStoryModel.js";

let eventNumber = 0;

function event(date, title, overrides = {}) {
  eventNumber += 1;
  return {
    id: `${date}-${title}-${eventNumber}`,
    date,
    title,
    description: `${title} source detail`,
    source: "FlattenTransctions2",
    status: "neutral",
    amount: null,
    countedPayment: 0,
    paymentAuthority: "informational",
    submissionReference: null,
    ...overrides,
  };
}

test("twenty source records collapse into a seven-step claim story", () => {
  const timeline = [
    event("2025-12-01", "Date of service", { source: "Combined sources" }),
    event("2026-03-03", "Submission/correction/rebill observed", { submissionReference: "78820A", source: "EDI 835 ERA" }),
    event("2026-03-11", "Claim adjudicated", { amount: 0, source: "EDI 835 ERA" }),
    event("2026-04-16", "Claim created"),
    event("2026-04-24", "Billed"),
    event("2026-06-04", "Corrected claim / rebill", {
      eventType: "salesforce-comment",
      category: "corrected_claim_or_rebill",
      categoryLabel: "Corrected claim / rebill",
      source: "Salesforce comment + Gemini",
    }),
    event("2026-06-09", "Claim created"),
    event("2026-06-10", "Re-billed"),
    event("2026-06-10", "Billed"),
    event("2026-07-06", "Denial / pending", {
      eventType: "salesforce-comment",
      category: "denial_or_pending",
      categoryLabel: "Denial / pending",
      commentText: "Claim is not on file.",
      source: "Salesforce comment + Gemini",
    }),
    event("2026-07-20", "Submission/correction/rebill observed", { submissionReference: "78820C", source: "EDI 835 ERA" }),
    event("2026-07-20", "Submission/correction/rebill observed", { submissionReference: "78820D", source: "EDI 835 ERA" }),
    event("2026-07-29", "Payment received", { submissionReference: "78820C", amount: 2318.93, countedPayment: 2318.93, source: "EDI 835 ERA" }),
    event("2026-07-29", "Payment received", { submissionReference: "78820D", amount: 611.55, countedPayment: 611.55, source: "EDI 835 ERA" }),
    event("2026-08-03", "Denial / pending", {
      eventType: "salesforce-comment",
      category: "denial_or_pending",
      categoryLabel: "Denial / pending",
      commentText: "No claim on file for this DOS",
      source: "Salesforce comment + Gemini",
    }),
    event("2026-08-06", "Submission/correction/rebill observed", { submissionReference: "78820B", source: "EDI 835 ERA" }),
    event("2026-08-11", "Adjusted charges"),
    event("2026-08-12", "Settled"),
    event("2026-08-12", "Applied payment", { amount: 0, paymentAuthority: "era-matched-posting" }),
    event("2026-08-12", "Claim adjudicated", { submissionReference: "78820B", amount: 0, source: "EDI 835 ERA" }),
  ];

  const story = buildClaimStory({ timeline });

  assert.equal(story.length, 7);
  assert.deepEqual(story.map((episode) => episode.title), [
    "Service provided",
    "Payer response: no payment",
    "Claim corrected and rebilled",
    "Payer could not locate claim",
    "Payment received",
    "Payer could not locate claim",
    "Additional claim processing",
  ]);

  const payment = story.find((episode) => episode.title === "Payment received");
  assert.equal(payment.amount, 2930.48);
  assert.equal(payment.recordCount, 4);
  assert.deepEqual(payment.dates, ["2026-07-20", "2026-07-29"]);
  assert.match(payment.summary, /2 remittances/);

  const finalEpisode = story.at(-1);
  assert.deepEqual(finalEpisode.dates, ["2026-08-06", "2026-08-11", "2026-08-12"]);
  assert.equal(finalEpisode.amount, null);
});

test("payment reversals remain a distinct danger step", () => {
  const story = buildClaimStory({
    timeline: [
      event("2026-01-03", "Payment received", { amount: 100, countedPayment: 100, source: "EDI 835 ERA" }),
      event("2026-01-24", "Payment reversed", { amount: -25, countedPayment: -25, source: "EDI 835 ERA" }),
    ],
  });

  assert.equal(story.length, 2);
  assert.equal(story[1].title, "Payment reversed");
  assert.equal(story[1].amount, -25);
  assert.equal(story[1].status, "danger");
});

test("technical source names are replaced with plain labels", () => {
  assert.equal(plainSourceLabel("FlattenTransctions2"), "Billing system");
  assert.equal(plainSourceLabel("EDI 835 ERA"), "Payer remittance");
  assert.equal(plainSourceLabel("ClaimStatus ERA"), "Payer remittance");
  assert.equal(plainSourceLabel("Salesforce comment + Gemini"), "Team note");
  assert.equal(plainSourceLabel("Combined sources"), "Reconciled records");
});

test("a selected CPT story excludes other lines and keeps received and posted money separate", () => {
  const data = {
    claim: { claimId: "82020" },
    summary: { charges: 1_500, totalPaid: 650, receivedPaid: 650 },
    cptFinancials: [
      { procedure: "A9596", charged: 577.5 },
      { procedure: "J7999", charged: 922.5 },
    ],
    timeline: [
      event("2026-07-28", "Date of service", { source: "Combined sources" }),
      event("2026-08-03", "Claim created", {
        procedures: ["A9596", "J7999"],
        cptActivity: [{ procedure: "A9596", lineCount: 1, posted: 0, received: 0 }],
      }),
      event("2026-08-21", "Claim adjudicated", {
        amount: 650,
        paymentAuthority: "era",
        procedures: ["A9596", "J7999"],
        cptActivity: [{
          procedure: "A9596",
          lineCount: 1,
          billed: 577.5,
          allowed: 0,
          posted: 0,
          received: 0,
          adjustments: ["CO252: Documentation required"],
        }],
      }),
      event("2026-08-26", "Posted payment", {
        amount: 650,
        countedPayment: 650,
        paymentAuthority: "posted",
        procedures: ["A9596", "J7999"],
        cptActivity: [{ procedure: "A9596", lineCount: 1, posted: 50, received: 0 }],
      }),
      event("2026-08-26", "Posted payment", {
        amount: 600,
        countedPayment: 600,
        paymentAuthority: "posted",
        procedures: ["J7999"],
        cptActivity: [{ procedure: "J7999", lineCount: 1, posted: 600, received: 0 }],
      }),
    ],
  };

  const scoped = scopeClaimDataToProcedure(data, "A9596");
  assert.equal(scoped.procedureScope.relevantRecordCount, 3);
  assert.equal(scoped.procedureScope.contextCount, 1);
  assert.equal(scoped.summary.charges, 577.5);
  assert.equal(scoped.summary.totalPaid, 50);
  assert.equal(scoped.summary.receivedPaid, 0);
  assert.equal(scoped.timeline.some((item) => item.procedures?.includes("J7999") && !item.procedures.includes("A9596")), false);
  assert.match(scoped.timeline.find((item) => item.paymentAuthority === "era").description, /Billed \$577\.50/);
  assert.match(scoped.timeline.find((item) => item.paymentAuthority === "era").description, /CO252/);
  assert.match(scoped.timeline.find((item) => item.paymentAuthority === "posted").description, /Posted \$50\.00/);

  const story = buildClaimStory(scoped, { selectedProcedure: "A9596" });
  assert.ok(story.some((item) => item.title === "Payer response: no payment — A9596"));
  assert.ok(story.some((item) => item.title === "Payment posted internally — A9596" && item.amount === 50));
});
