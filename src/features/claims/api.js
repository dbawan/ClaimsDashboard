export async function fetchClaimLifecycle(claimId, { signal } = {}) {
  const response = await fetch(`/api/claims/${encodeURIComponent(claimId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || "The claim could not be loaded.");
    error.status = response.status;
    error.code = payload?.code;
    error.claimIds = payload?.claimIds;
    throw error;
  }
  return payload;
}

