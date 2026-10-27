import { paymentViewData } from "./paymentChartModel.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { StatusBadge } from "../../components/StatusBadge.jsx";
import {
  buildAggregateCptPaymentModel,
  buildCptPaymentModels,
  buildCptPaidSnapshot,
  buildPaymentChartModel,
  buildStepPath,
  selectNonOverlappingDateTicks,
} from "./paymentChartModel.js";
import { buildClaimStory, plainSourceLabel, scopeClaimDataToProcedure } from "./claimStoryModel.js";
import { formatDate, formatMoney } from "./ClaimSummary.jsx";

function categoryClass(category) {
  return category ? `comment-category-${category}` : "";
}

function compactMoney(value) {
  const amount = Number(value || 0);
  const absolute = Math.abs(amount);
  if (absolute >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}m`;
  if (absolute >= 1_000) return `$${(amount / 1_000).toFixed(1)}k`;
  return formatMoney(amount);
}

function evenlySpacedPosition(index, count, left, right) {
  if (count <= 1) return (left + right) / 2;
  return left + (index / (count - 1)) * (right - left);
}

function markerX(baseX, markerIndex, markerCount, spacing) {
  return baseX + (markerIndex - (markerCount - 1) / 2) * spacing;
}

function CptEventGlyph({ marker, x, y, size = 5 }) {
  const className = `cpt-event-marker cpt-event-marker-${marker.kind}`;
  if (marker.kind === "rebill") {
    return <rect className={className} x={x - size} y={y - size} width={size * 2} height={size * 2} rx="1" transform={`rotate(45 ${x} ${y})`} />;
  }
  if (marker.kind === "denial") {
    return <path className={className} d={`M ${x} ${y - size - 1} L ${x + size + 1} ${y + size} L ${x - size - 1} ${y + size} Z`} />;
  }
  return <circle className={className} cx={x} cy={y} r={size} />;
}

function pointDescription(point) {
  const markerLabels = point?.markers?.map((marker) => marker.label).filter(Boolean) || [];
  const labels = markerLabels.length ? markerLabels : point?.labels || [];
  return [...new Set(labels)].join(" · ") || "Claim activity";
}

function CptMiniGraph({ model, activeIndex, activeDate, eventCount, onHover, onExpand }) {
  const [tooltip, setTooltip] = useState(null);
  const width = 360;
  const height = 150;
  const plot = { left: 10, right: width - 10, top: 10, bottom: height - 24 };
  const values = model.points.map((point) => point.cumulative);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, model.charge, ...values);
  const range = maximum - minimum || 1;
  const yMinimum = minimum < 0 ? minimum - range * 0.08 : 0;
  const yMaximum = maximum + range * 0.08;
  const xScale = (index) => evenlySpacedPosition(index, eventCount, plot.left, plot.right);
  const yScale = (value) => plot.bottom - ((value - yMinimum) / (yMaximum - yMinimum)) * (plot.bottom - plot.top);
  const path = buildStepPath(
    model.points,
    (point) => xScale(point.index),
    yScale,
    plot.left,
    plot.right,
  );
  const currentPoint = model.points[activeIndex] || model.points.at(-1) || { cumulative: 0 };
  const activeX = xScale(Math.max(0, activeIndex));
  const activeY = yScale(currentPoint.cumulative);
  const amountTone = currentPoint.cumulative < 0 ? "amount-negative" : "amount-positive";
  const chartName = model.isAggregate ? "all CPTs" : `CPT ${model.procedure}`;

  function handleMouseMove(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const chartBounds = event.currentTarget.querySelector(".cpt-mini-chart")?.getBoundingClientRect();
    const screenPlotLeft = chartBounds
      ? chartBounds.left + (plot.left / width) * chartBounds.width
      : bounds.left;
    const screenPlotRight = chartBounds
      ? chartBounds.left + (plot.right / width) * chartBounds.width
      : bounds.right;
    const ratio = Math.max(0, Math.min(1, (event.clientX - screenPlotLeft) / Math.max(1, screenPlotRight - screenPlotLeft)));
    const index = Math.round(ratio * Math.max(0, eventCount - 1));
    const localX = event.clientX - bounds.left;
    const tooltipWidth = Math.min(150, bounds.width - 18);
    const desiredLeft = ratio > 0.55 ? localX - tooltipWidth - 10 : localX + 10;
    onHover(index);
    setTooltip({
      index,
      x: Math.max(9, Math.min(bounds.width - tooltipWidth - 9, desiredLeft)),
      y: Math.max(58, Math.min(bounds.height - 28, event.clientY - bounds.top)),
    });
  }

  const tooltipPoint = tooltip ? model.points[tooltip.index] : null;

  return (
    <button
      type="button"
      className="cpt-mini-card"
      aria-label={`Expand ${chartName} payment details`}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => {
        setTooltip(null);
        onHover(null);
      }}
      onFocus={() => onHover(activeIndex)}
      onBlur={() => onHover(null)}
      onClick={() => onExpand(model.procedure)}
    >
      <header>
        <div>
          <span>{model.isAggregate ? "Aggregate" : "CPT"}</span>
          <strong>{model.procedure}</strong>
        </div>
        <div>
          <strong className={amountTone}>{formatMoney(currentPoint.cumulative)} {model.paymentView === "received" ? "received" : "posted"}</strong>
          <small>of {formatMoney(model.charge)} charged</small>
        </div>
      </header>
      <svg
        className="cpt-mini-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${chartName}: ${formatMoney(currentPoint.cumulative)} ${model.paymentView === "received" ? "received" : "posted"} through ${formatDate(activeDate)}, against ${formatMoney(model.charge)} charged.`}
      >
        <line className="cpt-mini-zero" x1={plot.left} x2={plot.right} y1={yScale(0)} y2={yScale(0)} />
        <line className="cpt-mini-charge" x1={plot.left} x2={plot.right} y1={yScale(model.charge)} y2={yScale(model.charge)} />
        <path className="cpt-mini-payment" d={path} />
        {model.points.filter((point) => point.markers?.length).map((point, index) => (
          <line
            className={`cpt-event-guide cpt-event-guide-${point.markers.at(-1).kind}`}
            x1={xScale(point.index)}
            x2={xScale(point.index)}
            y1={plot.top}
            y2={plot.bottom}
            key={`guide-${point.date}-${index}`}
          />
        ))}
        <line className="cpt-mini-active-line" x1={activeX} x2={activeX} y1={plot.top} y2={plot.bottom} />
        {!currentPoint.markers?.length ? (
          <circle
            className={currentPoint.delta < 0 ? "cpt-mini-active-point cpt-mini-active-reversal" : "cpt-mini-active-point"}
            cx={activeX}
            cy={activeY}
            r="4"
          />
        ) : null}
        {model.points.flatMap((point) => (point.markers || []).map((marker, markerIndex) => {
          const x = markerX(xScale(point.index), markerIndex, point.markers.length, 12);
          return (
            <g key={`${point.date}-${marker.kind}`}>
              <title>{formatDate(point.date)}: {marker.label}</title>
              <CptEventGlyph marker={marker} x={x} y={yScale(point.cumulative)} size={4.5} />
            </g>
          );
        }))}
        <text className="cpt-mini-date" x={plot.left} y={height - 6}>{formatDate(model.points[0]?.date)}</text>
        <text className="cpt-mini-date" x={plot.right} y={height - 6} textAnchor="end">{formatDate(model.points.at(-1)?.date)}</text>
      </svg>
      {tooltipPoint ? (
        <span
          className="cpt-hover-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
          aria-hidden="true"
        >
          <strong>{formatDate(tooltipPoint.date)}</strong>
          <span>{pointDescription(tooltipPoint)}</span>
          {Math.abs(tooltipPoint.delta) >= 0.005 ? (
            <em>{tooltipPoint.delta < 0 ? "Reversed" : model.paymentView === "received" ? "Received" : "Posted"} {formatMoney(Math.abs(tooltipPoint.delta))}</em>
          ) : null}
          <small>{formatMoney(tooltipPoint.cumulative)} {model.paymentView === "received" ? "received" : "posted"} to date</small>
        </span>
      ) : null}
      <span className="cpt-mini-expand-hint">Click to expand</span>
    </button>
  );
}

function CptExpandedPanel({ model, activeIndex, onHover, onMinimize }) {
  const width = 820;
  const height = 310;
  const plot = { left: 72, right: width - 28, top: 24, bottom: 242 };
  const values = model.points.map((point) => point.cumulative);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, model.charge, ...values);
  const rawRange = maximum - minimum || 1;
  const yMinimum = minimum < 0 ? minimum - rawRange * 0.08 : 0;
  const yMaximum = maximum + rawRange * 0.1;
  const xScale = (index) => evenlySpacedPosition(index, model.points.length, plot.left, plot.right);
  const yScale = (value) => plot.bottom - ((value - yMinimum) / (yMaximum - yMinimum)) * (plot.bottom - plot.top);
  const path = buildStepPath(
    model.points,
    (point) => xScale(point.index),
    yScale,
    plot.left,
    plot.right,
  );
  const yTicks = Array.from({ length: 5 }, (_, index) => yMinimum + ((yMaximum - yMinimum) * index) / 4).reverse();
  const xTickIndexes = [...new Set([0, 1, 2, 3, 4].map((step) => (
    Math.round((step / 4) * Math.max(0, model.points.length - 1))
  )))];
  const activity = model.points.filter((point) => Math.abs(point.delta) >= 0.005);
  const activePoint = model.points[activeIndex] || model.points.at(-1);
  const chartName = model.isAggregate ? "all CPTs" : `CPT ${model.procedure}`;

  function handlePointerMove(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
    onHover(Math.round(ratio * Math.max(0, model.points.length - 1)));
  }

  function handlePointKeyDown(event, index) {
    if (!["Enter", " ", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "ArrowLeft"
      ? Math.max(0, index - 1)
      : event.key === "ArrowRight"
        ? Math.min(model.points.length - 1, index + 1)
        : index;
    onHover(nextIndex);
  }

  return (
    <section className="cpt-expanded-panel" aria-labelledby="cpt-expanded-heading">
      <header>
        <div>
          <span>{model.isAggregate ? "Expanded aggregate payment detail" : "Expanded CPT payment detail"}</span>
          <h2 id="cpt-expanded-heading">{model.procedure}</h2>
        </div>
        <dl>
          <div><dt>Charged</dt><dd>{formatMoney(model.charge)}</dd></div>
          <div><dt>Paid through {formatDate(activePoint?.date)}</dt><dd className={(activePoint?.cumulative || 0) < 0 ? "amount-negative" : "amount-positive"}>{formatMoney(activePoint?.cumulative)}</dd></div>
          <div><dt>Charge less selected payments</dt><dd>{formatMoney(model.charge - model.totalPaid)}</dd></div>
        </dl>
        <button type="button" onClick={onMinimize} aria-label={`Minimize ${chartName} detail`}>
          <span aria-hidden="true">−</span> Minimize
        </button>
      </header>

      <div className="cpt-detail-content">
        <div className="cpt-detail-chart-wrap">
          <div className="cpt-detail-legend">
            <span><i className="legend-line legend-payment" />Payment amount</span>
            <span><i className="legend-line legend-charges" />Charged</span>
            <span><i className="cpt-event-key cpt-event-key-rebill" />Rebill</span>
            <span><i className="cpt-event-key cpt-event-key-payment" />Payment</span>
            <span><i className="cpt-event-key cpt-event-key-denial" />Denial</span>
          </div>
          <svg
            className="cpt-detail-chart"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Interactive ${chartName} payment history. ${formatMoney(model.totalPaid)} ${model.paymentView === "received" ? "received" : "posted"} against ${formatMoney(model.charge)} charged.`}
            onMouseMove={handlePointerMove}
            onMouseLeave={() => onHover(null)}
          >
            {yTicks.map((tick) => {
              const y = yScale(tick);
              return <g className="cpt-detail-grid-line" key={tick}><line x1={plot.left} x2={plot.right} y1={y} y2={y} /><text x={plot.left - 12} y={y + 4} textAnchor="end">{compactMoney(tick)}</text></g>;
            })}
            <line className="cpt-mini-charge" x1={plot.left} x2={plot.right} y1={yScale(model.charge)} y2={yScale(model.charge)} />
            <path className="cpt-mini-payment" d={path} />
            {model.points.filter((point) => point.markers?.length).map((point) => (
              <line
                className={`cpt-event-guide cpt-event-guide-${point.markers.at(-1).kind}`}
                x1={xScale(point.index)}
                x2={xScale(point.index)}
                y1={plot.top}
                y2={plot.bottom}
                key={`guide-${point.date}`}
              />
            ))}
            {activePoint ? <line className="cpt-mini-active-line" x1={xScale(activePoint.index)} x2={xScale(activePoint.index)} y1={plot.top} y2={plot.bottom} /> : null}
            {model.points.flatMap((point) => (point.markers || []).map((marker, markerIndex) => {
              const x = markerX(xScale(point.index), markerIndex, point.markers.length, 18);
              const active = point.index === activeIndex;
              return (
                <g
                  className={`cpt-event-interaction${active ? " cpt-event-interaction-active" : ""}`}
                  key={`${point.date}-${marker.kind}`}
                  role="button"
                  tabIndex="0"
                  aria-label={`${formatDate(point.date)}: ${marker.label}. ${formatMoney(point.cumulative)} ${model.paymentView === "received" ? "received" : "posted"} to date.`}
                  onFocus={() => onHover(point.index)}
                  onBlur={() => onHover(null)}
                  onClick={() => onHover(point.index)}
                  onKeyDown={(event) => handlePointKeyDown(event, point.index)}
                >
                  <title>{formatDate(point.date)}: {marker.label}</title>
                  <CptEventGlyph marker={marker} x={x} y={yScale(point.cumulative)} size={active ? 7 : 5.5} />
                </g>
              );
            }))}
            <line className="chart-axis" x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />
            {xTickIndexes.map((index) => <text className="cpt-detail-date" x={xScale(index)} y={plot.bottom + 32} textAnchor="middle" key={index}>{formatDate(model.points[index]?.date)}</text>)}
          </svg>
        </div>

        <aside className="cpt-detail-activity">
          <header><strong>Payment activity</strong><span>{activity.length} dated change{activity.length === 1 ? "" : "s"}</span></header>
          {activity.length ? (
            <ol>
              {activity.map((point) => (
                <li className={point.index === activeIndex ? "cpt-detail-activity-active" : ""} key={`${point.date}-${point.index}`} onMouseEnter={() => onHover(point.index)} onMouseLeave={() => onHover(null)}>
                  <div><strong>{formatDate(point.date)}</strong><span>{point.delta < 0 ? "Reversed" : model.paymentView === "received" ? "Received" : "Posted"}</span></div>
                  <b className={point.delta < 0 ? "amount-negative" : "amount-positive"}>{formatMoney(point.delta)}</b>
                  <small>{formatMoney(point.cumulative)} {model.paymentView === "received" ? "received" : "posted"} to date</small>
                </li>
              ))}
            </ol>
          ) : <p>No CPT-level payment changes were recorded.</p>}
        </aside>
      </div>
    </section>
  );
}

function CptPaymentShelf({
  models,
  activeIndex,
  activeDate,
  eventCount,
  selectedProcedure = null,
  onHover,
  onSelectedProcedureChange,
}) {
  const [expandedProcedure, setExpandedProcedure] = useState(null);
  const aggregateModel = useMemo(() => { const aggregate = buildAggregateCptPaymentModel(models);
    return aggregate ? { ...aggregate, paymentView: models[0]?.paymentView } : null; }, [models]);
  const chartModels = aggregateModel ? [aggregateModel, ...models] : models;
  const expandedModel = chartModels.find((model) => model.procedure === expandedProcedure) || null;

  useEffect(() => {
    if (selectedProcedure || expandedProcedure === "All CPTs") return;
    setExpandedProcedure(null);
  }, [expandedProcedure, selectedProcedure]);

  useEffect(() => {
    if (!expandedProcedure || expandedModel) return;
    setExpandedProcedure(null);
    onSelectedProcedureChange?.(null);
  }, [expandedModel, expandedProcedure, onSelectedProcedureChange]);

  useEffect(() => {
    if (!expandedModel) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setExpandedProcedure(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [expandedModel]);

  return (
    <section className={`cpt-mini-shelf${expandedModel ? " cpt-mini-shelf-expanded" : ""}`} aria-labelledby="cpt-payment-heading">
      <header className="cpt-mini-shelf-heading">
        <div><strong id="cpt-payment-heading">CPT {models[0]?.paymentView === "received" ? "received" : "posted"} payment charts</strong><span>Three per row · aggregate first · then highest charge</span></div>
        <span>Hover for dated amounts · click to expand · through {formatDate(activeDate)}</span>
      </header>
      <div className="cpt-mini-legend" aria-label="CPT graph legend">
        <span><i className="legend-line legend-payment" />Payment amount</span>
        <span><i className="legend-line legend-charges" />Charged</span>
        <span><i className="cpt-event-key cpt-event-key-rebill" />Rebill</span>
        <span><i className="cpt-event-key cpt-event-key-payment" />Payment</span>
        <span><i className="cpt-event-key cpt-event-key-denial" />Denial</span>
      </div>
      {expandedModel ? (
        <CptExpandedPanel
          model={expandedModel}
          activeIndex={activeIndex}
          onHover={onHover}
          onMinimize={() => {
            setExpandedProcedure(null);
            onSelectedProcedureChange?.(null);
          }}
        />
      ) : null}
      {models.length ? (
        <div className="cpt-mini-list" tabIndex="0" aria-label="Vertically scrollable CPT graph list">
          <div className="cpt-mini-grid">
            {chartModels.map((model) => (
              <CptMiniGraph
                key={model.procedure}
                model={model}
                activeIndex={activeIndex}
                activeDate={activeDate}
                eventCount={eventCount}
                onHover={onHover}
                onExpand={(procedure) => {
                  setExpandedProcedure(procedure);
                  onSelectedProcedureChange?.(procedure === "All CPTs" ? null : procedure);
                }}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="cpt-mini-empty">No CPT-level payments are available for this claim.</p>
      )}
      <div className="cpt-grid-footer">
        <b>{models.length} CPT{models.length === 1 ? "" : "s"}{aggregateModel ? " · 1 aggregate" : ""}</b>
      </div>
    </section>
  );
}

function storyDate(episode) {
  if (!episode.startDate) return "Date not provided";
  if (episode.startDate === episode.endDate) return formatDate(episode.startDate);
  return `${formatDate(episode.startDate)} – ${formatDate(episode.endDate)}`;
}

function supportingTitle(event) {
  const title = String(event.title || "Claim activity");
  if (/submission\/correction\/rebill observed/i.test(title)) return "Submission recorded";
  if (/claim adjudicated/i.test(title)) return "Payer response recorded";
  if (/claim created/i.test(title)) return "Billing record created";
  if (/applied payment|payment applied/i.test(title)) return "Payment posting recorded";
  if (/date of service/i.test(title)) return "Service date recorded";
  return title;
}

function storyStatusLabel(status) {
  if (status === "success") return "Payment";
  if (status === "danger") return "Needs attention";
  if (status === "warning") return "Payer activity";
  return "Claim activity";
}

function LinkedTimeline({ data, activeDate, autoExpandKey, selectedProcedure = null }) {
  const scopedData = useMemo(
    () => selectedProcedure ? scopeClaimDataToProcedure(data, selectedProcedure) : data,
    [data, selectedProcedure],
  );
  const episodes = useMemo(
    () => buildClaimStory(scopedData, { selectedProcedure }),
    [scopedData, selectedProcedure],
  );
  const [expandedKey, setExpandedKey] = useState(null);
  const scrollRef = useRef(null);
  const groupRefs = useRef(new Map());
  const activeEpisode = episodes.find((episode) => episode.dates.includes(activeDate)) || episodes.at(-1) || null;
  const activeEpisodeKey = activeEpisode?.key || null;
  const activeEpisodeNumber = Math.max(1, episodes.findIndex((episode) => episode.key === activeEpisodeKey) + 1);
  const followedDate = episodes.some((episode) => episode.dates.includes(activeDate))
    ? activeDate
    : activeEpisode?.endDate;

  useEffect(() => setExpandedKey(null), [data.claim.claimId, selectedProcedure]);

  useEffect(() => {
    if (autoExpandKey == null || !activeEpisodeKey) return;
    setExpandedKey(activeEpisodeKey);
  }, [activeEpisodeKey, autoExpandKey]);

  useEffect(() => {
    const container = scrollRef.current;
    const target = groupRefs.current.get(activeEpisodeKey);
    if (!container || !target) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const centeredTop = target.offsetHeight > container.clientHeight * 0.72
        ? target.offsetTop - 8
        : target.offsetTop - (container.clientHeight - target.offsetHeight) / 2;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      container.scrollTo({
        top: Math.max(0, centeredTop),
        behavior: reducedMotion ? "auto" : "smooth",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeEpisodeKey, data.claim.claimId, expandedKey]);

  return (
    <aside className="linked-timeline-panel" aria-labelledby="linked-timeline-heading">
      <header className="linked-timeline-header">
        <div className="linked-timeline-title">
            <span className="linked-timeline-title-icon" aria-hidden="true">↳</span>
            <div>
            <p className="section-kicker">{selectedProcedure ? "CPT-specific journey" : "Plain-language journey"}</p>
            <h3 id="linked-timeline-heading">{selectedProcedure ? `${selectedProcedure} story` : "Claim story"}</h3>
            <small>{selectedProcedure
              ? `${episodes.length} clear steps from ${scopedData.procedureScope.relevantRecordCount} CPT records`
              : `${episodes.length} clear steps from ${data.timeline.length} source records`}</small>
          </div>
        </div>
        <div className="linked-timeline-following" aria-live="polite">
          <span><i aria-hidden="true" />{episodes.length ? `Step ${activeEpisodeNumber} of ${episodes.length}` : "No linked steps"}</span>
          <strong>{formatDate(followedDate)}</strong>
        </div>
      </header>

      <div className="linked-timeline-scroll" ref={scrollRef}>
        {selectedProcedure ? (
          <dl className="linked-timeline-cpt-summary" aria-label={`${selectedProcedure} financial summary`}>
            <div><dt>CPT / HCPCS</dt><dd>{selectedProcedure}</dd></div>
            <div><dt>Charged</dt><dd>{formatMoney(scopedData.procedureScope.charged)}</dd></div>
            <div><dt>Payer received</dt><dd>{formatMoney(scopedData.procedureScope.received)}</dd></div>
            <div><dt>Posted internally</dt><dd>{formatMoney(scopedData.procedureScope.posted)}</dd></div>
          </dl>
        ) : null}
        <p className="linked-timeline-guide">{selectedProcedure
          ? `Only ${selectedProcedure} activity is shown. Claim-level service date is retained as context.`
          : "Select a step to see the original records behind it."}</p>
        {!episodes.length ? (
          <div className="linked-timeline-empty">
            <strong>No source records are explicitly linked to {selectedProcedure}</strong>
            <p>The CPT graph can still reflect claim data, but this claim’s source history does not identify that code on individual events.</p>
          </div>
        ) : null}
        {episodes.map((episode, episodeIndex) => {
          const active = episode.key === activeEpisodeKey;
          const expanded = episode.key === expandedKey;
          const detailId = `timeline-detail-${data.claim.claimId}-${episode.key}`;
          return (
            <section
              className={`linked-timeline-group linked-timeline-group-${episode.status} ${active ? "linked-timeline-group-active" : ""}`}
              key={episode.key}
              ref={(node) => {
                if (node) groupRefs.current.set(episode.key, node);
                else groupRefs.current.delete(episode.key);
              }}
              aria-current={active ? "date" : undefined}
            >
              <button
                className="linked-timeline-summary"
                type="button"
                aria-expanded={expanded}
                aria-controls={detailId}
                onClick={() => setExpandedKey((current) => current === episode.key ? null : episode.key)}
              >
                <span className="linked-timeline-rail" aria-hidden="true"><i>{episodeIndex + 1}</i></span>
                <span className="linked-timeline-step-copy">
                  <span className="linked-timeline-step-meta">
                    <time dateTime={episode.startDate || undefined}>{storyDate(episode)}</time>
                    <em>{storyStatusLabel(episode.status)}</em>
                  </span>
                  <strong className="linked-timeline-step-title">{episode.title}</strong>
                  <span className="linked-timeline-step-summary">{episode.summary}</span>
                  <span className="linked-timeline-step-footer">
                    <span>{episode.recordCount} source record{episode.recordCount === 1 ? "" : "s"}</span>
                    {episode.amount != null ? (
                      <b className={episode.amount < 0 ? "amount-negative" : "amount-positive"}>
                        {formatMoney(episode.amount)}
                      </b>
                    ) : null}
                  </span>
                </span>
                <span className="linked-timeline-chevron" aria-hidden="true">⌄</span>
              </button>

              {expanded ? (
                <div className="linked-timeline-details" id={detailId}>
                  <div className="linked-timeline-supporting-heading">
                    <span>Records behind this step</span>
                    <strong>{episode.recordCount}</strong>
                  </div>
                  <ol className="linked-timeline-supporting-list">
                    {episode.events.map((event, index) => (
                      <li
                        className={`linked-timeline-event linked-timeline-event-${event.status}`}
                        key={`${event.id || event.title}-${index}`}
                      >
                        <div className="linked-timeline-event-meta">
                          <time dateTime={event.date || undefined}>{formatDate(event.date)}</time>
                          <StatusBadge tone="neutral">{event.claimContext ? "Claim context" : plainSourceLabel(event.source)}</StatusBadge>
                        </div>
                        <div className="linked-timeline-event-heading">
                          <h4>{supportingTitle(event)}</h4>
                          {event.amount != null ? (
                            <strong className={event.amount < 0 ? "amount-negative" : "amount-positive"}>
                              {formatMoney(event.amount)}
                            </strong>
                          ) : null}
                        </div>
                        <p>{event.description}</p>
                        {event.submissionReference ? <span className="linked-timeline-event-reference">{event.submissionReference}</span> : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function LegacyClaimPaymentChart({ data, onCptPaymentSnapshotChange }) {
  const model = useMemo(() => buildPaymentChartModel(data), [data]);
  const { eventGroups, paymentPoints, charges } = model;
  const cptModels = useMemo(() => buildCptPaymentModels(chartData, eventGroups).map((item) => ({ ...item, paymentView })), [chartData, eventGroups, paymentView]);
  const eventGroupKey = eventGroups.map((group) => group.date).join("|");
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, eventGroups.length - 1));
  const cptPaymentSnapshot = useMemo(
    () => ({ ...buildCptPaidSnapshot(cptModels, eventGroups, hoveredIndex), paymentView }),
    [cptModels, eventGroups, hoveredIndex, paymentView],
  );

  useEffect(() => {
    setHoveredIndex(null);
    setSelectedIndex(Math.max(0, eventGroups.length - 1));
  }, [eventGroupKey, eventGroups.length]);

  useEffect(() => {
    onCptPaymentSnapshotChange?.(cptPaymentSnapshot);
  }, [cptPaymentSnapshot, onCptPaymentSnapshotChange]);

  if (eventGroups.length === 0) {
    return (
      <section className="payment-chart-card payment-chart-card-empty" aria-labelledby="payment-chart-heading">
        <div className="payment-chart-header">
          <div>
            <p className="section-kicker">Financial progression</p>
            <h2 id="payment-chart-heading">Payments vs. charges</h2>
          </div>
        </div>
        <div className="payment-chart-empty">
          <span aria-hidden="true">—</span>
          <div><strong>No dated events to graph</strong><p>Open the claim details to review the source record.</p></div>
        </div>
      </section>
    );
  }

  const activeIndex = hoveredIndex ?? selectedIndex;
  const activeGroup = eventGroups[activeIndex] || eventGroups.at(-1);
  const chartWidth = 780;
  const chartHeight = 220;
  const plot = { left: 66, right: chartWidth - 24, top: 18, bottom: 154 };
  const eventIndexByDate = new Map(eventGroups.map((group, index) => [group.date, index]));
  const xScale = (date) => {
    const index = eventIndexByDate.get(date) ?? 0;
    return evenlySpacedPosition(index, eventGroups.length, plot.left, plot.right);
  };

  const paymentValues = paymentPoints.map((point) => point.cumulative);
  const minimumValue = Math.min(0, ...paymentValues);
  const maximumValue = Math.max(0, charges, ...paymentValues);
  const rawRange = maximumValue - minimumValue || 1;
  const yMinimum = minimumValue < 0 ? minimumValue - rawRange * 0.08 : 0;
  const yMaximum = maximumValue + rawRange * 0.1;
  const yScale = (value) =>
    plot.bottom - ((value - yMinimum) / (yMaximum - yMinimum)) * (plot.bottom - plot.top);
  const yTicks = Array.from({ length: 5 }, (_, index) =>
    yMinimum + ((yMaximum - yMinimum) * index) / 4,
  ).reverse();
  const xTickGroups = selectNonOverlappingDateTicks(eventGroups, xScale, 126);
  const markerPositions = eventGroups.map((group, index) => {
    const x = xScale(group.date);
    const previousX = index === 0 ? plot.left : xScale(eventGroups[index - 1].date);
    const nextX = index === eventGroups.length - 1 ? plot.right : xScale(eventGroups[index + 1].date);
    const left = index === 0 ? plot.left : (previousX + x) / 2;
    const right = index === eventGroups.length - 1 ? plot.right : (x + nextX) / 2;
    return { ...group, index, x, hitLeft: left, hitWidth: Math.max(12, right - left) };
  });
  const activeMarker = markerPositions[activeIndex] || markerPositions.at(-1);
  const paymentPath = buildStepPath(
    paymentPoints,
    (point) => xScale(point.date),
    yScale,
    plot.left,
    plot.right,
  );
  const percentPaid = charges > 0 ? (model.reportedTotal / charges) * 100 : null;

  function selectEvent(index) {
    const bounded = Math.max(0, Math.min(eventGroups.length - 1, index));
    setSelectedIndex(bounded);
    setHoveredIndex(null);
  }

  function handleMarkerKeyDown(event, index) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectEvent(index);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectEvent(index - 1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      selectEvent(index + 1);
    }
  }

  return (
    <section className="payment-chart-card" aria-labelledby="payment-chart-heading">
      <header className="payment-chart-header">
        <div>
          <p className="section-kicker">Financial progression</p>
          <h2 id="payment-chart-heading">Payments vs. charges</h2>
        </div>
        <div className="payment-chart-head-actions">
          {data.commentIntegration?.message ? (
            <span
              className={`integration-pill integration-${data.commentIntegration.status}`}
              title={data.commentIntegration.message}
            >
              {data.commentIntegration.categorizedCount || 0} categorized notes
            </span>
          ) : null}
          <details className="chart-legend-menu">
            <summary>Legend</summary>
            <div className="chart-legend-popover">
              <strong>Chart key</strong>
              <span><i className="legend-line legend-payment" />Counted payments</span>
              <span><i className="legend-line legend-charges" />Total charges</span>
              <span><i className="legend-marker legend-service" />Date of service</span>
              <span><i className="legend-marker legend-lifecycle" />Lifecycle event</span>
              <span><i className="legend-marker legend-submission" />Correction / rebill</span>
              <span><i className="legend-marker legend-payment-event" />Payment / remittance</span>
              <span><i className="legend-marker legend-comment" />Salesforce action</span>
            </div>
          </details>
        </div>
      </header>

      <div className="payment-chart-layout">
        <div className="chart-stage">
          <div className="main-chart-pane">
            <div className="chart-inline-legend" aria-hidden="true">
              <span><i className="legend-line legend-payment" />Payment amount</span>
              <span><i className="legend-line legend-charges" />Charges</span>
            </div>
            <svg
              className="payment-chart"
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              preserveAspectRatio="xMidYMin meet"
              role="img"
              aria-label={`Cumulative payments reached ${formatMoney(model.reportedTotal)} against ${formatMoney(charges)} in total charges. Event dates are spaced evenly.`}
            >
            {yTicks.map((tick) => {
              const y = yScale(tick);
              return (
                <g key={tick} className="chart-grid-line">
                  <line x1={plot.left} x2={plot.right} y1={y} y2={y} />
                  <text x={plot.left - 11} y={y + 3} textAnchor="end">{compactMoney(tick)}</text>
                </g>
              );
            })}

            <rect
              className="chart-active-date-band"
              x={activeMarker.hitLeft}
              y={plot.top}
              width={activeMarker.hitWidth}
              height={plot.bottom - plot.top}
            />

            {markerPositions.map((group) => (
              <line
                key={`event-line-${group.date}`}
                className={`chart-event-line ${group.index === activeIndex ? "chart-event-line-active" : ""}`}
                x1={group.x}
                x2={group.x}
                y1={plot.top}
                y2={plot.bottom}
              />
            ))}

            <line
              className="chart-charge-line"
              x1={plot.left}
              x2={plot.right}
              y1={yScale(charges)}
              y2={yScale(charges)}
            >
              <title>Total charges: {formatMoney(charges)}</title>
            </line>

            <path className="chart-payment-line" d={paymentPath} />
            {paymentPoints.map((point) => (
              <circle
                key={point.date}
                className={`chart-payment-point ${point.delta < 0 ? "chart-payment-reversal" : ""}`}
                cx={xScale(point.date)}
                cy={yScale(point.cumulative)}
                r={point.delta === 0 ? 3 : 5}
              >
                <title>{formatDate(point.date)}: cumulative payments {formatMoney(point.cumulative)}</title>
              </circle>
            ))}

            <line className="chart-axis" x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />
            {xTickGroups.map((group) => {
              const x = xScale(group.date);
              return (
                <g className="chart-x-tick" key={`tick-${group.date}`}>
                  <line x1={x} x2={x} y1={plot.bottom} y2={plot.bottom + 6} />
                  <text x={x} y={plot.bottom + 35} textAnchor="middle">{formatDate(group.date)}</text>
                </g>
              );
            })}

            {markerPositions.map((group) => {
              const title = `${formatDate(group.date)}: ${group.labels.join("; ")}`;
              return (
                <g
                  key={`event-interaction-${group.date}`}
                  className={`chart-event-marker chart-event-${group.kind} ${categoryClass(group.kind === "comment" ? group.primaryCategory : null)} ${group.index === activeIndex ? "chart-event-marker-active" : ""}`}
                  role="button"
                  tabIndex="0"
                  aria-label={`${title}. Cumulative payments ${formatMoney(group.cumulative)}.`}
                  onMouseEnter={() => setHoveredIndex(group.index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  onFocus={() => setHoveredIndex(group.index)}
                  onBlur={() => setHoveredIndex(null)}
                  onClick={() => selectEvent(group.index)}
                  onKeyDown={(event) => handleMarkerKeyDown(event, group.index)}
                >
                  <title>{title}</title>
                  <rect
                    className="chart-event-hitbox"
                    x={group.hitLeft}
                    y={plot.top}
                    width={group.hitWidth}
                    height={plot.bottom - plot.top + 28}
                  />
                  <circle cx={group.x} cy={plot.bottom + 17} r={group.index === activeIndex ? 7 : 5} />
                </g>
              );
            })}
            </svg>

            {Math.abs(model.unplottedAmount) >= 0.01 ? (
              <p className="payment-chart-note">{formatMoney(model.unplottedAmount)} has no dated event and is not plotted.</p>
            ) : null}
          </div>

          <CptPaymentShelf
            models={cptModels}
            activeIndex={activeIndex}
            activeDate={activeGroup.date}
            eventCount={eventGroups.length}
            onHover={setHoveredIndex}
          />
        </div>

        <LinkedTimeline
          data={data}
          activeDate={activeGroup.date}
          autoExpandKey={hoveredIndex == null ? null : `${eventGroupKey}:${hoveredIndex}`}
        />
      </div>
    </section>
  );
}

export function ClaimPaymentChart({
  data,
  selectedProcedure = null,
  onSelectedProcedureChange,
  onCptPaymentSnapshotChange,
}) {
  const [paymentView, setPaymentView] = useState("posted");
  const chartData = useMemo(() => paymentViewData(data, paymentView), [data, paymentView]);
  const model = useMemo(() => buildPaymentChartModel(chartData), [chartData]);
  const { eventGroups } = model;
  const cptModels = useMemo(() => buildCptPaymentModels(chartData, eventGroups).map((item) => ({ ...item, paymentView })), [chartData, eventGroups, paymentView]);
  const eventGroupKey = eventGroups.map((group) => group.date).join("|");
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const activeIndex = hoveredIndex ?? Math.max(0, eventGroups.length - 1);
  const activeGroup = eventGroups[activeIndex] || eventGroups.at(-1);
  const cptPaymentSnapshot = useMemo(() => {
    const snapshot = buildCptPaidSnapshot(cptModels, eventGroups, hoveredIndex);
    return {
      ...snapshot,
      paymentView,
      selectedProcedure,
      items: selectedProcedure
        ? snapshot.items.filter((item) => item.procedure === selectedProcedure)
        : snapshot.items,
    };
  }, [cptModels, eventGroups, hoveredIndex, paymentView, selectedProcedure]);

  useEffect(() => setHoveredIndex(null), [eventGroupKey]);

  useEffect(() => {
    onCptPaymentSnapshotChange?.(cptPaymentSnapshot);
  }, [cptPaymentSnapshot, onCptPaymentSnapshotChange]);

  if (eventGroups.length === 0) {
    return (
      <section className="payment-chart-card payment-chart-card-empty payment-chart-card-cpt-grid" aria-label="CPT payment charts">
        <div className="payment-chart-empty">
          <span aria-hidden="true">—</span>
          <div><strong>No dated CPT payments to graph</strong><p>Open the claim details to review the source record.</p></div>
        </div>
      </section>
    );
  }

  return (
    <section className="payment-chart-card payment-chart-card-cpt-grid" aria-labelledby="cpt-payment-heading">
      <div className="payment-view-switch" role="group" aria-label="Payment chart source">
        <button type="button" aria-pressed={paymentView === "posted"} onClick={() => setPaymentView("posted")}>Posted payment</button>
        <button type="button" aria-pressed={paymentView === "received"} onClick={() => setPaymentView("received")}>Payment received</button>
        <span>{paymentView === "posted" ? "Recorded on the posting date" : "Recorded on the ERA check / EFT date"}</span>
      </div>
      <div className="payment-chart-layout payment-chart-layout-cpt-grid">
        <div className="chart-stage cpt-grid-stage">
          <CptPaymentShelf
            models={cptModels}
            activeIndex={activeIndex}
            activeDate={activeGroup.date}
            eventCount={eventGroups.length}
            selectedProcedure={selectedProcedure}
            onHover={setHoveredIndex}
            onSelectedProcedureChange={onSelectedProcedureChange}
          />
        </div>

        <LinkedTimeline
          data={data}
          activeDate={activeGroup.date}
          autoExpandKey={hoveredIndex == null ? null : `${eventGroupKey}:${hoveredIndex}`}
          selectedProcedure={selectedProcedure}
        />
      </div>
    </section>
  );
}
