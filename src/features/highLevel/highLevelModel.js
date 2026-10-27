export const STATUS_LABELS = Object.freeze({
  created: "Created",
  submitted: "Submitted",
  pending: "Pending",
  action: "Action needed",
  paid: "Posted payment",
  received: "Payment received",
  "receipt-reversed": "Received payment reversed",
  reversed: "Reversed",
  processed: "Processed",
  activity: "Activity",
});

function dateTime(value) {
  return Date.parse(`${value}T00:00:00Z`);
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

export function resolveDateRange(mode, customDates, customDays, today) {
  if (mode === "custom-dates") {
    const start = String(customDates?.start || "");
    const end = String(customDates?.end || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return null;
    if (!Number.isFinite(dateTime(start)) || !Number.isFinite(dateTime(end))) return null;
    return { start, end };
  }

  const days = mode === "custom-days" ? Number(customDays) : Number(mode);
  const end = String(today || "");
  if (!Number.isInteger(days) || days < 1 || days > 3_650 || !Number.isFinite(dateTime(end))) return null;
  const start = new Date(dateTime(end));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: isoDate(start), end };
}

export function appointmentMinimumAge(filter, customDays) {
  if (filter === "14") return 14;
  if (filter !== "custom") return 0;
  const days = Math.floor(Number(customDays));
  if (!Number.isFinite(days)) return 1;
  return Math.max(1, Math.min(3_650, days));
}

export function positionForDate(value, start, end) {
  const startTime = dateTime(start);
  const endTime = dateTime(end);
  const valueTime = dateTime(value);
  if (!Number.isFinite(valueTime) || endTime <= startTime) return 0;
  return Math.max(0, Math.min(100, ((valueTime - startTime) / (endTime - startTime)) * 100));
}

export function dateAtPosition(percent, start, end) {
  const startTime = dateTime(start);
  const endTime = dateTime(end);
  const ratio = Math.max(0, Math.min(1, Number(percent) / 100));
  return isoDate(startTime + (endTime - startTime) * ratio);
}

export function equalEventPosition(index, count) {
  if (count <= 1) return 50;
  const safeIndex = Math.max(0, Math.min(count - 1, index));
  return 4 + (safeIndex / (count - 1)) * 92;
}

export function eventIndexForPosition(percent, count) {
  if (count <= 1) return 0;
  const ratio = Math.max(0, Math.min(1, (Number(percent) - 4) / 92));
  return Math.round(ratio * (count - 1));
}

export function nextTrackStatus(event, previous) {
  if (event.status === "submitted") return "pending";
  if (event.status === "received") return previous === "paid" ? previous : "received";
  if (event.status === "receipt-reversed") return "action";
  if (event.status === "reversed") return "action";
  if (event.status === "processed") return previous === "paid" ? "paid" : "action";
  if (event.status === "activity") return previous;
  return event.status;
}

export function buildTrack(claim, start, end) {
  const firstDate = [claim.serviceDate, claim.firstActivity, claim.events[0]?.date]
    .filter(Boolean).sort()[0] || start;
  const cursorStart = firstDate < start ? start : firstDate;
  const events = claim.events.filter((event) => event.date >= start && event.date <= end);
  const segments = [];
  const markers = [];
  const markerKeys = new Set();
  let cursor = cursorStart;
  let status = "created";

  for (const event of events) {
    if (event.date > cursor) segments.push({ start: cursor, end: event.date, status });
    cursor = event.date > cursor ? event.date : cursor;
    status = nextTrackStatus(event, status);
    const markerKey = `${event.date}|${event.status}|${event.label || ""}|${event.source || ""}`;
    if (!markerKeys.has(markerKey)) {
      markers.push(event);
      markerKeys.add(markerKey);
    }
  }

  return {
    events,
    markers,
    segments,
    currentDate: events.at(-1)?.date || cursorStart,
    currentStatus: claim.currentStatus || status,
  };
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function cptPaymentProgress(row) {
  const charge = row.latestCharge == null ? null : numberValue(row.latestCharge);
  const posted = numberValue(row.posted);
  const percent = charge > 0 ? (posted / charge) * 100 : null;
  return {
    percent,
    width: percent == null ? 0 : Math.max(0, Math.min(100, percent)),
    excess: charge > 0 ? Math.round(Math.max(0, posted - charge) * 100) / 100 : 0,
  };
}

export function buildHoverSnapshot(claim, date) {
  const events = claim.events.filter((event) => event.date <= date);
  let status = "created";
  for (const event of events) status = nextTrackStatus(event, status);

  const procedures = new Map();
  const paymentKeys = new Set();
  for (const event of events) {
    if (!event.procedure) continue;
    if (!procedures.has(event.procedure)) {
      procedures.set(event.procedure, { procedure: event.procedure, charge: 0, paid: 0 });
    }
    const procedure = procedures.get(event.procedure);
    if (event.charge != null) procedure.charge = Math.max(procedure.charge, numberValue(event.charge));
    if (["paid", "reversed"].includes(event.status) && event.source !== "payer" && event.amount != null) {
      const paymentKey = event.id || [event.date, event.procedure, event.status, event.amount, event.source].join("|");
      if (!paymentKeys.has(paymentKey)) {
        procedure.paid += numberValue(event.amount);
        paymentKeys.add(paymentKey);
      }
    }
  }

  return {
    date,
    status,
    lastEvent: events.at(-1) || null,
    procedures: [...procedures.values()]
      .map((procedure) => ({ ...procedure, paid: Number(procedure.paid.toFixed(2)) }))
      .sort((left, right) => right.charge - left.charge || left.procedure.localeCompare(right.procedure)),
  };
}
