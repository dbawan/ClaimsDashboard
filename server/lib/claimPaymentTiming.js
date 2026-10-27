const DAY_MS = 86_400_000;

function dateOnly(value) {
  const raw = String(value ?? "").trim();
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const candidate = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function thresholdPercentage(value) {
  const percentage = Number(value);
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    throw new RangeError("Paid threshold percentage must be greater than 0 and no more than 100");
  }
  return percentage;
}

function daysBetween(start, end) {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return Math.max(0, Math.floor((endTime - startTime) / DAY_MS));
}

export function claimPaymentTiming({
  createdAt,
  latestCharge,
  payments = [],
  thresholdPercent = 50,
}) {
  const percentage = thresholdPercentage(thresholdPercent);
  const creationDate = dateOnly(createdAt);
  const charge = Number(latestCharge);
  const thresholdAmount = Number.isFinite(charge) && charge > 0
    ? Number((charge * percentage / 100).toFixed(2))
    : null;
  const empty = {
    paidThresholdPercent: percentage,
    paidThresholdAmount: thresholdAmount,
    paidThresholdDate: null,
    daysToPaid: null,
  };
  if (!creationDate || thresholdAmount == null) return empty;

  const amountByDate = new Map();
  for (const payment of payments) {
    const paymentDate = dateOnly(payment?.date);
    const amount = Number(payment?.amount);
    if (!paymentDate || !Number.isFinite(amount) || amount === 0) continue;
    amountByDate.set(
      paymentDate,
      Number(((amountByDate.get(paymentDate) || 0) + amount).toFixed(2)),
    );
  }

  let cumulativePaid = 0;
  for (const [paymentDate, amount] of [...amountByDate].sort(([left], [right]) => left.localeCompare(right))) {
    cumulativePaid = Number((cumulativePaid + amount).toFixed(2));
    if (cumulativePaid + 0.001 < thresholdAmount) continue;
    return {
      ...empty,
      paidThresholdDate: paymentDate,
      daysToPaid: daysBetween(creationDate, paymentDate),
    };
  }

  return empty;
}
