// The selected stream drives every total and CPT series; receipt-only claims
// must never fall back to ERA amounts in the posted view.
export function paymentViewData(data, paymentView = "posted") {
  return {
    ...data, paymentView,
    summary: { ...data.summary, totalPaid: paymentView === "received" ? data.summary.receivedPaid : data.summary.totalPaid },
    timeline: (data.timeline || []).map((event) => paymentView === "received" ? {
      ...event, countedPayment: event.receivedPayment || 0, cptPayments: event.cptReceived || [],
    } : event),
  };
}

function dateOnly(value) {
  const candidate = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function buildStepPath(points, positionForPoint, yScale, left, right) {
  if (!points.length) return "";

  let previous = numberValue(points[0].cumulative) - numberValue(points[0].delta);
  let currentX = left;
  const commands = [`M ${left} ${yScale(previous)}`];
  for (const [index, point] of points.entries()) {
    const x = positionForPoint(point, index);
    if (x !== currentX) commands.push(`L ${x} ${yScale(previous)}`);
    const cumulative = numberValue(point.cumulative);
    if (Math.abs(cumulative - previous) >= 0.000001) {
      commands.push(`L ${x} ${yScale(cumulative)}`);
    }
    previous = cumulative;
    currentX = x;
  }
  if (currentX !== right) commands.push(`L ${right} ${yScale(previous)}`);
  return commands.join(" ");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function procedureCodes(value) {
  return String(value ?? "")
    .split(",")
    .map((procedure) => procedure.trim().toUpperCase())
    .filter((procedure) => procedure && procedure !== "NOT PROVIDED");
}

function eventLabel(event) {
  if (event.eventType === "salesforce-comment") {
    return `${event.commentOrder}. ${event.categoryLabel || event.title || "Salesforce comment"}`;
  }
  if (event.submissionReference) {
    return `Submission / correction / rebill ${event.submissionReference}`;
  }
  return event.title || "Claim activity";
}

function eventKind(event) {
  if (event.eventType === "salesforce-comment") return "comment";
  const title = String(event.title ?? "").toLowerCase();
  if (/payment|paid|adjudicat|revers/.test(title)) return "payment";
  if (event.submissionReference || /submission|correction|rebill/.test(title)) return "submission";
  if (/date of service/.test(title)) return "service";
  return "lifecycle";
}

function primaryKind(events) {
  const kinds = new Set(events.map(eventKind));
  for (const kind of ["payment", "submission", "comment", "lifecycle", "service"]) {
    if (kinds.has(kind)) return kind;
  }
  return "lifecycle";
}

function majorEventMarkers(group, cptDelta, paymentView = "posted") {
  const events = group?.events || [];
  const markers = [];
  const rebillEvents = events.filter((event) => {
    const title = String(event.title || "");
    return Boolean(event.submissionReference) || /re[- ]?bill|corrected claim|correction/i.test(title);
  });
  const denialEvents = events.filter((event) => {
    const title = String(event.title || "");
    return event.status === "danger"
      || event.category === "denial_or_pending"
      || /denial|denied|reject|no payment/i.test(title);
  });

  if (rebillEvents.length) {
    markers.push({
      kind: "rebill",
      label: unique(rebillEvents.map(eventLabel)).join("; ") || "Claim corrected or rebilled",
    });
  }
  if (Math.abs(cptDelta) >= 0.005) {
    markers.push({
      kind: "payment",
      label: cptDelta < 0 ? "CPT payment reversed" : paymentView === "received" ? "CPT payment received" : "CPT posted payment",
    });
  }
  if (denialEvents.length) {
    markers.push({
      kind: "denial",
      label: unique(denialEvents.map(eventLabel)).join("; ") || "Claim denied or rejected",
    });
  }
  return markers;
}

export function buildPaymentChartModel(data) {
  const byDate = new Map();
  for (const event of data?.timeline || []) {
    const date = dateOnly(event.date);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, { date, events: [], delta: 0 });
    const group = byDate.get(date);
    group.events.push(event);
    group.delta += numberValue(event.countedPayment);
  }

  let cumulative = 0;
  const eventGroups = [...byDate.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((group) => {
      group.events.sort((left, right) => {
        const leftTime = String(left.occurredAt || left.date || "");
        const rightTime = String(right.occurredAt || right.date || "");
        return leftTime.localeCompare(rightTime)
          || Number(left.commentOrder || 0) - Number(right.commentOrder || 0);
      });
      cumulative = Number((cumulative + group.delta).toFixed(2));
      const commentCategories = unique(group.events
        .filter((event) => event.eventType === "salesforce-comment")
        .map((event) => event.category));
      return {
        date: group.date,
        delta: Number(group.delta.toFixed(2)),
        cumulative,
        kind: primaryKind(group.events),
        primaryCategory: commentCategories[0] || null,
        commentCategories,
        labels: unique(group.events.map(eventLabel)),
        events: group.events,
      };
    });

  const reportedTotal = numberValue(data?.summary?.totalPaid);
  const plottedTotal = eventGroups.at(-1)?.cumulative || 0;
  return {
    charges: numberValue(data?.summary?.charges),
    reportedTotal,
    plottedTotal,
    unplottedAmount: Number((reportedTotal - plottedTotal).toFixed(2)),
    eventGroups,
    paymentPoints: eventGroups.map(({ date, delta, cumulative }) => ({
      date,
      delta,
      cumulative,
    })),
  };
}

export function buildCptPaymentModels(data, eventGroups = buildPaymentChartModel(data).eventGroups) {
  const byProcedure = new Map();

  function ensureProcedure(procedureValue) {
    const procedure = String(procedureValue || "Uncoded").trim().toUpperCase() || "Uncoded";
    if (!byProcedure.has(procedure)) {
      byProcedure.set(procedure, {
        procedure,
        charge: 0,
        deltasByDate: new Map(),
      });
    }
    return byProcedure.get(procedure);
  }

  for (const procedure of procedureCodes(data?.claim?.procedure)) ensureProcedure(procedure);
  for (const cpt of data?.cptFinancials || []) {
    const model = ensureProcedure(cpt.procedure);
    model.charge = Math.max(model.charge, numberValue(cpt.charged));
  }

  const timelineCptPayments = (data?.timeline || [])
    .filter((event) => dateOnly(event.date) && (event.cptPayments || []).length);

  if (timelineCptPayments.length) {
    for (const event of timelineCptPayments) {
      const date = dateOnly(event.date);
      for (const payment of event.cptPayments) {
        const model = ensureProcedure(payment.procedure);
        model.deltasByDate.set(
          date,
          numberValue(model.deltasByDate.get(date)) + numberValue(payment.paid),
        );
      }
    }
  }

  for (const era of data?.eras || []) {
    const date = dateOnly(era.date);
    const recordTotals = new Map();

    for (const line of era.serviceLines || []) {
      const procedure = String(line.procedure || "UNALLOCATED").trim().toUpperCase() || "UNALLOCATED";
      const procedureModel = ensureProcedure(procedure);
      procedureModel.charge = Math.max(
        procedureModel.charge,
        numberValue(line.billed),
      );
      if (!date) continue;
      if (!recordTotals.has(procedure)) recordTotals.set(procedure, { charged: 0, paid: 0 });
      const totals = recordTotals.get(procedure);
      totals.charged += numberValue(line.billed);
      if (data.paymentView === "received" && !timelineCptPayments.length) totals.paid += numberValue(line.paid);
    }

    for (const [procedure, totals] of recordTotals) {
      const model = ensureProcedure(procedure);
      model.charge = Math.max(model.charge, totals.charged);
      model.deltasByDate.set(
        date,
        numberValue(model.deltasByDate.get(date)) + totals.paid,
      );
    }
  }

  return [...byProcedure.values()]
    .map((model) => {
      let cumulative = 0;
      const points = eventGroups.map((group, index) => {
        const delta = numberValue(model.deltasByDate.get(group.date));
        cumulative = Number((cumulative + delta).toFixed(2));
        return {
          index,
          date: group.date,
          delta,
          cumulative,
          labels: group.labels || [],
          markers: majorEventMarkers(group, delta, data.paymentView),
        };
      });
      return {
        procedure: model.procedure,
        charge: Number(model.charge.toFixed(2)),
        totalPaid: points.at(-1)?.cumulative || 0,
        points,
      };
    })
    .sort((left, right) => right.charge - left.charge
      || Math.abs(right.totalPaid) - Math.abs(left.totalPaid)
      || left.procedure.localeCompare(right.procedure));
}

export function buildAggregateCptPaymentModel(models) {
  if (!models.length) return null;

  let cumulative = 0;
  const pointCount = Math.max(...models.map((model) => model.points.length));
  const points = Array.from({ length: pointCount }, (_, index) => {
    const sourcePoints = models.map((model) => model.points[index]).filter(Boolean);
    const delta = Number(sourcePoints
      .reduce((total, point) => total + numberValue(point.delta), 0)
      .toFixed(2));
    cumulative = Number((cumulative + delta).toFixed(2));

    const markersByKind = new Map();
    for (const point of sourcePoints) {
      for (const marker of point.markers || []) {
        if (marker.kind === "payment") continue;
        if (!markersByKind.has(marker.kind)) markersByKind.set(marker.kind, []);
        markersByKind.get(marker.kind).push(marker.label);
      }
    }

    const markers = [];
    if (markersByKind.has("rebill")) {
      markers.push({ kind: "rebill", label: unique(markersByKind.get("rebill")).join("; ") });
    }
    if (Math.abs(delta) >= 0.005) {
      markers.push({
        kind: "payment",
        label: delta < 0 ? "Payment reversed across all CPTs" : models[0]?.paymentView === "received" ? "Payment received across all CPTs" : "Posted payment across all CPTs",
      });
    }
    if (markersByKind.has("denial")) {
      markers.push({ kind: "denial", label: unique(markersByKind.get("denial")).join("; ") });
    }

    return {
      index,
      date: sourcePoints[0]?.date || null,
      delta,
      cumulative,
      labels: unique(sourcePoints.flatMap((point) => point.labels || [])),
      markers,
    };
  });

  return {
    procedure: "All CPTs",
    isAggregate: true,
    charge: Number(models.reduce((total, model) => total + numberValue(model.charge), 0).toFixed(2)),
    totalPaid: points.at(-1)?.cumulative || 0,
    points,
  };
}

export function buildCptPaidSnapshot(models, eventGroups, hoveredIndex = null) {
  const hovering = Number.isInteger(hoveredIndex)
    && hoveredIndex >= 0
    && hoveredIndex < eventGroups.length;
  const displayIndex = hovering ? hoveredIndex : Math.max(0, eventGroups.length - 1);

  return {
    hovering,
    date: hovering ? eventGroups[displayIndex]?.date || null : null,
    items: models.map((model) => ({
      procedure: model.procedure,
      paid: hovering
        ? numberValue(model.points[displayIndex]?.cumulative)
        : numberValue(model.totalPaid),
    })),
  };
}

export function selectNonOverlappingDateTicks(groups, positionForDate, minimumSpacing = 112) {
  if (groups.length <= 2) return groups;
  const selected = [groups[0]];
  const finalGroup = groups.at(-1);
  let lastPosition = positionForDate(groups[0].date);
  const finalPosition = positionForDate(finalGroup.date);

  for (const group of groups.slice(1, -1)) {
    const position = positionForDate(group.date);
    if (position - lastPosition < minimumSpacing) continue;
    if (finalPosition - position < minimumSpacing) continue;
    selected.push(group);
    lastPosition = position;
  }
  selected.push(finalGroup);
  return selected;
}
