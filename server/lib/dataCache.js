// General search snapshots retain the existing six-hour freshness window.
export const DATA_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

// Individual claim snapshots are retained for 24 hours from successful load completion.
export const CLAIM_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
