import test from "node:test";
import assert from "node:assert/strict";
import { claimPaymentTiming } from "./claimPaymentTiming.js";

test("paid timing uses the first date cumulative payments reach the configured threshold", () => {
  const onePayment = claimPaymentTiming({
    createdAt: "2026-09-01",
    latestCharge: 1_000,
    payments: [{ date: "2026-09-05", amount: 500 }],
    thresholdPercent: 50,
  });
  const partialPayments = claimPaymentTiming({
    createdAt: "2026-09-01",
    latestCharge: 1_000,
    payments: [
      { date: "2026-09-04", amount: 250 },
      { date: "2026-09-10", amount: 250 },
    ],
    thresholdPercent: 50,
  });

  assert.deepEqual(onePayment, {
    paidThresholdPercent: 50,
    paidThresholdAmount: 500,
    paidThresholdDate: "2026-09-05",
    daysToPaid: 4,
  });
  assert.deepEqual(partialPayments, {
    paidThresholdPercent: 50,
    paidThresholdAmount: 500,
    paidThresholdDate: "2026-09-10",
    daysToPaid: 9,
  });
});

test("paid timing nets same-day activity and leaves an unreached threshold empty", () => {
  const result = claimPaymentTiming({
    createdAt: "2026-09-01",
    latestCharge: 1_000,
    payments: [
      { date: "2026-09-04", amount: 400 },
      { date: "2026-09-04", amount: -100 },
      { date: "2026-09-10", amount: 199.99 },
    ],
    thresholdPercent: 50,
  });

  assert.equal(result.paidThresholdAmount, 500);
  assert.equal(result.paidThresholdDate, null);
  assert.equal(result.daysToPaid, null);
});
