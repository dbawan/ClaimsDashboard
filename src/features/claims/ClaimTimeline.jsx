import { useEffect, useId, useState } from "react";
import { StatusBadge } from "../../components/StatusBadge.jsx";
import { formatDate, formatMoney } from "./ClaimSummary.jsx";

function sourceTone(event) {
  if (event.paymentAuthority === "era") return "success";
  if (event.paymentAuthority === "transaction-fallback") return "warning";
  return "neutral";
}

export function ClaimTimeline({ data, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentId = useId();

  useEffect(() => setExpanded(defaultExpanded), [data.claim.claimId, defaultExpanded]);

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
          <span className="section-kicker">Source-level history</span>
          <span className="timeline-toggle-heading" id="timeline-heading" role="heading" aria-level="2">
            All claim records
          </span>
        </span>
        <span className="timeline-toggle-meta">
          <span className="timeline-count">{data.timeline.length} records</span>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m5 7.5 5 5 5-5" />
          </svg>
        </span>
      </button>

      {expanded ? (
        <div className="timeline-expanded" id={contentId}>
          <ol className="timeline-list">
            {data.timeline.map((event) => (
              <li className={`timeline-event timeline-event-${event.status}`} key={event.id}>
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
                  <StatusBadge tone={sourceTone(event)}>{event.source}</StatusBadge>
                </div>
              </li>
            ))}
          </ol>

          <div className="timeline-footer">
            <div>
              <span>Duplicates removed</span>
              <strong>{data.provenance.duplicatesRemoved}</strong>
            </div>
            <div>
              <span>ERA-matched postings</span>
              <strong>{data.provenance.eraMatchedPostings}</strong>
            </div>
            <p>{data.provenance.matchRule}</p>
          </div>
          {data.warnings?.length ? (
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
