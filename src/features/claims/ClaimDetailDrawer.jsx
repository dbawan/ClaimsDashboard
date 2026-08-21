import { useEffect, useId, useRef, useState } from "react";
import { ClaimCategorizationPanel } from "./ClaimCategorizationPanel.jsx";
import { ClaimDetailPanel, formatDate, formatMoney } from "./ClaimSummary.jsx";
import { ClaimEraList } from "./ClaimEraList.jsx";
import { ClaimTimeline } from "./ClaimTimeline.jsx";

const PANELS = Object.freeze({
  categorization: { label: "Claim category", kicker: "RCM Claims API", icon: "01" },
  details: { label: "Claim details", kicker: "Reconciled record", icon: "02" },
  eras: { label: "ERA records", kicker: "Authoritative remittances", icon: "03" },
  timeline: { label: "All records", kicker: "Source-level history", icon: "04" },
});

function PreviewRows({ data, activePanel }) {
  if (activePanel === "categorization") {
    const claim = data.categorization;
    return (
      <span className="claim-record-preview-rows">
        <span><small>Category</small><strong>{claim?.category?.display || "Unavailable"}</strong></span>
        <span><small>Reason</small><strong>{claim?.reasonDisplay || claim?.normalizedReason || "Not provided"}</strong></span>
        <span><small>Confidence</small><strong>{claim?.confidence == null ? "—" : `${Math.round(claim.confidence * 100)}%`}</strong></span>
      </span>
    );
  }

  if (activePanel === "details") {
    return (
      <span className="claim-record-preview-rows">
        <span><small>Patient</small><strong>{data.claim.patientName || "Not provided"}</strong></span>
        <span><small>Service date</small><strong>{formatDate(data.claim.serviceDate)}</strong></span>
        <span><small>Status</small><strong>{data.claim.status || "Not provided"}</strong></span>
      </span>
    );
  }

  if (activePanel === "eras") {
    const latest = data.eras?.at(-1);
    return (
      <span className="claim-record-preview-rows">
        <span><small>Remittances</small><strong>{data.eras?.length || 0}</strong></span>
        <span><small>Latest</small><strong>{formatDate(latest?.date)}</strong></span>
        <span><small>Paid</small><strong>{latest ? formatMoney(latest.paid) : "—"}</strong></span>
      </span>
    );
  }

  const latestEvents = [...(data.timeline || [])].filter((event) => event.date).slice(-2).reverse();
  return (
    <span className="claim-record-preview-events">
      {latestEvents.length ? latestEvents.map((event) => (
        <span key={event.id}><small>{formatDate(event.date)}</small><strong>{event.title}</strong></span>
      )) : <span><strong>No dated records</strong></span>}
    </span>
  );
}

export function ClaimDetailDrawer({ data, activePanel, origin, onChangePanel, onClose }) {
  const [mode, setMode] = useState("preview");
  const layerRef = useRef(null);
  const previewRef = useRef(null);
  const closeRef = useRef(null);
  const titleId = useId();
  const panel = PANELS[activePanel] || PANELS.details;
  const resolvedOrigin = origin || { left: 280, bottom: 18 };

  useEffect(() => {
    window.requestAnimationFrame(() => previewRef.current?.focus());
  }, []);

  useEffect(() => {
    if (mode !== "expanded") return undefined;
    window.requestAnimationFrame(() => closeRef.current?.focus());

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMode("preview");
        window.requestAnimationFrame(() => previewRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(layerRef.current?.querySelectorAll(
        ".claim-record-bubble-expanded button, .claim-record-bubble-expanded [href], .claim-record-bubble-expanded [tabindex]:not([tabindex='-1'])",
      ) || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mode]);

  function returnToPreview() {
    setMode("preview");
    window.requestAnimationFrame(() => previewRef.current?.focus());
  }

  return (
    <div
      ref={layerRef}
      className={`claim-record-bubble-layer claim-record-bubble-layer-${mode}`}
      style={{
        "--record-origin-left": `${resolvedOrigin.left}px`,
        "--record-origin-bottom": `${resolvedOrigin.bottom}px`,
      }}
    >
      <button
        className="claim-record-backdrop"
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={returnToPreview}
      />
      <aside
        className={`claim-record-bubble claim-record-bubble-${activePanel} claim-record-bubble-${mode}`}
        role={mode === "expanded" ? "dialog" : "complementary"}
        aria-modal={mode === "expanded" ? "true" : undefined}
        aria-label={mode === "expanded" ? undefined : `${panel.label} preview`}
        aria-labelledby={mode === "expanded" ? titleId : undefined}
      >
        {mode === "preview" ? (
          <div className="claim-record-preview">
            <button
              ref={previewRef}
              className="claim-record-preview-main"
              type="button"
              aria-expanded="false"
              onClick={() => setMode("expanded")}
            >
              <span className="claim-record-preview-icon" aria-hidden="true">{panel.icon}</span>
              <span className="claim-record-preview-copy">
                <span className="claim-record-preview-title">
                  <span><small>{panel.kicker}</small><strong>{panel.label}</strong></span>
                  <em>Claim {data.claim.claimId}</em>
                </span>
                <PreviewRows data={data} activePanel={activePanel} />
              </span>
              <span className="claim-record-preview-open" aria-hidden="true">↗</span>
            </button>
            <button className="claim-record-preview-dismiss" type="button" onClick={onClose} aria-label={`Close ${panel.label} preview`}>⌄</button>
          </div>
        ) : (
          <div className="drawer-shell">
            <header className="drawer-header">
              <div>
                <p className="section-kicker">{panel.kicker}</p>
                <h2 id={titleId}>{panel.label}</h2>
                <span>Claim {data.claim.claimId}</span>
              </div>
              <button ref={closeRef} className="drawer-close" type="button" onClick={returnToPreview} aria-label={`Return to ${panel.label} preview`}>
                <span aria-hidden="true">×</span>
              </button>
            </header>

            <nav className="drawer-tabs" aria-label="Claim record sections">
              {Object.entries(PANELS).map(([key, item]) => (
                <button
                  type="button"
                  key={key}
                  className={key === activePanel ? "drawer-tab-active" : ""}
                  aria-current={key === activePanel ? "page" : undefined}
                  onClick={() => onChangePanel(key)}
                >
                  {item.label}
                  {key === "eras" ? <span>{data.eras?.length || 0}</span> : null}
                  {key === "timeline" ? <span>{data.timeline?.length || 0}</span> : null}
                </button>
              ))}
            </nav>

            <div className="drawer-content">
              {activePanel === "categorization" ? <ClaimCategorizationPanel data={data} /> : null}
              {activePanel === "details" ? <ClaimDetailPanel data={data} /> : null}
              {activePanel === "eras" ? <ClaimEraList data={data} /> : null}
              {activePanel === "timeline" ? <ClaimTimeline data={data} defaultExpanded /> : null}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
