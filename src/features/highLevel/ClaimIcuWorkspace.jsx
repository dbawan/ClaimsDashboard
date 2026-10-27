import { useEffect, useRef, useState } from "react";
import { fetchHighLevelClaimIcu } from "./api.js";
import { ClaimIcu } from "./ClaimIcu.jsx";

export function ClaimIcuWorkspace({ onClaimSelect, embedded = false }) {
  const [limit, setLimit] = useState(25);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("deadline");
  const [includePastDeadline, setIncludePastDeadline] = useState(false);
  const [draftProcedureQuery, setDraftProcedureQuery] = useState("");
  const [procedureQuery, setProcedureQuery] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const requestRef = useRef(null);

  useEffect(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    void fetchHighLevelClaimIcu({ limit, page, sort, includePastDeadline, procedureQuery }, { signal: controller.signal })
      .then(setData)
      .catch((nextError) => {
        if (nextError.name !== "AbortError") setError(nextError.message);
      })
      .finally(() => {
        if (requestRef.current === controller) setLoading(false);
      });
    return () => controller.abort();
  }, [limit, page, sort, includePastDeadline, procedureQuery, retryKey]);

  return (
    <section className={`high-level-page claim-icu-workspace${embedded ? " claim-icu-workspace-embedded" : ""}`} aria-label="Claim ICU">
      <header className="high-level-toolbar claim-icu-workspace-toolbar">
        <div className="claim-icu-workspace-title">
          <span>Claims</span>
          <strong>Claim ICU</strong>
        </div>
        <form
          className="high-level-filters claim-icu-filters"
          aria-label="Claim ICU controls"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setProcedureQuery(draftProcedureQuery.trim().toUpperCase());
          }}
        >
          <label className="claim-icu-cpt-search">
            <span>CPT / HCPCS</span>
            <input
              type="search"
              value={draftProcedureQuery}
              onChange={(event) => setDraftProcedureQuery(event.target.value.toUpperCase())}
              placeholder="Exact code"
              aria-label="Search Claim ICU by exact CPT or HCPCS code"
              maxLength={20}
              pattern="[A-Za-z0-9.\-]{1,20}"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          <label className="claim-icu-priority">
            <span>Prioritize</span>
            <select value={sort} onChange={(event) => { setPage(1); setSort(event.target.value); }}>
              <option value="deadline">Filing limit days left</option>
              <option value="cpt-charged">Highest CPT billed amount</option>
            </select>
          </label>
          <label className="high-level-row-count">
            <span>Rows</span>
            <select value={limit} onChange={(event) => { setPage(1); setLimit(Number(event.target.value)); }}>
              <option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option>
            </select>
          </label>
          <label className="claim-icu-include-past">
            <input type="checkbox" checked={includePastDeadline} onChange={(event) => { setPage(1); setIncludePastDeadline(event.target.checked); }} />
            <span>Include past filing limits</span>
          </label>
          <button type="submit">Search</button>
        </form>
      </header>

      <div className="high-level-content" aria-live="polite" aria-busy={loading}>
        {loading ? <div className="high-level-state"><span className="high-level-spinner" />Prioritizing claims for review</div> : null}
        {!loading && error ? (
          <div className="high-level-state high-level-state-error">
            <strong>Unable to load Claim ICU</strong><span>{error}</span>
            <button type="button" onClick={() => setRetryKey((value) => value + 1)}>Retry</button>
          </div>
        ) : null}
        {!loading && !error && data ? <ClaimIcu data={data} onPageChange={setPage} onClaimSelect={onClaimSelect} /> : null}
      </div>
    </section>
  );
}
