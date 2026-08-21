import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StateCard } from "../../components/StateCard.jsx";
import { fetchClaimLifecycle } from "./api.js";
import { ClaimDetailDrawer } from "./ClaimDetailDrawer.jsx";
import { ClaimBottomDock } from "./ClaimBottomDock.jsx";
import { ClaimPaymentChart } from "./ClaimPaymentChart.jsx";
import { ClaimProgressBar } from "./ClaimProgressBar.jsx";
import { ClaimSearchForm } from "./ClaimSearchForm.jsx";
import { ClaimSummary } from "./ClaimSummary.jsx";
import { claimIdFromLocation, replaceCurrentClaimUrl } from "./claimNavigation.js";

export function ClaimSearchPage() {
  const initialClaimId = useRef(claimIdFromLocation()).current;
  const [claimId, setClaimId] = useState(initialClaimId);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activePanel, setActivePanel] = useState(null);
  const [panelOrigin, setPanelOrigin] = useState(null);
  const [cptPaymentSnapshot, setCptPaymentSnapshot] = useState(null);
  const [searchHost, setSearchHost] = useState(null);
  const resultRef = useRef(null);
  const requestRef = useRef(null);

  useEffect(() => {
    if (initialClaimId) void loadClaim(initialClaimId);
    return () => requestRef.current?.abort();
  }, []);

  useEffect(() => {
    setSearchHost(document.getElementById("claim-header-search-host"));
  }, []);

  async function loadClaim(value) {
    const trimmed = value.trim();
    if (!trimmed) {
      setFieldError("Enter a claim ID.");
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setFieldError("");
    setError(null);
    setData(null);
    setActivePanel(null);
    setPanelOrigin(null);
    setCptPaymentSnapshot(null);
    setLoading(true);
    replaceCurrentClaimUrl(trimmed);

    try {
      const nextData = await fetchClaimLifecycle(trimmed, { signal: controller.signal });
      setData(nextData);
      window.requestAnimationFrame(() => resultRef.current?.focus());
    } catch (nextError) {
      if (nextError.name !== "AbortError") setError(nextError);
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    void loadClaim(claimId);
  }

  function updateClaimId(value) {
    setClaimId(value);
    if (fieldError) setFieldError("");
  }

  function openRecordPanel(panel, origin) {
    setPanelOrigin(origin);
    setActivePanel(panel);
  }

  return (
    <>
      {searchHost ? createPortal(
        <ClaimSearchForm
          value={claimId}
          onChange={updateClaimId}
          onSubmit={handleSubmit}
          loading={loading}
          error={fieldError}
        />,
        searchHost,
      ) : null}

      <div className={`page-container claim-page${data ? " claim-page-with-progress" : ""}`}>
      {data ? <ClaimProgressBar progress={data.progress} /> : null}
      <div className="result-region" ref={resultRef} tabIndex="-1" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <section className="loading-card" role="status">
            <span className="loading-mark" aria-hidden="true"><span /></span>
            <div>
              <p className="section-kicker">Secure read-only lookup</p>
              <h2>Building the claim workspace</h2>
              <p>Reconciling transactions, ERA records, and categorized activity.</p>
            </div>
          </section>
        ) : null}

        {!loading && error?.status === 403 ? (
          <StateCard
            tone="permission"
            title="Access unavailable"
            message="This account does not have permission to view claim lifecycle data."
          />
        ) : null}

        {!loading && error && error.status !== 403 ? (
          <StateCard
            tone="error"
            title={error.status === 404 ? "Claim not found" : "Claim search failed"}
            message={error.message}
            action={
              <button className="neutral-button" type="button" onClick={handleSubmit}>
                Try again
              </button>
            }
          />
        ) : null}

        {!loading && !error && !data ? (
          <section className="dashboard-empty" aria-labelledby="empty-workspace-heading">
            <div className="empty-visual" aria-hidden="true">
              <span className="empty-line empty-line-charges" />
              <span className="empty-line empty-line-paid" />
              <i className="empty-dot empty-dot-one" />
              <i className="empty-dot empty-dot-two" />
              <i className="empty-dot empty-dot-three" />
            </div>
            <div className="empty-copy">
              <span className="empty-number">01</span>
              <p className="section-kicker">Ready for lookup</p>
              <h2 id="empty-workspace-heading">Search once. See the whole claim.</h2>
              <p>
                Enter an encounter or remittance reference above. Payments, corrections, reasons,
                and source activity will resolve into this single workspace.
              </p>
              <div className="empty-source-row" aria-label="Sources reconciled">
                <span>Transactions</span><i /> <span>ClaimStatus ERA</span><i /> <span>EDI 835</span>
              </div>
            </div>
            <aside className="empty-checklist">
              <p className="section-kicker">What appears here</p>
              <ul>
                <li><span>1</span><div><strong>Financial progression</strong><small>Charges, payments, balance</small></div></li>
                <li><span>2</span><div><strong>Simplified claim story</strong><small>Each step follows the graph date</small></div></li>
                <li><span>3</span><div><strong>Deep record detail</strong><small>Available in focused side sheets</small></div></li>
              </ul>
            </aside>
          </section>
        ) : null}

        {!loading && data ? (
          <div className="claim-results">
            <ClaimSummary
              data={data}
              cptPaymentSnapshot={cptPaymentSnapshot}
              onOpenPanel={openRecordPanel}
            />
            <ClaimPaymentChart
              data={data}
              onCptPaymentSnapshotChange={setCptPaymentSnapshot}
            />
          </div>
        ) : null}
      </div>

      {data && activePanel ? (
        <ClaimDetailDrawer
          data={data}
          activePanel={activePanel}
          origin={panelOrigin}
          onChangePanel={setActivePanel}
          onClose={() => {
            setActivePanel(null);
            setPanelOrigin(null);
          }}
        />
      ) : null}
      {data ? <ClaimBottomDock data={data} /> : null}
      </div>
    </>
  );
}
