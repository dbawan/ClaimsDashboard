import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StateCard } from "../../components/StateCard.jsx";
import { fetchClaimLifecycle, fetchClaimRealtime } from "./api.js";
import { ClaimDetailDrawer } from "./ClaimDetailDrawer.jsx";
import { ClaimBottomDock } from "./ClaimBottomDock.jsx";
import { ClaimPaymentChart } from "./ClaimPaymentChart.jsx";
import { ClaimProgressBar } from "./ClaimProgressBar.jsx";
import { ClaimSearchForm } from "./ClaimSearchForm.jsx";
import { ClaimSummary } from "./ClaimSummary.jsx";
import { claimIdFromLocation, replaceCurrentClaimUrl } from "./claimNavigation.js";
import { ClaimIcuWorkspace } from "../highLevel/ClaimIcuWorkspace.jsx";

export function ClaimSearchPage({ permissions = {} }) {
  const initialClaimId = useRef(claimIdFromLocation()).current;
  const [claimId, setClaimId] = useState(initialClaimId);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activePanel, setActivePanel] = useState(null);
  const [panelOrigin, setPanelOrigin] = useState(null);
  const [cptPaymentSnapshot, setCptPaymentSnapshot] = useState(null);
  const [selectedCptProcedure, setSelectedCptProcedure] = useState(null);
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
    const trimmed = String(value || "").trim();
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
    setSelectedCptProcedure(null);
    setLoading(true);
    replaceCurrentClaimUrl(trimmed);

    try {
      const nextData = await fetchClaimLifecycle(trimmed, { signal: controller.signal });
      const needsRealtime = Boolean(
        nextData.access?.claimOverview || nextData.access?.supportingRecords,
      );
      setData({ ...nextData, realtimePending: needsRealtime, searchReference: trimmed });
      window.requestAnimationFrame(() => resultRef.current?.focus());
      if (needsRealtime) {
        void fetchClaimRealtime(trimmed, { signal: controller.signal })
          .then((realtimeData) => {
            if (requestRef.current === controller && !controller.signal.aborted) {
              setData({ ...realtimeData, realtimePending: false, searchReference: trimmed });
            }
          })
          .catch((realtimeError) => {
            if (realtimeError.name === "AbortError") return;
            if (requestRef.current === controller) {
              setData((current) => current?.claim?.claimId === nextData.claim?.claimId
                ? { ...current, realtimePending: false, searchReference: trimmed }
                : current);
            }
          });
      }
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

  function selectPatientClaim(selectedClaimId) {
    setClaimId(selectedClaimId);
    void loadClaim(selectedClaimId);
  }

  function openRecordPanel(panel, origin) {
    setPanelOrigin(origin);
    setActivePanel(panel);
  }

  async function refreshLoadedClaim() {
    const loadedClaimId = data?.claim?.claimId;
    if (!loadedClaimId) return;
    const searchReference = data.searchReference || loadedClaimId;
    const nextData = await fetchClaimRealtime(searchReference);
    setData({ ...nextData, realtimePending: false, searchReference });
  }

  return (
    <>
      {searchHost ? createPortal(
        <ClaimSearchForm
          value={claimId}
          onChange={updateClaimId}
          onSubmit={handleSubmit}
          onClaimSelect={selectPatientClaim}
          loading={loading}
          error={fieldError}
          canViewFinancials={Boolean(permissions.paymentsAndEra)}
        />,
        searchHost,
      ) : null}

      <div className={`page-container claim-page${data?.access?.claimOverview ? " claim-page-with-progress" : ""}`}>
      {data?.access?.claimOverview ? <ClaimProgressBar progress={data.progress} /> : null}
      <div className="result-region" ref={resultRef} tabIndex="-1" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <section className="loading-card" role="status">
            <span className="loading-mark" aria-hidden="true"><span /></span>
            <div>
              <p className="section-kicker">Secure read-only lookup</p>
              <h2>Building the claim workspace</h2>
              <p>Loading the claim sections this account is permitted to view.</p>
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

        {!loading && !error && !data && permissions.highLevelOperations ? (
          <ClaimIcuWorkspace embedded onClaimSelect={selectPatientClaim} />
        ) : null}

        {!loading && !error && !data && !permissions.highLevelOperations ? (
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
              <p>Search by claim reference or patient name above to load your permitted claim sections.</p>
              <div className="empty-source-row" aria-label="Sources reconciled">
                {permissions.claimOverview ? <span>Claim overview</span> : null}
                {permissions.claimOverview && permissions.paymentsAndEra ? <i /> : null}
                {permissions.paymentsAndEra ? <span>Payments &amp; ERA</span> : null}
                {(permissions.claimOverview || permissions.paymentsAndEra) && permissions.supportingRecords ? <i /> : null}
                {permissions.supportingRecords ? <span>Supporting records</span> : null}
              </div>
            </div>
            <aside className="empty-checklist">
              <p className="section-kicker">What appears here</p>
              <ul>
                {permissions.claimOverview ? <li><span>1</span><div><strong>Claim overview</strong><small>Patient, status and lifecycle</small></div></li> : null}
                {permissions.paymentsAndEra ? <li><span>2</span><div><strong>Payments &amp; ERA</strong><small>Charges, payments and remittances</small></div></li> : null}
                {permissions.supportingRecords ? <li><span>3</span><div><strong>Supporting records</strong><small>Authorizations, notes and invoices</small></div></li> : null}
              </ul>
            </aside>
          </section>
        ) : null}

        {!loading && data ? (
          <div className={`claim-results${data.access?.paymentsAndEra ? "" : " claim-results-single"}`}>
            <ClaimSummary
              data={data}
              cptPaymentSnapshot={cptPaymentSnapshot}
              onOpenPanel={openRecordPanel}
            />
            {data.access?.paymentsAndEra ? (
              <ClaimPaymentChart
                data={data}
                selectedProcedure={selectedCptProcedure}
                onSelectedProcedureChange={setSelectedCptProcedure}
                onCptPaymentSnapshotChange={setCptPaymentSnapshot}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {data && activePanel ? (
        <ClaimDetailDrawer
          data={data}
          activePanel={activePanel}
          origin={panelOrigin}
          selectedProcedure={selectedCptProcedure}
          onChangePanel={setActivePanel}
          onClose={() => {
            setActivePanel(null);
            setPanelOrigin(null);
          }}
        />
      ) : null}
      {data?.access?.supportingRecords || data?.access?.worklistAccess || data?.access?.worklistManagement ? (
        <ClaimBottomDock data={data} onRefresh={refreshLoadedClaim} />
      ) : null}
      </div>
    </>
  );
}
