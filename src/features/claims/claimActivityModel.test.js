import test from "node:test";
import assert from "node:assert/strict";
import { buildAppealRebillItems } from "./claimActivityModel.js";

test("appeal and rebill activity is listed chronologically with dates and references", () => {
  const items = buildAppealRebillItems({
    timeline: [
      { id: "other", date: "2026-01-01", title: "Claim created" },
      {
        id: "appeal-follow-up",
        date: "2026-02-12",
        occurredAt: "2026-02-12T16:00:00.000Z",
        category: "appeal_follow_up_or_status",
        categoryLabel: "Appeal follow-up / status",
      },
      {
        id: "rebill",
        date: "2026-02-05",
        title: "Submission/correction/rebill observed",
        submissionReference: "90001B",
      },
      {
        id: "payment-with-reference",
        date: "2026-02-06",
        title: "Payment received",
        description: "Payment was associated with submission/rebill ref 90001B.",
        submissionReference: "90001B",
      },
      {
        id: "appeal",
        date: "2026-02-10",
        category: "appeal_submitted",
        categoryLabel: "Appeal submitted",
      },
    ],
  });

  assert.deepEqual(items.map((item) => [item.type, item.date, item.label, item.reference]), [
    ["rebill", "2026-02-05", "Rebill 90001B", "90001B"],
    ["appeal", "2026-02-10", "Appeal submitted", null],
    ["appeal", "2026-02-12", "Appeal follow-up / status", null],
  ]);
});
