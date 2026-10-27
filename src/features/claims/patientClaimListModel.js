function compareDate(left, right) {
  return String(right.serviceDate || right.lastActivityDate || "")
    .localeCompare(String(left.serviceDate || left.lastActivityDate || ""))
    || left.claimId.localeCompare(right.claimId);
}

function calendarDate(value = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addCalendarDays(value, days) {
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function patientClaimDateRange(dateRange = "30", {
  customStartDate = "",
  customEndDate = "",
  referenceDate = new Date(),
} = {}) {
  if (dateRange === "custom") {
    return {
      startDate: String(customStartDate || "").slice(0, 10),
      endDate: String(customEndDate || "").slice(0, 10),
    };
  }

  const endDate = calendarDate(referenceDate);
  const days = dateRange === "90" ? 90 : 30;
  return {
    startDate: addCalendarDays(endDate, -(days - 1)),
    endDate,
  };
}

export function filterAndSortPatientClaims(claims = [], {
  procedureQuery = "",
  sortBy = "date",
  startDate = "",
  endDate = "",
} = {}) {
  const normalizedQuery = String(procedureQuery).trim().toUpperCase();
  return claims.filter((claim) => {
    const serviceDate = String(claim.serviceDate || "").slice(0, 10);
    const matchesProcedure = !normalizedQuery || claim.procedureCodes?.some((code) => (
      String(code).toUpperCase().includes(normalizedQuery)
    ));
    const matchesStart = !startDate || (serviceDate && serviceDate >= startDate);
    const matchesEnd = !endDate || (serviceDate && serviceDate <= endDate);
    return matchesProcedure && matchesStart && matchesEnd;
  }).sort((left, right) => {
    if (sortBy === "billed") {
      return Number(right.billed || 0) - Number(left.billed || 0) || compareDate(left, right);
    }
    if (sortBy === "paid") {
      return Number(right.paid || 0) - Number(left.paid || 0) || compareDate(left, right);
    }
    return compareDate(left, right);
  });
}
