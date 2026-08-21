export function normalizeIdentifier(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function submissionSuffix(encounterId, eraReference) {
  const encounter = normalizeIdentifier(encounterId);
  const reference = normalizeIdentifier(eraReference);
  if (!encounter || !reference || !reference.startsWith(encounter)) return null;

  const suffix = reference.slice(encounter.length);
  return /^[A-Z]*$/.test(suffix) ? suffix : null;
}

export function submissionOrder(suffix) {
  const normalized = normalizeIdentifier(suffix);
  if (!normalized) return 0;
  if (!/^[A-Z]+$/.test(normalized)) return Number.MAX_SAFE_INTEGER;

  let order = 0;
  for (const character of normalized) {
    order = order * 26 + character.charCodeAt(0) - 64;
  }
  return order;
}

export function submissionSuffixForOrder(value) {
  let order = Math.max(0, Math.floor(Number(value) || 0));
  let suffix = "";
  while (order > 0) {
    order -= 1;
    suffix = String.fromCharCode(65 + (order % 26)) + suffix;
    order = Math.floor(order / 26);
  }
  return suffix;
}

export function encounterCandidateFromEraReference(value) {
  const normalized = normalizeIdentifier(value);
  return normalized.match(/^(\d{4,})[A-Z]+$/)?.[1] || "";
}

export function normalizePatientName(value) {
  let normalized = String(value ?? "").trim().toUpperCase();
  if (!normalized) return "";
  if (normalized.includes(",")) {
    const [last, ...givenParts] = normalized.split(",");
    normalized = `${givenParts.join(" ")} ${last}`;
  }
  return normalized.match(/[A-Z0-9]+/g)?.join("") || "";
}

export function normalizeDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

export function moneyToCents(value) {
  if (value == null || value === "") return null;
  const number = Number(String(value).replaceAll(",", "").replace("$", ""));
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

export function centsToAmount(cents) {
  return Number((cents / 100).toFixed(2));
}

export function assertValidClaimSearch(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    const error = new Error("Enter a claim ID.");
    error.statusCode = 400;
    throw error;
  }
  if (raw.length > 80 || !/^[A-Za-z0-9._| -]+$/.test(raw)) {
    const error = new Error("Use a valid claim ID containing letters and numbers.");
    error.statusCode = 400;
    throw error;
  }
  return raw;
}
