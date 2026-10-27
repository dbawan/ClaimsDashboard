import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { claimWorkspaceUrl } from "../claims/claimNavigation.js";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const exactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function formatMoney(value) {
  return currency.format(Number(value || 0));
}

function formatExactMoney(value) {
  return exactCurrency.format(Number(value || 0));
}

function formatDate(value) {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? shortDate.format(new Date(parsed)) : value;
}

function compactMoney(value) {
  const amount = Number(value || 0);
  const absolute = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(1)}m`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(0)}k`;
  return formatMoney(amount);
}

function seriesPath(points, field, xScale, yScale) {
  return points.map((point, index) => (
    `${index ? "L" : "M"} ${xScale(index)} ${yScale(point[field])}`
  )).join(" ");
}

function dateTicks(points) {
  if (points.length <= 5) return points.map((point, index) => ({ ...point, index }));
  const indexes = new Set([0, points.length - 1]);
  for (let step = 1; step < 4; step += 1) {
    indexes.add(Math.round((step / 4) * (points.length - 1)));
  }
  return [...indexes].sort((left, right) => left - right).map((index) => ({ ...points[index], index }));
}

function tooltipPosition(clientX, clientY) {
  const gap = 14;
  const width = Math.min(430, window.innerWidth - 16);
  const height = Math.min(500, window.innerHeight - 16);
  const fitsRight = clientX + gap + width <= window.innerWidth - 8;
  const fitsBelow = clientY + gap + height <= window.innerHeight - 8;
  return {
    left: Math.max(8, fitsRight ? clientX + gap : clientX - width - gap),
    top: Math.max(8, fitsBelow ? clientY + gap : clientY - height - gap),
  };
}

function DashboardHoverBubble({ point, position, id }) {
  const bubble = (
    <aside
      className="dashboard-hover-bubble"
      id={id}
      role="tooltip"
      style={{ left: position.left, top: position.top }}
    >
      <header>
        <div><span>Daily financial detail</span><strong>{formatDate(point.date)}</strong></div>
        <b>{point.claimCount.toLocaleString()} billed claim{point.claimCount === 1 ? "" : "s"}</b>
      </header>
      <dl>
        <div><dt>Exact billed</dt><dd>{formatExactMoney(point.billed)}</dd></div>
        <div><dt>Posted payment (net)</dt><dd>{formatExactMoney(point.posted)}</dd></div>
        <div><dt>Payment received</dt><dd className="amount-positive">{formatExactMoney(point.paid)}</dd></div>
        <div><dt>Exact recouped</dt><dd className="amount-negative">{formatExactMoney(point.recouped)}</dd></div>
        <div><dt>Remittance lines</dt><dd>{point.paymentLineCount.toLocaleString()}</dd></div>
        <div><dt>Denied lines</dt><dd>{point.deniedLineCount.toLocaleString()}</dd></div>
      </dl>

      <section>
        <div className="dashboard-hover-heading"><span>CPT codes billed</span><strong>{point.cpts.length}</strong></div>
        {point.cpts.length ? (
          <ol className="dashboard-hover-cpts">
            {point.cpts.map((cpt) => (
              <li key={cpt.procedure}>
                <strong>{cpt.procedure}</strong>
                <span>{cpt.count.toLocaleString()} line{cpt.count === 1 ? "" : "s"}</span>
                <b>{formatExactMoney(cpt.billed)}</b>
              </li>
            ))}
          </ol>
        ) : <p>No CPT charges were first billed on this date.</p>}
      </section>

      <section>
        <div className="dashboard-hover-heading"><span>Claims by highest billed</span><strong>{point.claims.length}</strong></div>
        {point.claims.length ? (
          <ol className="dashboard-hover-claims">
            {point.claims.map((claim) => (
              <li key={claim.claimId} title={[claim.patientName, claim.payer].filter(Boolean).join(" · ")}>
                <strong>{claim.claimId}</strong>
                <span>{claim.procedures.join(", ") || "No CPT"}</span>
                <b>{formatExactMoney(claim.billed)}</b>
              </li>
            ))}
          </ol>
        ) : <p>No claims were first billed on this date.</p>}
      </section>
    </aside>
  );
  return typeof document === "undefined" ? null : createPortal(bubble, document.body);
}

function DashboardLineChart({ data, billingMode, onBillingModeChange, visibleSeries, onToggleSeries, selectedDate, onSelectDate }) {
  const width = 900;
  const height = 244;
  const plot = { left: 68, right: 884, top: 12, bottom: 190 };
  const minimum = Math.min(0, ...data.daily.flatMap((point) => [
    visibleSeries.recouped ? point.recouped : 0, visibleSeries.posted ? point.posted || 0 : 0,
  ]));
  const maximum = Math.max(1, ...data.daily.flatMap((point) => [
    visibleSeries.billed ? point.billed : 0,
    visibleSeries.paid ? point.paid : 0,
    visibleSeries.posted ? point.posted || 0 : 0,
  ]));
  const rawRange = maximum - minimum || 1;
  const yMinimum = minimum < 0 ? minimum - rawRange * 0.06 : 0;
  const yMaximum = maximum + rawRange * 0.08;
  const xScale = (index) => data.daily.length <= 1
    ? (plot.left + plot.right) / 2
    : plot.left + (index / (data.daily.length - 1)) * (plot.right - plot.left);
  const yScale = (value) => plot.bottom
    - ((Number(value || 0) - yMinimum) / (yMaximum - yMinimum)) * (plot.bottom - plot.top);
  const yTicks = Array.from({ length: 5 }, (_, index) => (
    yMaximum - ((yMaximum - yMinimum) * index) / 4
  ));
  const ticks = dateTicks(data.daily);
  const nonzeroPoints = data.daily
    .map((point, index) => ({ ...point, index }))
    .filter((point) => (visibleSeries.billed && point.billed)
      || (visibleSeries.posted && point.posted)
      || (visibleSeries.paid && point.paid)
      || (visibleSeries.recouped && point.recouped));
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const tooltipId = useId();
  const hoverPoint = hover ? data.daily[hover.index] : null;
  const selectedIndex = data.daily.findIndex((point) => point.date === selectedDate);

  function showPoint(index, clientX, clientY) {
    setHover({ index, ...tooltipPosition(clientX, clientY) });
  }

  function indexAtClientX(clientX) {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || !data.daily.length) return null;
    const viewX = ((clientX - bounds.left) / Math.max(1, bounds.width)) * width;
    const ratio = Math.max(0, Math.min(1, (viewX - plot.left) / (plot.right - plot.left)));
    return data.daily.length === 1 ? 0 : Math.round(ratio * (data.daily.length - 1));
  }

  function updateHover(clientX, clientY) {
    const index = indexAtClientX(clientX);
    if (index == null) return;
    showPoint(index, clientX, clientY);
  }

  function focusPoint(index) {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const point = data.daily[index];
    const focusValue = visibleSeries.billed
      ? point?.billed
      : visibleSeries.posted
        ? point?.posted
        : visibleSeries.paid
        ? point?.paid
        : visibleSeries.recouped
          ? point?.recouped
          : 0;
    const x = bounds.left + (xScale(index) / width) * bounds.width;
    const y = bounds.top + (yScale(focusValue || 0) / height) * bounds.height;
    showPoint(index, x, y);
  }

  return (
    <section className="dashboard-financial-chart" aria-labelledby="dashboard-financial-heading">
      <header>
        <div>
          <span>Daily financial movement · hover for details · click to select</span>
          <h2 id="dashboard-financial-heading">Billed, posted, and received payments</h2>
        </div>
        <div className="dashboard-chart-tools">
          <div className="dashboard-billing-switch" role="group" aria-label="Claim billing submissions">
            <button type="button" aria-pressed={billingMode === "all"} onClick={() => onBillingModeChange("all")}>All submissions</button>
            <button type="button" aria-pressed={billingMode === "latest"} onClick={() => onBillingModeChange("latest")}>Latest only</button>
            <button type="button" aria-pressed={billingMode === "original"} onClick={() => onBillingModeChange("original")}>Original only</button>
          </div>
          <div className="dashboard-series-switch" role="group" aria-label="Visible financial lines">
            <button type="button" aria-pressed={visibleSeries.billed} onClick={() => onToggleSeries("billed")}><i className="dashboard-legend-billed" />Amount billed</button>
            <button type="button" aria-pressed={visibleSeries.posted} onClick={() => onToggleSeries("posted")}><i className="dashboard-legend-posted" />Posted payment</button>
            <button type="button" aria-pressed={visibleSeries.paid} onClick={() => onToggleSeries("paid")}><i className="dashboard-legend-paid" />Payment received</button>
            <button type="button" aria-pressed={visibleSeries.recouped} onClick={() => onToggleSeries("recouped")}><i className="dashboard-legend-recouped" />ERA recoupments</button>
          </div>
        </div>
      </header>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        tabIndex="0"
        aria-describedby={hover ? tooltipId : undefined}
        aria-label={`${formatMoney(data.totals.billed)} billed, ${formatMoney(data.totals.posted)} posted, ${formatMoney(data.totals.paid)} received, and ${formatMoney(Math.abs(data.totals.recouped))} recouped from ${formatDate(data.start)} through ${formatDate(data.end)}. Hover or use arrow keys for daily details, then click or press Enter to select a date.`}
        onPointerMove={(event) => updateHover(event.clientX, event.clientY)}
        onPointerLeave={() => setHover(null)}
        onClick={(event) => {
          const index = indexAtClientX(event.clientX);
          if (index != null) onSelectDate(data.daily[index].date);
        }}
        onFocus={() => focusPoint(Math.max(0, data.daily.length - 1))}
        onBlur={() => setHover(null)}
        onKeyDown={(event) => {
          if (hover && ["Enter", " "].includes(event.key)) {
            event.preventDefault();
            onSelectDate(data.daily[hover.index].date);
            return;
          }
          if (!hover || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          focusPoint(Math.max(0, Math.min(data.daily.length - 1, hover.index + direction)));
        }}
      >
        {yTicks.map((tick) => (
          <g className="dashboard-grid-line" key={tick}>
            <line x1={plot.left} x2={plot.right} y1={yScale(tick)} y2={yScale(tick)} />
            <text x={plot.left - 10} y={yScale(tick) + 3} textAnchor="end">{compactMoney(tick)}</text>
          </g>
        ))}
        {yMinimum < 0 ? <line className="dashboard-zero-line" x1={plot.left} x2={plot.right} y1={yScale(0)} y2={yScale(0)} /> : null}
        {visibleSeries.billed ? <path className="dashboard-billed-line" d={seriesPath(data.daily, "billed", xScale, yScale)} /> : null}
        {visibleSeries.posted ? <path className="dashboard-posted-line" d={seriesPath(data.daily, "posted", xScale, yScale)} /> : null}
        {visibleSeries.paid ? <path className="dashboard-paid-line" d={seriesPath(data.daily, "paid", xScale, yScale)} /> : null}
        {visibleSeries.recouped ? <path className="dashboard-recouped-line" d={seriesPath(data.daily, "recouped", xScale, yScale)} /> : null}
        {nonzeroPoints.map((point) => (
          <g key={point.date}>
            {visibleSeries.billed && point.billed ? <circle className="dashboard-billed-point" cx={xScale(point.index)} cy={yScale(point.billed)} r="3.5" /> : null}
            {visibleSeries.posted && point.posted ? <circle className="dashboard-posted-point" cx={xScale(point.index)} cy={yScale(point.posted)} r="3.5" /> : null}
            {visibleSeries.paid && point.paid ? <circle className="dashboard-paid-point" cx={xScale(point.index)} cy={yScale(point.paid)} r="3.5" /> : null}
            {visibleSeries.recouped && point.recouped ? <circle className="dashboard-recouped-point" cx={xScale(point.index)} cy={yScale(point.recouped)} r="3.5" /> : null}
          </g>
        ))}
        {selectedIndex >= 0 ? (
          <g className="dashboard-selected-marker" aria-hidden="true">
            <line x1={xScale(selectedIndex)} x2={xScale(selectedIndex)} y1={plot.top} y2={plot.bottom} />
          </g>
        ) : null}
        {hoverPoint ? (
          <g className="dashboard-hover-marker" aria-hidden="true">
            <line x1={xScale(hover.index)} x2={xScale(hover.index)} y1={plot.top} y2={plot.bottom} />
            {visibleSeries.billed ? <circle cx={xScale(hover.index)} cy={yScale(hoverPoint.billed)} r="5" className="dashboard-billed-point" /> : null}
            {visibleSeries.posted ? <circle cx={xScale(hover.index)} cy={yScale(hoverPoint.posted)} r="5" className="dashboard-posted-point" /> : null}
            {visibleSeries.paid ? <circle cx={xScale(hover.index)} cy={yScale(hoverPoint.paid)} r="5" className="dashboard-paid-point" /> : null}
            {visibleSeries.recouped ? <circle cx={xScale(hover.index)} cy={yScale(hoverPoint.recouped)} r="5" className="dashboard-recouped-point" /> : null}
          </g>
        ) : null}
        <line className="dashboard-chart-axis" x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />
        {ticks.map((tick) => (
          <text className="dashboard-date-tick" x={xScale(tick.index)} y={plot.bottom + 30} textAnchor={tick.index === 0 ? "start" : tick.index === data.daily.length - 1 ? "end" : "middle"} key={tick.date}>
            {formatDate(tick.date)}
          </text>
        ))}
      </svg>
      {hoverPoint ? <DashboardHoverBubble point={hoverPoint} position={hover} id={tooltipId} /> : null}
    </section>
  );
}

function DailyClaimList({ title, tone, claims, amountField, emptyMessage }) {
  return (
    <article className={`dashboard-date-claim-list dashboard-date-claim-list-${tone}`}>
      <header><strong>{title}</strong><span>{claims.length.toLocaleString()}</span></header>
      {claims.length ? (
        <ol>
          {claims.map((claim) => (
            <li key={claim.claimId}>
              <a
                href={claimWorkspaceUrl(claim.claimId)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open claim ${claim.claimId} in a new tab`}
                title={`Open claim ${claim.claimId} in a new tab`}
              >
                <div>
                  <strong>{claim.claimId}</strong>
                  <span>{claim.procedures.join(", ") || "No CPT provided"}</span>
                  <small>{claim.patientName || claim.payer || (claim.serviceDate ? `Service ${formatDate(claim.serviceDate)}` : "Claim details available")}</small>
                </div>
                <b className={claim[amountField] < 0 ? "amount-negative" : ""}>{formatExactMoney(claim[amountField])}</b>
                <i aria-hidden="true">↗</i>
              </a>
            </li>
          ))}
        </ol>
      ) : <p>{emptyMessage}</p>}
    </article>
  );
}

function DailyClaimLists({ point }) {
  if (!point) {
    return (
      <section className="dashboard-date-selection dashboard-date-selection-empty">
        <strong>Select a date on the graph</strong>
        <span>The billed, posted, received, and recouped claim lists for that date will appear here.</span>
      </section>
    );
  }

  return (
    <section className="dashboard-date-selection" aria-labelledby="dashboard-selected-date-heading">
      <header>
        <div><span>Selected date</span><h2 id="dashboard-selected-date-heading">{formatDate(point.date)}</h2></div>
        <dl>
          <div><dt>Billed</dt><dd>{formatExactMoney(point.billed)}</dd></div>
          <div><dt>Posted</dt><dd>{formatExactMoney(point.posted)}</dd></div>
          <div><dt>Received</dt><dd className="amount-positive">{formatExactMoney(point.paid)}</dd></div>
          <div><dt>Recouped</dt><dd className="amount-negative">{formatExactMoney(point.recouped)}</dd></div>
        </dl>
      </header>
      <div className="dashboard-date-claim-columns">
        <DailyClaimList title="Posted payments" tone="posted" claims={point.postedClaims || []} amountField="posted" emptyMessage="No payments were posted on this date." />
        <DailyClaimList
          title="Claims billed"
          tone="billed"
          claims={point.claims}
          amountField="billed"
          emptyMessage="No claims were billed on this date."
        />
        <DailyClaimList
          title="Payments received"
          tone="paid"
          claims={point.paidClaims}
          amountField="paid"
          emptyMessage="No claim payments were recorded on this date."
        />
        <DailyClaimList
          title="Claims recouped"
          tone="recouped"
          claims={point.recoupedClaims}
          amountField="recouped"
          emptyMessage="No claim recoupments were recorded on this date."
        />
      </div>
    </section>
  );
}

function Metric({ label, value, detail, tone = "navy" }) {
  return (
    <article className={`dashboard-metric dashboard-metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function PayerFilter({ options, selectedPayers, onChange }) {
  const [draft, setDraft] = useState(selectedPayers);
  const detailsRef = useRef(null);

  useEffect(() => setDraft(selectedPayers), [selectedPayers]);

  const selectedLabels = options
    .filter((option) => selectedPayers.includes(option.key))
    .map((option) => option.label);
  const summary = selectedLabels.length === 0
    ? "All payers"
    : selectedLabels.length === 1
      ? selectedLabels[0]
      : `${selectedLabels.length} payers selected`;

  function togglePayer(key) {
    setDraft((current) => current.includes(key)
      ? current.filter((payer) => payer !== key)
      : [...current, key]);
  }

  function applySelection() {
    onChange([...draft].sort());
    detailsRef.current?.removeAttribute("open");
  }

  return (
    <article className="dashboard-payer-filter">
      <span>Filter dashboard</span>
      <details ref={detailsRef}>
        <summary title={summary}>
          <strong>{summary}</strong>
          <small>{options.length.toLocaleString()} payer bucket{options.length === 1 ? "" : "s"}</small>
          <i aria-hidden="true">⌄</i>
        </summary>
        <div className="dashboard-payer-menu">
          <header><strong>Choose payers</strong><span>Distinct claims in this range</span></header>
          <ol>
            <li>
              <label>
                <input type="checkbox" checked={!draft.length} onChange={() => setDraft([])} />
                <span>All payers</span>
                <b>{options.length.toLocaleString()} buckets</b>
              </label>
            </li>
            {options.map((option) => (
              <li key={option.key}>
                <label title={option.label}>
                  <input
                    type="checkbox"
                    checked={draft.includes(option.key)}
                    onChange={() => togglePayer(option.key)}
                  />
                  <span>{option.label}</span>
                  <b>{option.claimCount.toLocaleString()} claim{option.claimCount === 1 ? "" : "s"}</b>
                </label>
              </li>
            ))}
          </ol>
          <footer>
            <button type="button" onClick={() => setDraft([])}>Clear</button>
            <button type="button" onClick={applySelection}>Apply</button>
          </footer>
        </div>
      </details>
    </article>
  );
}

function DenialReasons({ reasons }) {
  const [selectedReason, setSelectedReason] = useState(null);
  const maximumReasonCount = Math.max(1, ...reasons.map((reason) => reason.count));
  const activeReason = reasons.find((reason) => reason.reason === selectedReason) || null;

  return (
    <section className="dashboard-denials dashboard-reasons" aria-labelledby="dashboard-denials-heading">
      <header>
        <div><span>Denial intelligence</span><h2 id="dashboard-denials-heading">Highest denial reasons</h2></div>
        <small>Click a reason for CPTs</small>
      </header>
      {reasons.length ? (
        <div className={`dashboard-reason-body${activeReason ? " dashboard-reason-body-expanded" : ""}`}>
          <ol>
            {reasons.map((reason, index) => {
              const active = activeReason?.reason === reason.reason;
              return (
                <li className={active ? "dashboard-denial-active" : ""} key={reason.reason}>
                  <button type="button" aria-expanded={active} onClick={() => setSelectedReason(active ? null : reason.reason)}>
                    <span>{index + 1}</span>
                    <div>
                      <strong title={reason.reason}>{reason.reason}</strong>
                      <i><b style={{ width: `${(reason.count / maximumReasonCount) * 100}%` }} /></i>
                    </div>
                    <em>{reason.count}</em>
                  </button>
                </li>
              );
            })}
          </ol>
          {activeReason ? (
            <div className="dashboard-reason-cpts">
              <strong>{activeReason.reason} by CPT</strong>
              <ol>
                {activeReason.cpts.map((cpt) => (
                  <li key={cpt.procedure}><span>{cpt.procedure}</span><b>{cpt.count.toLocaleString()}</b></li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      ) : <p>No zero-paid remittance lines with denial reasons were found in this range.</p>}
    </section>
  );
}

function DeniedCptList({ deniedCpts }) {
  const [sort, setSort] = useState("count");
  const [selectedProcedure, setSelectedProcedure] = useState(null);
  const sortedCpts = useMemo(() => [...deniedCpts].sort((left, right) => (
    sort === "average"
      ? Number(right.averageBilled || 0) - Number(left.averageBilled || 0) || right.count - left.count
      : right.count - left.count || Number(right.averageBilled || 0) - Number(left.averageBilled || 0)
  ) || left.procedure.localeCompare(right.procedure)), [deniedCpts, sort]);
  const activeCpt = deniedCpts.find((cpt) => cpt.procedure === selectedProcedure) || null;

  return (
    <section className="dashboard-denials dashboard-denied-cpts" aria-labelledby="dashboard-denied-cpts-heading">
      <header>
        <div><span>CPT denial mix</span><h2 id="dashboard-denied-cpts-heading">Top denied CPT codes</h2></div>
        <label><span>Sort</span><select aria-label="Sort denied CPT codes" value={sort} onChange={(event) => setSort(event.target.value)}><option value="count">Denial count</option><option value="average">Average billed</option></select></label>
      </header>
      {sortedCpts.length ? (
        <div className={`dashboard-cpt-body${activeCpt ? " dashboard-cpt-body-expanded" : ""}`}>
          <div className="dashboard-cpt-table">
            <div className="dashboard-cpt-table-heading"><span>CPT</span><span>Avg. billed</span><span>Denials</span></div>
            <ol>
              {sortedCpts.map((cpt) => {
                const active = activeCpt?.procedure === cpt.procedure;
                return (
                  <li className={active ? "dashboard-cpt-active" : ""} key={cpt.procedure}>
                    <button type="button" aria-expanded={active} onClick={() => setSelectedProcedure(active ? null : cpt.procedure)}>
                      <strong>{cpt.procedure}</strong>
                      <span>{cpt.averageBilled == null ? "—" : formatExactMoney(cpt.averageBilled)}</span>
                      <b>{cpt.count.toLocaleString()}</b>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
          {activeCpt ? (
            <div className="dashboard-denied-cpt-claims">
              <header><strong>{activeCpt.procedure} · latest billed</strong><span>{activeCpt.claims.length} claim{activeCpt.claims.length === 1 ? "" : "s"}</span></header>
              {activeCpt.claims.length ? (
                <ol>
                  {activeCpt.claims.map((claim) => (
                    <li key={claim.claimId}>
                      <a
                        href={claimWorkspaceUrl(claim.claimId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open claim ${claim.claimId} in a new tab`}
                      >
                        <div><strong>{claim.claimId}</strong><small>{claim.latestBillingDate ? `Latest bill ${formatDate(claim.latestBillingDate)}` : "Latest bill unavailable"}</small></div>
                        <b>{claim.billed == null ? "—" : formatExactMoney(claim.billed)}</b>
                        <i aria-hidden="true">↗</i>
                      </a>
                    </li>
                  ))}
                </ol>
              ) : <p>No denied claims were available for this CPT.</p>}
            </div>
          ) : null}
        </div>
      ) : <p>No denied CPT lines were found in this range.</p>}
    </section>
  );
}

export function HighLevelDashboard({
  data,
  billingMode,
  onBillingModeChange,
  visibleSeries,
  onToggleSeries,
  selectedPayers = [],
  onPayersChange,
}) {
  const [selectedDate, setSelectedDate] = useState(null);
  const selectedPoint = data.daily.find((point) => point.date === selectedDate) || null;
  const paymentRate = data.totals.billed > 0
    ? (data.totals.paid / data.totals.billed) * 100
    : 0;

  return (
    <div className="high-level-dashboard">
      <section className="dashboard-metrics" aria-label="Dashboard totals">
        <Metric label="Posted payment" value={formatMoney(data.totals.posted)} detail="Net ledger amount · posting date" tone="green" />
        <Metric label="Payment received" value={formatMoney(data.totals.paid)} detail={`${paymentRate.toFixed(1)}% of billed · ${formatMoney(Math.abs(data.totals.recouped))} recouped`} tone="green" />
        <Metric
          label="Total billed"
          value={formatMoney(data.totals.billed)}
          detail={billingMode === "latest"
            ? "Latest submission in each claim family"
            : billingMode === "original"
              ? "Claim created transactions"
              : "All original and rebilled submissions"}
        />
        <Metric label="Denied lines" value={data.totals.deniedLines.toLocaleString()} detail="Zero-paid lines with reasons" tone="amber" />
        <PayerFilter
          options={data.payerOptions || []}
          selectedPayers={selectedPayers}
          onChange={onPayersChange}
        />
      </section>

      <div className="dashboard-body">
        <div className="dashboard-left-column">
          <DashboardLineChart
            data={data}
            billingMode={billingMode}
            onBillingModeChange={onBillingModeChange}
            visibleSeries={visibleSeries}
            onToggleSeries={onToggleSeries}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
          />
          <DailyClaimLists point={selectedPoint} />
        </div>
        <div className="dashboard-right-rail">
          <DenialReasons reasons={data.denialReasons} />
          <DeniedCptList deniedCpts={data.deniedCpts} />
        </div>
      </div>
    </div>
  );
}
