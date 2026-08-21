import { readCategorizedClaim } from "../integrations/claimsApi.js";

export function attachClaimCategorization(lifecycle, result) {
  const sourceNames = [...lifecycle.provenance.sources];
  if (result.integration.status === "ready") sourceNames.push(result.integration.source);

  return {
    ...lifecycle,
    categorization: result.claim,
    categorizationIntegration: result.integration,
    provenance: {
      ...lifecycle.provenance,
      sources: [...new Set(sourceNames)],
    },
  };
}

export async function enrichClaimWithCategorization(lifecycle, options = {}) {
  const readClaim = options.readClaim || readCategorizedClaim;
  try {
    const result = await readClaim(lifecycle.claim.claimId);
    return attachClaimCategorization(lifecycle, result);
  } catch (error) {
    console.error("Claims API enrichment failed:", error?.code || error?.name || "unknown error");
    return attachClaimCategorization(lifecycle, {
      claim: null,
      integration: {
        status: "error",
        message: "The categorized claim data could not be loaded.",
        source: "RCM Claims API",
      },
    });
  }
}
