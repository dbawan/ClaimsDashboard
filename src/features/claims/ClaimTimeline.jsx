import { useEffect, useId, useMemo, useState } from "react";
import { StatusBadge } from "../../components/StatusBadge.jsx";
import { formatDate, formatMoney } from "./ClaimSummary.jsx";
import { scopeClaimDataToProcedure } from "./claimStoryModel.js";

function sourceTone(event) {
  if (event.paymentAuthority === "era") return "success";
  if (event.paymentAuthority === "posted") return "warning";
  return "neutral";
}

export function ClaimTimeline({ data, selectedProcedure = null, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showAllRecords, setShowAllRecords] = useState(false);
  const contentId = useId();
  const scopedData = useMemo(
    () => selectedProcedure ? scopeClaimDataToProcedure(data, selectedProcedure) : data,
    [data, selectedProcedure],
  );
  const viewData = selectedProcedure && !showAllRecords ? scopedData : data;
  const isProcedureView = Boolean(selectedProcedure && !showAllRecords);

  useEffect(() => setExpanded(defaultExpanded), [data.claim.claimId, defaultExpanded]);
  useEffect(() => setShowAllRecords(false), [data.claim.claimId, selectedProcedure]);

  return (
    <section className="timeline-card" aria-labelledby="timeline-heading">
      <button
        className="timeline-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="timeline-toggle-copy">
          <span className="section-kicker">{isProcedureView ? "CPT-specific source history" : "Source-level history"}</span>
          <span className="timeline-toggle-heading" id="timeline-heading" role="heading" aria-level="2">
            {isProcedureView ? `Records relevant to ${selectedProcedure}` : "All claim records"}
          </span>
        </span>
        <span className="timeline-toggle-meta">
          <span className="timeline-count">{viewData.timeline.length} records</span>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m5 7.5 5 5 5-5" />
          </svg>
        </span>
      </button>

      {expanded ? (
        <div className="timeline-expanded" id={contentId}>
          {selectedProcedure ? (
            <div className="timeline-scope-toolbar">
              <div>
                <strong>{showAllRecords ? "Showing the complete claim" : `Showing ${selectedProcedure} activity`}</strong>
                <span>{showAllRecords
                  ? `${data.timeline.length} claim-wide source records`
                  : `${scopedData.procedureScope.relevantRecordCount} CPT record${scopedData.procedureScope.relevantRecordCount === 1 ? "" : "s"} and ${scopedData.procedureScope.contextCount} context record${scopedData.procedureScope.contextCount === 1 ? "" : "s"}`}</span>
              </div>
              <button type="button" onClick={() => setShowAllRecords((value) => !value)}>
                {showAllRecords ? `Show ${selectedProcedure} only` : `Show all ${data.timeline.length} claim records`}
              </button>
            </div>
          ) : null}
          <ol className="timeline-list">
            {viewData.timeline.map((event) => (
              <li className={`timeline-event timeline-event-${event.status}${event.claimContext ? " timeline-event-context" : ""}`} key={event.id}>
                <div className="timeline-rail" aria-hidden="true">
                  <span />
                </div>
                <div className="timeline-date">
                  <time dateTime={event.date || undefined}>{formatDate(event.date)}</time>
                </div>
                <div className="timeline-copy">
                  <div className="timeline-event-heading">
                    <h3>{event.title}</h3>
                    {event.amount != null ? (
                      <strong className={event.amount < 0 ? "amount-negative" : "amount-positive"}>
                        {formatMoney(event.amount)}
                      </strong>
                    ) : null}
                  </div>
                  {event.eventType === "salesforce-comment" ? (
                    <div className="timeline-comment-meta">
                      <span className={`comment-category-badge comment-category-${event.category}`}>
                        {event.commentOrder}. {event.categoryLabel}
                      </span>
                      <span>{event.confidence} confidence</span>
                    </div>
                  ) : null}
                  <p>{event.description}</p>
                  {event.eventType === "salesforce-comment" && event.commentText ? (
                    <blockquote className="timeline-comment-text">
                      {event.commentText}{event.commentTextTruncated ? "…" : ""}
                    </blockquote>
                  ) : null}
                  <StatusBadge tone={event.claimContext ? "neutral" : sourceTone(event)}>
                    {event.claimContext ? "Claim context" : event.source}
                  </StatusBadge>
                </div>
              </li>
            ))}
          </ol>

          <div className={`timeline-footer${isProcedureView ? " timeline-footer-procedure" : ""}`}>
            {isProcedureView ? <div>
              <span>Relevant source records</span>
              <strong>{scopedData.procedureScope.relevantRecordCount}</strong>
            </div> : <div>
              <span>Duplicates removed</span>
              <strong>{data.provenance.duplicatesRemoved}</strong>
            </div>}
            <div>
              <span>Posted payment</span>
              <strong>{formatMoney(viewData.summary.totalPaid)}</strong>
            </div>
            {isProcedureView ? <div>
              <span>Payment received</span>
              <strong>{formatMoney(scopedData.summary.receivedPaid)}</strong>
            </div> : null}
            <p>{isProcedureView
              ? `Only events explicitly associated with CPT ${selectedProcedure} are included. Claim-level service date is retained as context.`
              : data.provenance.matchRule}</p>
          </div>
          {!isProcedureView && data.warnings?.length ? (
            <div className="reconciliation-notes">
              <h3>Data quality / reconciliation notes</h3>
              <ul>
                {data.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
