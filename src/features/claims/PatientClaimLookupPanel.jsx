import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPatientClaims } from "./api.js";
import { claimWorkspaceUrl } from "./claimNavigation.js";

const calendarDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value) {
  if (!value) return "Date unavailable";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return String(value);
  return calendarDate.format(new Date(Date.UTC(year, month - 1, day)));
}

function normalizeProcedureCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isProcedureCode(value) {
  return /^(?:\d{5}|[A-Z]\d{4}|\d{4}[A-Z])$/.test(value);
}

function currentClaimCodes(data) {
  return [...new Set(
    String(data.claim?.procedure || "")
      .split(",")
      .map(normalizeProcedureCode)
      .filter(isProcedureCode),
  )].slice(0, 8);
}

function ClaimResult({ claim, currentClaimId }) {
  const codes = claim.procedureCodes || [];
  return (
    <li>
      <a
        className="patient-claim-result"
        href={claimWorkspaceUrl(claim.claimId)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open claim ${claim.claimId} in a new tab`}
      >
        <span className="patient-claim-result-marker" aria-hidden="true">↗</span>
        <span className="patient-claim-result-main">
          <span className="patient-claim-result-heading">
            <span>
              <small>Claim</small>
              <strong>{claim.claimId}</strong>
            </span>
            {claim.claimId === currentClaimId ? <em>Current claim</em> : null}
          </span>
          <span className="patient-claim-result-status">{claim.status || "Claim located"}</span>
          <span className="patient-claim-result-context">
            {[claim.payer, claim.provider, claim.location].filter(Boolean).join(" · ") || "Claim details available"}
          </span>
        </span>
        <span className="patient-claim-result-date">
          <small>Service date</small>
          <strong>{formatDate(claim.serviceDate)}</strong>
          <span>Last activity {formatDate(claim.lastActivityDate)}</span>
        </span>
        <span className="patient-claim-result-codes" aria-label="Procedure codes on claim">
          {codes.map((code) => (
            <b className={code === claim.matchedCode ? "patient-claim-code-match" : ""} key={code}>
              {code}
            </b>
          ))}
        </span>
      </a>
    </li>
  );
}

export function PatientClaimLookupPanel({
  data,
  mode,
  inactive,
  onOpen,
  onCollapse,
  closeRef,
  tabRef,
}) {
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(null);
  const inputRef = useRef(null);
  const suggestions = useMemo(() => currentClaimCodes(data), [data]);

  useEffect(() => {
    requestRef.current?.abort();
    setCode("");
    setResult(null);
    setError("");
    setLoading(false);
  }, [data.claim?.claimId]);

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    if (mode === "expanded") window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [mode]);

  async function runSearch(value) {
    const normalized = normalizeProcedureCode(value);
    setCode(normalized);
    if (!isProcedureCode(normalized)) {
      setError("Enter a 5-character CPT or HCPCS code, such as 78815, A9607, or J2405.");
      setResult(null);
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setError("");
    setResult(null);
    setLoading(true);
    try {
      const nextResult = await fetchPatientClaims(data.claim.claimId, normalized, {
        signal: controller.signal,
      });
      setResult(nextResult);
    } catch (nextError) {
      if (nextError.name !== "AbortError") setError(nextError.message);
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    void runSearch(code);
  }

  return (
    <aside
      className={`claim-dock-panel claim-dock-panel-patient-lookup claim-dock-panel-${mode}`}
      role={mode === "expanded" ? "dialog" : "complementary"}
      aria-modal={mode === "expanded" ? "true" : undefined}
      aria-hidden={inactive || undefined}
      aria-label={mode === "expanded" ? undefined : "Patient Claim Lookup"}
      aria-labelledby={mode === "expanded" ? "patient-claim-lookup-heading" : undefined}
    >
      {mode === "collapsed" ? (
        <button ref={tabRef} className="claim-dock-tab" type="button" onClick={onOpen} aria-expanded="false">
          <span className="claim-dock-tab-icon" aria-hidden="true">⌕</span>
          <span><strong>Patient Claim Lookup</strong><small>CPT · A · J</small></span>
          <i aria-hidden="true">⌃</i>
        </button>
      ) : null}

      {mode === "expanded" ? (
        <div className="claim-dock-expanded patient-claim-lookup-expanded">
          <header className="claim-dock-header">
            <div>
              <p>Patient-scoped search</p>
              <h2 id="patient-claim-lookup-heading">Patient Claim Lookup</h2>
              <span className="claim-dock-status">
                <i aria-hidden="true" /> {data.claim?.patientName || "Current patient"} · exact code match
              </span>
            </div>
            <button ref={closeRef} type="button" onClick={onCollapse} aria-label="Close Patient Claim Lookup">×</button>
          </header>

          <div className="patient-claim-lookup-body" aria-busy={loading}>
            <section className="patient-claim-search-rail" aria-labelledby="patient-claim-search-heading">
              <div>
                <p className="section-kicker">Search this patient only</p>
                <h3 id="patient-claim-search-heading">Find claims by procedure code</h3>
                <p>Enter an exact CPT or HCPCS code. Results never include claims from another patient.</p>
              </div>
              <form className="patient-claim-search-form" onSubmit={handleSubmit}>
                <label htmlFor="patient-claim-code">CPT, A-code, or J-code</label>
                <div>
                  <input
                    ref={inputRef}
                    id="patient-claim-code"
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value.toUpperCase());
                      if (error) setError("");
                    }}
                    placeholder="e.g. A9607"
                    inputMode="text"
                    autoComplete="off"
                    maxLength={12}
                    aria-describedby="patient-claim-code-help"
                  />
                  <button type="submit" disabled={loading}>{loading ? "Searching…" : "Search claims"}</button>
                </div>
                <small id="patient-claim-code-help">Exact 5-character code match</small>
              </form>
              {suggestions.length ? (
                <div className="patient-claim-suggestions">
                  <span>Codes on current claim</span>
                  <div>{suggestions.map((suggestion) => (
                    <button type="button" key={suggestion} onClick={() => void runSearch(suggestion)}>
                      {suggestion}
                    </button>
                  ))}</div>
                </div>
              ) : null}
              <div className="patient-claim-privacy-note">
                <span aria-hidden="true">✓</span>
                <p><strong>Patient identity locked</strong>Search uses the patient linked to claim {data.claim?.claimId}.</p>
              </div>
            </section>

            <section className="patient-claim-results" aria-live="polite">
              {loading ? (
                <div className="patient-claim-search-state">
                  <span className="patient-claim-loading" aria-hidden="true" />
                  <strong>Searching this patient’s claims</strong>
                  <p>Checking for an exact {normalizeProcedureCode(code)} procedure-code match.</p>
                </div>
              ) : error ? (
                <div className="patient-claim-search-state patient-claim-search-error" role="alert">
                  <span aria-hidden="true">!</span>
                  <strong>Lookup could not be completed</strong>
                  <p>{error}</p>
                </div>
              ) : result ? (
                <>
                  <header className="patient-claim-results-heading">
                    <div>
                      <p className="section-kicker">Exact match · {result.matchedCode}</p>
                      <h3>{result.total} claim{result.total === 1 ? "" : "s"} found</h3>
                    </div>
                    <span>Click a claim to open it in a new tab ↗</span>
                  </header>
                  {result.claims.length ? (
                    <ol className="patient-claim-results-list">
                      {result.claims.map((claim) => (
                        <ClaimResult claim={claim} currentClaimId={data.claim.claimId} key={claim.claimId} />
                      ))}
                    </ol>
                  ) : (
                    <div className="patient-claim-search-state">
                      <span aria-hidden="true">⌕</span>
                      <strong>No claims contain {result.matchedCode}</strong>
                      <p>Try another CPT, A-code, or J-code for this patient.</p>
                    </div>
                  )}
                  {result.hasMore ? <p className="patient-claim-result-limit">Showing the 100 most recent matching claims.</p> : null}
                </>
              ) : (
                <div className="patient-claim-search-state">
                  <span aria-hidden="true">⌕</span>
                  <strong>Ready to search</strong>
                  <p>Enter a code to find every matching claim for {data.claim?.patientName || "this patient"}.</p>
                </div>
              )}
            </section>
          </div>

          <footer className="claim-dock-footer">
            <span><i aria-hidden="true" /> SELECT-only patient lookup</span>
            <small>Exact patient identity + exact procedure code · claims open in a new tab</small>
          </footer>
        </div>
      ) : null}
    </aside>
  );
}
