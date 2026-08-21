import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAggregateCptPaymentModel,
  buildCptPaymentModels,
  buildCptPaidSnapshot,
  buildPaymentChartModel,
  buildStepPath,
  selectNonOverlappingDateTicks,
} from "./paymentChartModel.js";

test("payment paths stay flat between events and jump vertically for payments and recoupments", () => {
  const points = [
    { date: "2026-01-01", delta: 0, cumulative: 0 },
    { date: "2026-01-20", delta: 100, cumulative: 100 },
    { date: "2026-01-24", delta: -20, cumulative: 80 },
  ];
  const positions = new Map([
    ["2026-01-01", 10],
    ["2026-01-20", 50],
    ["2026-01-24", 90],
  ]);

  assert.equal(
    buildStepPath(points, (point) => positions.get(point.date), (value) => 120 - value, 10, 110),
    "M 10 120 L 50 120 L 50 20 L 90 20 L 90 40 L 110 40",
  );
});

test("chart model accumulates only counted payments and keeps charge total flat", () => {
  const model = buildPaymentChartModel({
    summary: { charges: 500, totalPaid: 130 },
    timeline: [
      { date: "2026-01-01", title: "Date of service", countedPayment: 0 },
      { date: "2026-01-03", title: "Claim created", countedPayment: 0 },
      { date: "2026-01-04", title: "Billed", countedPayment: 0 },
      { date: "2026-01-20", title: "Payment received", amount: 100, countedPayment: 100 },
      { date: "2026-01-22", title: "Applied payment", amount: 100, countedPayment: 0 },
      { date: "2026-01-24", title: "Payment reversed", amount: -20, countedPayment: -20 },
      { date: "2026-01-26", title: "Applied payment", amount: 50, countedPayment: 50 },
    ],
  });

  assert.equal(model.charges, 500);
  assert.deepEqual(
    model.paymentPoints.map((point) => [point.date, point.delta, point.cumulative]),
    [
      ["2026-01-01", 0, 0],
      ["2026-01-03", 0, 0],
      ["2026-01-04", 0, 0],
      ["2026-01-20", 100, 100],
      ["2026-01-22", 0, 100],
      ["2026-01-24", -20, 80],
      ["2026-01-26", 50, 130],
    ],
  );
  assert.equal(model.unplottedAmount, 0);
});

test("events on the same date share a marker and their counted payments are summed", () => {
  const model = buildPaymentChartModel({
    summary: { charges: 1_000, totalPaid: 175 },
    timeline: [
      { date: "2026-02-01", title: "Claim created", countedPayment: 0 },
      { date: "2026-02-10", title: "Payment received", countedPayment: 125 },
      {
        date: "2026-02-10",
        title: "Submission/correction/rebill observed",
        submissionReference: "90001B",
        countedPayment: 0,
      },
      { date: "2026-02-10", title: "Applied payment", countedPayment: 50 },
    ],
  });

  assert.equal(model.eventGroups.length, 2);
  assert.equal(model.eventGroups[1].delta, 175);
  assert.equal(model.eventGroups[1].cumulative, 175);
  assert.equal(model.eventGroups[1].kind, "payment");
  assert.ok(model.eventGroups[1].labels.includes("Submission / correction / rebill 90001B"));
});

test("axis tick selection removes labels that would overlap while preserving endpoints", () => {
  const groups = [
    { date: "2026-06-18", x: 0 },
    { date: "2026-07-11", x: 460 },
    { date: "2026-07-13", x: 500 },
    { date: "2026-07-14", x: 520 },
    { date: "2026-07-20", x: 700 },
  ];
  const selected = selectNonOverlappingDateTicks(groups, (date) =>
    groups.find((group) => group.date === date).x,
  );

  assert.deepEqual(selected.map((group) => group.date), [
    "2026-06-18",
    "2026-07-11",
    "2026-07-20",
  ]);
});

test("categorized Salesforce comments are graphed in timestamp order without changing payment totals", () => {
  const model = buildPaymentChartModel({
    summary: { charges: 1000, totalPaid: 100 },
    timeline: [
      { id: "payment", date: "2026-01-20", title: "Payment received", countedPayment: 100 },
      {
        id: "comment-2",
        date: "2026-01-10",
        occurredAt: "2026-01-10T15:00:00.000Z",
        title: "Appeal follow-up / status",
        eventType: "salesforce-comment",
        commentOrder: 2,
        category: "appeal_follow_up_or_status",
        categoryLabel: "Appeal follow-up / status",
        countedPayment: 0,
      },
      {
        id: "comment-1",
        date: "2026-01-10",
        occurredAt: "2026-01-10T14:00:00.000Z",
        title: "Appeal submitted",
        eventType: "salesforce-comment",
        commentOrder: 1,
        category: "appeal_submitted",
        categoryLabel: "Appeal submitted",
        countedPayment: 0,
      },
    ],
  });

  const commentDate = model.eventGroups[0];
  assert.equal(commentDate.kind, "comment");
  assert.equal(commentDate.primaryCategory, "appeal_submitted");
  assert.deepEqual(commentDate.labels, ["1. Appeal submitted", "2. Appeal follow-up / status"]);
  assert.deepEqual(commentDate.events.map((event) => event.id), ["comment-1", "comment-2"]);
  assert.equal(commentDate.cumulative, 0);
  assert.equal(model.reportedTotal, 100);
  assert.equal(model.plottedTotal, 100);
});

test("CPT payment models use highest observed charges and follow main graph dates", () => {
  const data = {
    summary: { charges: 1000, totalPaid: 225 },
    timeline: [
      { date: "2026-01-01", title: "Date of service", countedPayment: 0 },
      { date: "2026-01-20", title: "Payment received", countedPayment: 150 },
      { date: "2026-02-10", title: "Payment received", countedPayment: 75 },
    ],
    eras: [
      {
        date: "2026-01-20",
        serviceLines: [
          { procedure: "78802", billed: 500, paid: 100 },
          { procedure: "77300", billed: 700, paid: 50 },
        ],
      },
      {
        date: "2026-02-10",
        serviceLines: [
          { procedure: "78802", billed: 650, paid: 25 },
          { procedure: "77300", billed: 650, paid: 50 },
        ],
      },
    ],
  };
  const eventGroups = buildPaymentChartModel(data).eventGroups;
  const cpts = buildCptPaymentModels(data, eventGroups);

  assert.deepEqual(cpts.map((cpt) => cpt.procedure), ["77300", "78802"]);
  assert.equal(cpts[0].charge, 700);
  assert.deepEqual(cpts[0].points.map((point) => point.cumulative), [0, 50, 100]);
  assert.equal(cpts[1].charge, 650);
  assert.deepEqual(cpts[1].points.map((point) => point.cumulative), [0, 100, 125]);
});

test("CPT payment models preserve reversals", () => {
  const eventGroups = [
    { date: "2026-01-20" },
    { date: "2026-01-24" },
  ];
  const cpts = buildCptPaymentModels({
    eras: [
      { date: "2026-01-20", serviceLines: [{ procedure: "78835", billed: 900, paid: 300 }] },
      { date: "2026-01-24", serviceLines: [{ procedure: "78835", billed: 900, paid: -75 }] },
    ],
  }, eventGroups);

  assert.equal(cpts[0].totalPaid, 225);
  assert.deepEqual(cpts[0].points.map((point) => point.cumulative), [300, 225]);
});

test("aggregate CPT model sums every displayed CPT graph", () => {
  const models = [
    {
      procedure: "78802",
      charge: 650,
      totalPaid: 125,
      points: [
        { index: 0, date: "2026-01-01", delta: 0, cumulative: 0, markers: [] },
        { index: 1, date: "2026-01-20", delta: 100, cumulative: 100, markers: [{ kind: "payment", label: "CPT payment received" }] },
        { index: 2, date: "2026-01-24", delta: 25, cumulative: 125, markers: [{ kind: "payment", label: "CPT payment received" }] },
      ],
    },
    {
      procedure: "77300",
      charge: 700,
      totalPaid: 50,
      points: [
        { index: 0, date: "2026-01-01", delta: 0, cumulative: 0, markers: [] },
        { index: 1, date: "2026-01-20", delta: 75, cumulative: 75, markers: [{ kind: "payment", label: "CPT payment received" }] },
        { index: 2, date: "2026-01-24", delta: -25, cumulative: 50, markers: [{ kind: "payment", label: "CPT payment recouped" }] },
      ],
    },
  ];

  const aggregate = buildAggregateCptPaymentModel(models);

  assert.equal(aggregate.procedure, "All CPTs");
  assert.equal(aggregate.isAggregate, true);
  assert.equal(aggregate.charge, 1350);
  assert.equal(aggregate.totalPaid, 175);
  assert.deepEqual(aggregate.points.map((point) => [point.delta, point.cumulative]), [
    [0, 0],
    [175, 175],
    [0, 175],
  ]);
  assert.equal(aggregate.points[1].markers[0].label, "Payment received across all CPTs");
  assert.deepEqual(aggregate.points[2].markers, []);
});

test("CPT graphs carry rebill, payment, and denial markers on their dated points", () => {
  const data = {
    claim: { procedure: "78802" },
    timeline: [
      { date: "2026-01-01", title: "Claim created", countedPayment: 0 },
      {
        date: "2026-01-10",
        title: "Submission/correction/rebill observed",
        submissionReference: "90001B",
        countedPayment: 0,
      },
      {
        date: "2026-01-20",
        title: "Payment received",
        countedPayment: 100,
        cptPayments: [{ procedure: "78802", paid: 100 }],
      },
      {
        date: "2026-01-30",
        title: "Claim denied",
        status: "danger",
        countedPayment: 0,
      },
    ],
    eras: [],
  };
  const groups = buildPaymentChartModel(data).eventGroups;
  const [cpt] = buildCptPaymentModels(data, groups);

  assert.deepEqual(cpt.points.map((point) => point.markers.map((marker) => marker.kind)), [
    [],
    ["rebill"],
    ["payment"],
    ["denial"],
  ]);
  assert.match(cpt.points[1].markers[0].label, /90001B/);
  assert.equal(cpt.points[2].markers[0].label, "CPT payment received");
  assert.equal(cpt.points[3].markers[0].label, "Claim denied");
});

test("CPT sidebar snapshot shows current paid amounts until a graph date is hovered", () => {
  const eventGroups = [
    { date: "2026-01-01" },
    { date: "2026-01-20" },
    { date: "2026-02-10" },
  ];
  const cpts = buildCptPaymentModels({
    claim: { procedure: "78802, 77300, 77470" },
    eras: [
      { date: "2026-01-20", serviceLines: [{ procedure: "78802", billed: 500, paid: 100 }] },
      { date: "2026-02-10", serviceLines: [{ procedure: "78802", billed: 500, paid: 25 }] },
    ],
  }, eventGroups);

  assert.deepEqual(cpts.map((cpt) => cpt.procedure), ["78802", "77300", "77470"]);
  assert.deepEqual(
    buildCptPaidSnapshot(cpts, eventGroups).items.map((item) => [item.procedure, item.paid]),
    [["78802", 125], ["77300", 0], ["77470", 0]],
  );
  assert.deepEqual(buildCptPaidSnapshot(cpts, eventGroups, 1), {
    hovering: true,
    date: "2026-01-20",
    items: [
      { procedure: "78802", paid: 100 },
      { procedure: "77300", paid: 0 },
      { procedure: "77470", paid: 0 },
    ],
  });
});

test("CPT models include reconciled transaction fallback payments without an ERA", () => {
  const data = {
    claim: { procedure: "99205" },
    cptFinancials: [{ procedure: "99205", charged: 507.15 }],
    summary: { charges: 507.15, totalPaid: 131.32 },
    timeline: [
      { date: "2023-06-10", title: "Claim created", countedPayment: 0, cptPayments: [] },
      {
        date: "2023-06-19",
        title: "Applied payment",
        countedPayment: 131.32,
        cptPayments: [{ procedure: "99205", paid: 131.32 }],
      },
    ],
    eras: [],
  };
  const groups = buildPaymentChartModel(data).eventGroups;
  const cpts = buildCptPaymentModels(data, groups);

  assert.equal(cpts[0].procedure, "99205");
  assert.equal(cpts[0].charge, 507.15);
  assert.deepEqual(cpts[0].points.map((point) => point.cumulative), [0, 131.32]);
  assert.equal(cpts[0].totalPaid, 131.32);
});
