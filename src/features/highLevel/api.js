function elapsedMs(startedAt) {
  return Math.round(performance.now() - startedAt);
}

async function fetchJson(path, { signal, debugLabel = "request", timeoutMs = 25_000 } = {}) {
  const startedAt = performance.now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  console.info(`[high-level:${debugLabel}] request:start`, { path });
  let response;
  try {
    response = await fetch(path, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: requestSignal,
    });
  } catch (error) {
    const details = {
      durationMs: elapsedMs(startedAt),
      name: error?.name || "Error",
      message: error?.message || "Unknown error",
    };
    if (error.name === "TimeoutError") {
      console.error(`[high-level:${debugLabel}] request:timeout`, details);
      throw new Error("This view took too long to load. Retry in a moment.");
    }
    if (error.name === "AbortError") {
      console.info(`[high-level:${debugLabel}] request:aborted`, details);
    } else {
      console.error(`[high-level:${debugLabel}] request:failed`, details);
    }
    throw error;
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`[high-level:${debugLabel}] response:error`, {
      durationMs: elapsedMs(startedAt),
      status: response.status,
      code: payload?.code || null,
    });
    const error = new Error(payload?.message || "The high-level data could not be loaded.");
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  console.info(`[high-level:${debugLabel}] response:complete`, {
    durationMs: elapsedMs(startedAt),
    status: response.status,
    itemCount: Array.isArray(payload?.items) ? payload.items.length : undefined,
    claimCount: Array.isArray(payload?.claims) ? payload.claims.length : undefined,
    scannedCount: payload?.scanned,
    truncated: payload?.truncated,
  });
  return payload;
}

export function fetchHighLevelClaims({ start, end, limit, sort }, options) {
  const query = new URLSearchParams({ start, end, limit: String(limit), sort });
  return fetchJson(`/api/high-level/claims?${query}`, { ...options, debugLabel: "claims" });
}

export function fetchHighLevelDashboard({ start, end, billingMode = "all", payers = [] }, options) {
  const query = new URLSearchParams({ start, end, billingMode });
  for (const payer of payers) query.append("payer", payer);
  return fetchJson(`/api/high-level/dashboard?${query}`, {
    ...options,
    debugLabel: "dashboard",
    timeoutMs: 45_000,
  });
}

export function fetchHighLevelQueue(mode, filters, options) {
  if (!new Set(["unsubmitted", "no-response"]).has(mode)) {
    throw new Error("Unknown high-level queue.");
  }
  const query = new URLSearchParams({
    start: filters?.start || "",
    end: filters?.end || "",
    order: filters?.order || "oldest",
    scope: mode === "unsubmitted" ? "all" : filters?.scope || "all",
  });
  return fetchJson(`/api/high-level/${mode}?${query}`, {
    ...options,
    debugLabel: mode,
    timeoutMs: mode === "no-response" ? 45_000 : 25_000,
  });
}
