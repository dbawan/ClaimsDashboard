import test from "node:test";
import assert from "node:assert/strict";
import {
  appointmentMinimumAge,
  buildHoverSnapshot,
  buildTrack,
  cptPaymentProgress,
  dateAtPosition,
  equalEventPosition,
  eventIndexForPosition,
  resolveDateRange,
} from "./highLevelModel.js";

test("CPT progress uses posted payments and handles overpayments, reversals and missing charges", () => {
  assert.deepEqual(cptPaymentProgress({ latestCharge: 500, posted: 300, received: 450 }), { percent: 60, width: 60, excess: 0 });
  assert.deepEqual(cptPaymentProgress({ latestCharge: 100, posted: 125 }), { percent: 125, width: 100, excess: 25 });
  assert.deepEqual(cptPaymentProgress({ latestCharge: 100, posted: -25 }), { percent: -25, width: 0, excess: 0 });
  for (const latestCharge of [0, null]) {
    assert.deepEqual(cptPaymentProgress({ latestCharge, posted: 25 }), { percent: null, width: 0, excess: 0 });
  }
});

test("appointment age filters support all, two weeks, and bounded custom days", () => {
  assert.equal(appointmentMinimumAge("all", 99), 0);
  assert.equal(appointmentMinimumAge("14", 99), 14);
  assert.equal(appointmentMinimumAge("custom", 21), 21);
  assert.equal(appointmentMinimumAge("custom", 0), 1);
  assert.equal(appointmentMinimumAge("custom", 4000), 3650);
});

const claim = {
  claimId: "78820",
  serviceDate: "2026-08-01",
  firstActivity: "2026-08-01",
  currentStatus: "paid",
  events: [
    { date: "2026-08-01", status: "created", label: "Created", procedure: "78802", charge: 1_000 },
    { date: "2026-08-05", status: "submitted", label: "Submitted", procedure: "78802", charge: 1_000 },
    { date: "2026-08-10", status: "paid", label: "Paid", procedure: "78802", charge: 1_000, amount: 300 },
    { date: "2026-08-10", status: "paid", label: "Paid", procedure: "78802", charge: 1_000, amount: 300 },
    { date: "2026-08-10", status: "paid", label: "Paid", procedure: "77300", charge: 500, amount: 125 },
  ],
};

test("claim track stops at the last event and consolidates same-day status markers", () => {
  const track = buildTrack(claim, "2026-08-01", "2026-08-31");

  assert.deepEqual(track.segments, [
    { start: "2026-08-01", end: "2026-08-05", status: "created" },
    { start: "2026-08-05", end: "2026-08-10", status: "pending" },
  ]);
  assert.equal(track.markers.length, 3);
  assert.equal(track.currentDate, "2026-08-10");
  assert.equal(track.currentStatus, "paid");
});

test("hover snapshot shows the status and CPT finances as of the cursor date", () => {
  const beforePayment = buildHoverSnapshot(claim, "2026-08-06");
  assert.equal(beforePayment.status, "pending");
  assert.deepEqual(beforePayment.procedures, [
    { procedure: "78802", charge: 1_000, paid: 0 },
  ]);

  const afterPayment = buildHoverSnapshot(claim, "2026-08-10");
  assert.equal(afterPayment.status, "paid");
  assert.deepEqual(afterPayment.procedures, [
    { procedure: "78802", charge: 1_000, paid: 300 },
    { procedure: "77300", charge: 500, paid: 125 },
  ]);
});

test("cursor position maps to the selected range date", () => {
  assert.equal(dateAtPosition(50, "2026-08-01", "2026-08-31"), "2026-08-16");
});

test("hovered events are distributed evenly and resolve to the nearest marker", () => {
  assert.deepEqual([0, 1, 2, 3].map((index) => equalEventPosition(index, 4)), [4, 34.666666666666664, 65.33333333333333, 96]);
  assert.equal(eventIndexForPosition(5, 4), 0);
  assert.equal(eventIndexForPosition(36, 4), 1);
  assert.equal(eventIndexForPosition(95, 4), 3);
});

test("claim date presets and custom ranges resolve to inclusive calendar windows", () => {
  assert.deepEqual(resolveDateRange("7", null, null, "2026-08-18"), {
    start: "2026-08-12",
    end: "2026-08-18",
  });
  assert.deepEqual(resolveDateRange("90", null, null, "2026-08-18"), {
    start: "2026-05-21",
    end: "2026-08-18",
  });
  assert.deepEqual(resolveDateRange("custom-days", null, 14, "2026-08-18"), {
    start: "2026-08-05",
    end: "2026-08-18",
  });
  assert.deepEqual(resolveDateRange("custom-dates", { start: "2026-01-10", end: "2026-02-20" }), {
    start: "2026-01-10",
    end: "2026-02-20",
  });
  assert.equal(resolveDateRange("custom-days", null, 0, "2026-08-18"), null);
  assert.equal(resolveDateRange("custom-dates", { start: "2026-03-01", end: "2026-02-01" }), null);
});
