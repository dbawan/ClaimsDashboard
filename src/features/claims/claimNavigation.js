const CLAIM_QUERY_PARAMETER = "claim";

function locationUrl(locationLike) {
  if (typeof locationLike === "string") return locationLike;
  return locationLike.href;
}

export function claimIdFromLocation(locationLike = window.location) {
  const url = new URL(locationUrl(locationLike));
  return String(url.searchParams.get(CLAIM_QUERY_PARAMETER) || "").trim();
}

export function claimWorkspaceUrl(claimId, locationLike = window.location) {
  const url = new URL(locationUrl(locationLike));
  url.hash = "";
  url.searchParams.set(CLAIM_QUERY_PARAMETER, String(claimId || "").trim());
  return url.toString();
}

export function openClaimWorkspace(claimId) {
  window.open(claimWorkspaceUrl(claimId), "_blank", "noopener,noreferrer");
}

export function replaceCurrentClaimUrl(claimId) {
  window.history.replaceState(
    window.history.state,
    "",
    claimWorkspaceUrl(claimId),
  );
}
