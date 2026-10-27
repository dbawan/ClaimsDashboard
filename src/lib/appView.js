export function appViewFromLocation(locationLike = window.location) {
  const url = new URL(typeof locationLike === "string" ? locationLike : locationLike.href);
  if (url.hash === "#high-level") return "high-level";
  if (url.searchParams.has("claim") || url.hash === "#claims") return "claims";
  return "high-level";
}
