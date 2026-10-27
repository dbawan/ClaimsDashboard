import { pathWithinApp } from "../../lib/appPath.js";

export async function fetchClaimLifecycle(claimId, { signal } = {}) {
  const response = await fetch(pathWithinApp(`/api/claims/${encodeURIComponent(claimId)}`), {
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

export async function fetchClaimRealtime(claimId, { signal } = {}) {
  const response = await fetch(
    pathWithinApp(`/api/claims/${encodeURIComponent(claimId)}/realtime`),
    {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || "Live claim activity could not be loaded.");
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

export async function fetchPatientClaims(claimId, procedureCode, { signal } = {}) {
  const query = new URLSearchParams({ code: procedureCode });
  const response = await fetch(
    `${pathWithinApp(`/api/claims/${encodeURIComponent(claimId)}/patient-claims`)}?${query}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || "The patient claim lookup could not be completed.");
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

export async function fetchPatientSuggestions(query, { signal } = {}) {
  const search = new URLSearchParams({ q: query });
  const response = await fetch(
    `${pathWithinApp("/api/claims/patients/search")}?${search}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || "Patient recommendations could not be loaded.");
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

export async function fetchClaimsForPatient(patientId, {
  startDate,
  endDate,
  offset,
  procedureQuery,
  signal,
} = {}) {
  const query = new URLSearchParams();
  if (startDate) query.set("startDate", startDate);
  if (endDate) query.set("endDate", endDate);
  if (Number.isSafeInteger(offset) && offset > 0) query.set("offset", String(offset));
  if (procedureQuery) query.set("procedureQuery", procedureQuery);
  const search = query.toString();
  const response = await fetch(
    `${pathWithinApp(`/api/claims/patients/${encodeURIComponent(patientId)}/claims`)}${search ? `?${search}` : ""}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || "The patient's claims could not be loaded.");
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

async function worklistRequest(path, {
  method = "GET",
  body,
  headers,
  signal,
} = {}) {
  const response = await fetch(pathWithinApp(path), {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || "The worklist request could not be completed.");
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

export async function fetchWorklistTypes({ signal } = {}) {
  const payload = await worklistRequest("/api/claims/worklist-types", { signal });
  return payload.types || [];
}

export async function fetchClaimWorklist(claimId, { signal } = {}) {
  const worklists = await fetchClaimWorklists(claimId, { signal });
  return worklists[0] || null;
}

export async function fetchClaimWorklists(claimId, { signal } = {}) {
  const payload = await worklistRequest(
    `/api/claims/${encodeURIComponent(claimId)}/worklist`,
    { signal },
  );
  return payload.worklists || (payload.worklist ? [payload.worklist] : []);
}

export async function createWorklistType(input, { signal } = {}) {
  const payload = await worklistRequest("/api/claims/worklist-types", {
    method: "POST",
    body: input,
    signal,
  });
  return payload.type;
}

export async function removeWorklistType(typeId, { signal } = {}) {
  const payload = await worklistRequest(
    `/api/claims/worklist-types/${encodeURIComponent(typeId)}`,
    { method: "DELETE", signal },
  );
  return payload.type;
}

export async function assignClaimWorklist(claimId, worklistTypeId, { note = "", signal } = {}) {
  const payload = await worklistRequest(
    `/api/claims/${encodeURIComponent(claimId)}/worklist`,
    {
      method: "PUT",
      body: { worklistTypeId, note },
      headers: { "X-Idempotency-Key": globalThis.crypto.randomUUID() },
      signal,
    },
  );
  return payload;
}

export async function saveClaimWorklistChecks(claimId, worklistTypeId, checkedItemIds, { signal } = {}) {
  const payload = await worklistRequest(
    `/api/claims/${encodeURIComponent(claimId)}/worklist/checks`,
    {
      method: "PATCH",
      body: { worklistTypeId, checkedItemIds },
      signal,
    },
  );
  return payload.worklist;
}

export async function createSalesforceClaimNote(claimId, text, {
  idempotencyKey,
  signal,
} = {}) {
  const response = await fetch(
    pathWithinApp(`/api/claims/${encodeURIComponent(claimId)}/salesforce-notes`),
    {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ text }),
      cache: "no-store",
      signal,
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || "The Salesforce note could not be created.");
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}
