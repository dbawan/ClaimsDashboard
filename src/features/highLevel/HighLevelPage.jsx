import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { claimWorkspaceUrl } from "../claims/claimNavigation.js";
import { fetchHighLevelClaimIcu, fetchHighLevelClaims, fetchHighLevelDashboard, fetchHighLevelQueue } from "./api.js";
import { HighLevelDashboard } from "./HighLevelDashboard.jsx";
import { QueueDetailDialog } from "./QueueDetailDialog.jsx";
import { ClaimCptPayments } from "./ClaimCptPayments.jsx";
import { ClaimIcu } from "./ClaimIcu.jsx";
import {
  appointmentMinimumAge,
  buildHoverSnapshot,
  buildTrack,
  dateAtPosition,
  equalEventPosition,
  eventIndexForPosition,
  positionForDate,
  resolveDateRange,
  STATUS_LABELS,
} from "./highLevelModel.js";

const MODES = Object.freeze([
  ["icu", "Claim ICU"],
  ["dashboard", "Dashboard"],
  ["claims", "Claims"],
  ["unsubmitted", "Unsubmitted"],
  ["no-response", "No response"],
]);

const SORT_OPTIONS = Object.freeze([
  ["paid-percent", "Highest posted %"],
  ["youngest", "Youngest claim"],
  ["oldest", "Oldest claim"],
  ["billed", "Highest billed"],
]);

const RANGE_OPTIONS = Object.freeze([
  ["7", "Past 7 days"],
  ["30", "Past 30 days"],
  ["60", "Past 60 days"],
  ["90", "Past 90 days"],
  ["custom-days", "Past custom days"],
  ["custom-dates", "Custom dates"],
]);

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function initialDates() {
  const today = isoDate(new Date());
  return resolveDateRange("30", null, null, today);
}

function formatShortDate(value) {
  if (!value) return "—";
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? dateFormatter.format(new Date(parsed)) : value;
}

function axisTicks(start, end) {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    return isoDate(new Date(startTime + (endTime - startTime) * ratio));
  });
}


function StatusLegend() {
  return (
    <div className="high-level-legend" aria-label="Status legend">
      {[
        ["created", "Created"],
        ["submitted", "Submitted"],
        ["pending", "Pending"],
        ["action", "Action"],
        ["paid", "Posted"],
        ["received", "Received"],
      ].map(([status, label]) => <span className={`status-${status}`} key={status}>{label}</span>)}
    </div>
  );
}

function ClaimHoverBubble({ claim, snapshot, event, position, id }) {
  const eventStatus = event?.status || snapshot.status;
  const thresholdPercent = claim.paidThresholdPercent || 50;
  const bubble = (
    <aside
      className="claim-hover-bubble"
      id={id}
      role="tooltip"
      style={{ left: position.left, top: position.top }}
    >
      <header>
        <div><strong>{claim.claimId}</strong><span>{formatShortDate(snapshot.date)}</span></div>
        <span className={`claim-hover-status status-${eventStatus}`}>{STATUS_LABELS[eventStatus] || eventStatus}</span>
      </header>
      <dl>
        <div><dt>Patient</dt><dd>{claim.patientName || "Not provided"}</dd></div>
        <div><dt>Payer</dt><dd>{claim.payer || "Not provided"}</dd></div>
        <div><dt>Service</dt><dd>{formatShortDate(claim.serviceDate)}</dd></div>
        <div><dt>Event</dt><dd>{event?.label || snapshot.lastEvent?.label || "No activity yet"}</dd></div>
        <div><dt>Billed</dt><dd>{moneyFormatter.format(claim.billedAmount || 0)}</dd></div>
        <div><dt>Posted payment</dt><dd>{moneyFormatter.format(claim.paidAmount || 0)} · {Math.round((claim.paidPercent || 0) * 100)}%</dd></div>
        <div><dt>Payment received</dt><dd>{moneyFormatter.format(claim.receivedAmount || 0)}</dd></div>
        <div><dt>{thresholdPercent}% posted</dt><dd>{claim.daysToPaid != null ? `${claim.daysToPaid} days · ${formatShortDate(claim.paidThresholdDate)}` : "Not reached"}</dd></div>
      </dl>
      <div className="claim-hover-cpt-heading"><span>CPT through this date</span><strong>{snapshot.procedures.length}</strong></div>
      {snapshot.procedures.length ? (
        <ol>
          {snapshot.procedures.slice(0, 6).map((procedure) => (
            <li key={procedure.procedure}>
              <strong>{procedure.procedure}</strong>
              <span>{moneyFormatter.format(procedure.charge)} charged</span>
              <b className={procedure.paid < 0 ? "amount-negative" : "amount-positive"}>{moneyFormatter.format(procedure.paid)} posted</b>
            </li>
          ))}
        </ol>
      ) : <p>No CPT-level payment detail by this date.</p>}
    </aside>
  );
  return typeof document === "undefined" ? null : createPortal(bubble, document.body);
}

function ClaimTrack({ claim, start, end }) {
  const track = useMemo(() => buildTrack(claim, start, end), [claim, start, end]);
  const currentPercent = positionForDate(track.currentDate, start, end);
  const [hover, setHover] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const trackRef = useRef(null);
  const tooltipId = useId();
  const paymentsId = useId();
  const snapshot = useMemo(
    () => hover ? buildHoverSnapshot(claim, hover.date) : null,
    [claim, hover],
  );
  const currentStatusLabel = claim.currentStatus === "action" && claim.issueLabel
    ? claim.issueLabel
    : STATUS_LABELS[claim.currentStatus] || claim.currentStatus;
  const thresholdPercent = claim.paidThresholdPercent || 50;
  const hasPaidTiming = claim.daysToPaid != null;
  const paidTimingTitle = claim.paidThresholdAmount == null
    ? "Paid timing is unavailable because this claim has no latest charge"
    : hasPaidTiming
      ? `Reached ${thresholdPercent}% posted (${moneyFormatter.format(claim.paidThresholdAmount)}) on ${formatShortDate(claim.paidThresholdDate)}, ${claim.daysToPaid} day${claim.daysToPaid === 1 ? "" : "s"} after claim creation`
      : `Has not reached the ${thresholdPercent}% posted threshold (${moneyFormatter.format(claim.paidThresholdAmount)})`;

  function bubblePosition(clientX, clientY) {
    const gap = 14;
    const bubbleWidth = Math.min(350, window.innerWidth - 16);
    const bubbleHeight = Math.min(320, window.innerHeight - 16);
    const fitsRight = clientX + gap + bubbleWidth <= window.innerWidth - 8;
    const fitsBelow = clientY + gap + bubbleHeight <= window.innerHeight - 8;
    return {
      left: Math.max(8, fitsRight ? clientX + gap : clientX - bubbleWidth - gap),
      top: Math.max(8, fitsBelow ? clientY + gap : clientY - bubbleHeight - gap),
    };
  }

  function showEvent(eventIndex, clientX, clientY) {
    const event = track.markers[eventIndex];
    const fallbackDate = dateAtPosition(50, start, end);
    setHover({
      eventIndex,
      date: event?.date || fallbackDate,
      ...bubblePosition(clientX, clientY),
    });
  }

  function updateHover(clientX, clientY) {
    if (expanded) return;
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const percent = ((clientX - bounds.left) / Math.max(1, bounds.width)) * 100;
    showEvent(eventIndexForPosition(percent, track.markers.length), clientX, clientY);
  }

  function togglePayments() {
    setHover(null);
    setExpanded((current) => !current);
  }

  return (
    <li
      className={`high-level-claim-row${hover ? " claim-row-expanded" : ""}${expanded ? " claim-row-payments-open" : ""}`}
    >
      <a
        className="high-level-claim-label"
        href={claimWorkspaceUrl(claim.claimId)}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open claim ${claim.claimId} in a new tab`}
        aria-label={`Open claim ${claim.claimId} in a new tab`}
      >
        <div><strong>{claim.claimId}</strong><span className={`claim-current-status status-${claim.currentStatus}`} title={currentStatusLabel}>{currentStatusLabel}</span></div>
        <small className="claim-patient-invoices">
          <span title={claim.patientName || "Patient not provided"}>{claim.patientName || "Patient not provided"}</span>
          <b
            className={claim.invoiceMatchAmbiguous ? "claim-invoice-count-ambiguous" : undefined}
            title={claim.invoiceMatchAmbiguous
              ? `Review required: date-only invoice match also applies to ${(claim.invoiceCandidateClaimIds || []).join(", ")}`
              : `${claim.invoiceRowCount || 0} matching patient invoice rows`}
          >
            {claim.invoiceMatchAmbiguous ? "⚑ " : ""}{claim.invoiceRowCount || 0} invoice row{claim.invoiceRowCount === 1 ? "" : "s"}
          </b>
        </small>
        <small className="claim-payer-charge">
          <span title={claim.payer || "Payer not provided"}>{claim.payer || "Payer not provided"}</span>
          <b title={`Latest charge: ${moneyFormatter.format(claim.latestChargeAmount || 0)}`}>
            <span>Latest </span>{moneyFormatter.format(claim.latestChargeAmount || 0)}
          </b>
        </small>
        <small className={`claim-paid-age${hasPaidTiming ? " claim-paid-age-reached" : ""}`} title={paidTimingTitle}>
          <span>{thresholdPercent}% posted</span>
          <b>{hasPaidTiming ? `Paid in ${claim.daysToPaid}d` : "Not reached"}</b>
        </small>
      </a>
      <div
        className="high-level-track"
        ref={trackRef}
        role="button"
        tabIndex={0}
        aria-label={`${expanded ? "Hide" : "Show"} CPT payments for claim ${claim.claimId}`}
        aria-expanded={expanded}
        aria-controls={paymentsId}
        aria-describedby={hover ? tooltipId : undefined}
        onClick={togglePayments}
        onPointerMove={(event) => updateHover(event.clientX, event.clientY)}
        onPointerLeave={() => setHover(null)}
        onFocus={() => {
          if (expanded) return;
          const bounds = trackRef.current?.getBoundingClientRect();
          if (bounds) {
            const index = Math.max(0, track.markers.length - 1);
            const x = bounds.left + (equalEventPosition(index, track.markers.length) / 100) * bounds.width;
            showEvent(index, x, bounds.top + bounds.height / 2);
          }
        }}
        onBlur={() => setHover(null)}
        onKeyDown={(event) => {
          if (["Enter", " "].includes(event.key)) {
            event.preventDefault();
            togglePayments();
            return;
          }
          if (event.key === "Escape") { setHover(null); setExpanded(false); return; }
          if (expanded || !["ArrowLeft", "ArrowRight"].includes(event.key) || !track.markers.length) return;
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          const index = Math.max(0, Math.min(track.markers.length - 1, (hover?.eventIndex ?? 0) + direction));
          const bounds = trackRef.current?.getBoundingClientRect();
          if (bounds) {
            const x = bounds.left + (equalEventPosition(index, track.markers.length) / 100) * bounds.width;
            showEvent(index, x, bounds.top + bounds.height / 2);
          }
        }}
      >
        {track.segments.map((segment, index) => {
          const left = positionForDate(segment.start, start, end);
          const right = positionForDate(segment.end, start, end);
          const width = right - left;
          return (
            <span
              className={`claim-track-segment status-${segment.status}`}
              style={{ left: `${left}%`, width: `${Math.max(0.35, width)}%` }}
              key={`${segment.start}-${segment.end}-${index}`}
            >
              {width >= 9 ? <b>{STATUS_LABELS[segment.status] || segment.status}</b> : null}
            </span>
          );
        })}
        {track.markers.map((event, index) => (
          <i
            className={`claim-track-event status-${event.status}`}
            style={{ left: `${positionForDate(event.date, start, end)}%` }}
            title={`${formatShortDate(event.date)} · ${event.label}${event.amount != null ? ` · $${Number(event.amount).toLocaleString()}` : ""}`}
            key={`${event.date}-${event.status}-${index}`}
          />
        ))}
        <span
          className={`claim-track-current status-${track.currentStatus}${currentPercent < 8 ? " claim-track-current-start" : ""}${currentPercent > 92 ? " claim-track-current-end" : ""}`}
          style={{ left: `${currentPercent}%` }}
        >
          {track.currentStatus === "action" && claim.issueLabel
            ? claim.issueLabel
            : STATUS_LABELS[track.currentStatus] || track.currentStatus}
        </span>
        <div className="claim-equal-events" aria-hidden="true">
          {track.markers.map((event, index) => {
            const position = equalEventPosition(index, track.markers.length);
            const active = hover?.eventIndex === index;
            return (
              <span
                className={`claim-equal-event status-${event.status}${active ? " claim-equal-event-active" : ""}${position < 12 ? " claim-equal-event-start" : ""}${position > 88 ? " claim-equal-event-end" : ""}`}
                style={{ left: `${position}%` }}
                key={`${event.date}-${event.status}-${index}`}
              >
                <i>{index + 1}</i>
                {active ? <b>{formatShortDate(event.date)} · {event.label}</b> : null}
              </span>
            );
          })}
        </div>
        <span className="claim-expand-hint" aria-hidden="true">{expanded ? "Hide CPT payments" : "CPT payments"}<b>{expanded ? "⌃" : "⌄"}</b></span>
      </div>
      {expanded ? <ClaimCptPayments claim={claim} id={paymentsId} /> : null}
      {hover && snapshot ? (
        <ClaimHoverBubble claim={claim} snapshot={snapshot} event={track.markers[hover.eventIndex]} position={hover} id={tooltipId} />
      ) : null}
    </li>
  );
}

export function ClaimOverview({ data, onPageChange }) {
  const ticks = axisTicks(data.start, data.end);
  const firstClaim = data.total ? data.offset + 1 : 0;
  const lastClaim = data.offset + data.claims.length;
  return (
    <section className="high-level-chart" aria-label="Claim status over time">
      <header className="high-level-chart-header">
        <span><strong>{firstClaim}–{lastClaim}</strong> of {data.total} claims</span>
        <small className="claim-hover-hint">Hover for events · Click a row for CPT payments</small>
        <nav className="claim-pagination" aria-label="Claim pages">
          <button
            type="button"
            disabled={data.page <= 1}
            aria-label="Previous claim page"
            onClick={() => onPageChange(data.page - 1)}
          >
            ‹
          </button>
          <span>Page <strong>{data.page}</strong> of {data.totalPages}</span>
          <button
            type="button"
            disabled={data.page >= data.totalPages}
            aria-label="Next claim page"
            onClick={() => onPageChange(data.page + 1)}
          >
            ›
          </button>
        </nav>
        <StatusLegend />
      </header>
      <div className="high-level-axis-row" aria-hidden="true">
        <span className="high-level-axis-spacer" />
        <div className="high-level-axis">
          {ticks.map((tick, index) => <span style={{ left: `${index * 25}%` }} key={`${tick}-${index}`}>{formatShortDate(tick)}</span>)}
        </div>
      </div>
      <ol className="high-level-claim-list">
        {data.claims.map((claim) => <ClaimTrack claim={claim} start={data.start} end={data.end} key={claim.claimId} />)}
      </ol>
      {!data.claims.length ? <p className="high-level-empty">{data.procedureQuery ? `No claims match CPT / HCPCS “${data.procedureQuery}” in this range.` : "No claim activity in this range."}</p> : null}
    </section>
  );
}

function queueColor(days, mode) {
  const maximum = mode === "unsubmitted" ? 14 : 30;
  const minimum = mode === "unsubmitted" ? 7 : 0;
  const ratio = Math.max(0, Math.min(1, (days - minimum) / Math.max(1, maximum - minimum)));
  const hue = Math.round(142 * (1 - ratio));
  return {
    "--age-color": `hsl(${hue} 58% 40%)`,
    "--age-soft": `hsl(${hue} 72% 95%)`,
    "--age-fill": `${Math.max(8, ratio * 100)}%`,
  };
}

function itemProcedures(item) {
  if (Array.isArray(item.procedures)) return item.procedures;
  return String(item.procedures || "").split(",").map((value) => value.trim()).filter(Boolean);
}

function QueueCard({ item, mode, onOpen }) {
  const isAppointment = mode === "unsubmitted";
  const procedures = itemProcedures(item);
  const anchorDate = isAppointment ? item.serviceDate : item.submittedDate;
  return (
    <li
      className="queue-record queue-record-clickable"
      style={queueColor(item.elapsedDays, mode)}
      role="button"
      tabIndex="0"
      title={`View details for ${isAppointment ? "encounter" : "claim"} ${item.claimId}`}
      aria-label={`View details for ${isAppointment ? "encounter" : "claim"} ${item.claimId}`}
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (!["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        onOpen(item);
      }}
    >
      <span className="queue-record-accent" aria-hidden="true" />
      <header>
        <div>
          <strong>{item.patientName || "Patient not provided"}</strong>
          <span>{isAppointment ? "Encounter" : "Claim"} {item.claimId}</span>
        </div>
        <span className="queue-age"><strong>{item.elapsedDays}</strong><small>days</small></span>
      </header>
      <dl>
        <div><dt>{isAppointment ? "Appointment" : "Submitted"}</dt><dd>{formatShortDate(anchorDate)}</dd></div>
        {!isAppointment ? <div><dt>Service</dt><dd>{formatShortDate(item.serviceDate)}</dd></div> : null}
        <div><dt>Provider</dt><dd title={item.provider || "Not provided"}>{item.provider || "Not provided"}</dd></div>
        <div><dt>Location</dt><dd title={item.location || "Not provided"}>{item.location || "Not provided"}</dd></div>
        <div className="queue-payer"><dt>Payer</dt><dd title={item.payer || "Not provided"}>{item.payer || "Not provided"}</dd></div>
      </dl>
      <footer>
        <div className="queue-cpts" aria-label={procedures.length ? `CPT codes ${procedures.join(", ")}` : "No CPT codes"}>
          {procedures.slice(0, 4).map((procedure) => <span key={procedure}>{procedure}</span>)}
          {procedures.length > 4 ? <span>+{procedures.length - 4}</span> : null}
          {!procedures.length ? <span>No CPT</span> : null}
        </div>
        <span>{item.mrn ? `MRN ${item.mrn}` : "MRN unavailable"}{item.dateOfBirth ? ` · DOB ${formatShortDate(item.dateOfBirth)}` : ""}</span>
      </footer>
    </li>
  );
}

function AgingQueue({ data, mode, options, onOptionsChange, onItemOpen }) {
  const [visibleCount, setVisibleCount] = useState(100);
  const { order, query, scope, ageFilter = "all", customAgeDays = 14 } = options;
  const isAppointment = mode === "unsubmitted";
  const minimumAgeDays = isAppointment ? appointmentMinimumAge(ageFilter, customAgeDays) : 0;
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.items.filter((item) => {
      if (isAppointment && item.elapsedDays < minimumAgeDays) return false;
      if (scope === "overdue" && item.elapsedDays < 30) return false;
      if (!needle) return true;
      return [
        item.claimId,
        item.patientName,
        item.payer,
        item.provider,
        item.location,
        item.mrn,
        ...itemProcedures(item),
      ].some((value) => String(value || "").toLowerCase().includes(needle));
    }).sort((left, right) => {
      const difference = order === "youngest"
        ? left.elapsedDays - right.elapsedDays
        : right.elapsedDays - left.elapsedDays;
      return difference || left.claimId.localeCompare(right.claimId);
    });
  }, [data.items, isAppointment, minimumAgeDays, order, query, scope]);
  const visibleItems = filteredItems.slice(0, visibleCount);

  useEffect(() => setVisibleCount(100), [ageFilter, customAgeDays, data, mode, order, query, scope]);

  return (
    <section className="aging-queue">
      <header className="aging-queue-header">
        <span><strong>{filteredItems.length}</strong> matching · {data.items.length} open</span>
        <div className="aging-scale">
          <span>{mode === "unsubmitted" ? "≤7d" : "0d"}</span><i /><span>{mode === "unsubmitted" ? "≥14d" : "30+d"}</span>
        </div>
      </header>
      <div className="queue-tools">
        <label className="queue-search">
          <span>Search</span>
          <input
            type="search"
            value={query}
            placeholder={isAppointment ? "Patient, encounter, CPT, provider…" : "Patient, claim, CPT, payer…"}
            onChange={(event) => onOptionsChange({ ...options, query: event.target.value })}
          />
        </label>
        <label>
          <span>Order</span>
          <select value={order} onChange={(event) => onOptionsChange({ ...options, order: event.target.value })}>
            <option value="oldest">Oldest first</option>
            <option value="youngest">Youngest first</option>
          </select>
        </label>
        {isAppointment ? (
          <div className="queue-scope queue-age-filter" role="group" aria-label="Minimum appointment age">
            <button type="button" className={ageFilter === "all" ? "queue-scope-active" : ""} aria-pressed={ageFilter === "all"} onClick={() => onOptionsChange({ ...options, ageFilter: "all" })}>All</button>
            <button type="button" className={ageFilter === "14" ? "queue-scope-active" : ""} aria-pressed={ageFilter === "14"} onClick={() => onOptionsChange({ ...options, ageFilter: "14" })}>14+ days</button>
            <button type="button" className={ageFilter === "custom" ? "queue-scope-active" : ""} aria-pressed={ageFilter === "custom"} onClick={() => onOptionsChange({ ...options, ageFilter: "custom" })}>Custom</button>
            {ageFilter === "custom" ? (
              <label className="queue-custom-age">
                <input
                  type="number"
                  min="1"
                  max="3650"
                  inputMode="numeric"
                  aria-label="Minimum appointment age in days"
                  value={customAgeDays}
                  onChange={(event) => onOptionsChange({ ...options, customAgeDays: event.target.value })}
                />
                <span>days+</span>
              </label>
            ) : null}
          </div>
        ) : (
          <div className="queue-scope" role="group" aria-label="Response age">
            <button type="button" className={scope === "all" ? "queue-scope-active" : ""} onClick={() => onOptionsChange({ ...options, scope: "all" })}>All</button>
            <button type="button" className={scope === "overdue" ? "queue-scope-active" : ""} onClick={() => onOptionsChange({ ...options, scope: "overdue" })}>30+ days</button>
          </div>
        )}
      </div>
      <ol className="aging-list">
        {visibleItems.map((item) => <QueueCard item={item} mode={mode} onOpen={onItemOpen} key={item.claimId} />)}
        {visibleCount < filteredItems.length ? (
          <li className="aging-load-more-row">
            <button type="button" onClick={() => setVisibleCount((count) => Math.min(filteredItems.length, count + 100))}>
              Show 100 more
            </button>
          </li>
        ) : null}
      </ol>
      {!filteredItems.length ? (
        <div className="high-level-empty">
          <strong>{query || scope !== "all" || minimumAgeDays > 0 ? "No results for these filters" : "No matching records"}</strong>
          <span>{query || scope !== "all" || minimumAgeDays > 0 ? "Change the search, order, or age filter." : mode === "unsubmitted" ? "Every service encounter in this source has a submitted claim." : "Every submitted claim in this source has a payer response."}</span>
        </div>
      ) : null}
      {data.truncated ? (
        <p className="aging-truncated">
          {mode === "no-response" && data.scanned
            ? `Showing matches found in the first ${data.scanned.toLocaleString()} submitted claims`
            : "Showing the first 2,000 records"}
        </p>
      ) : null}
    </section>
  );
}

export function HighLevelPage() {
  const initial = useMemo(initialDates, []);
  const [mode, setMode] = useState("icu");
  const [draftDates, setDraftDates] = useState(initial);
  const [range, setRange] = useState(initial);
  const [limit, setLimit] = useState(25);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("youngest");
  const [icuSort, setIcuSort] = useState("deadline");
  const [includePastDeadline, setIncludePastDeadline] = useState(false);
  const [draftIcuProcedureQuery, setDraftIcuProcedureQuery] = useState("");
  const [icuProcedureQuery, setIcuProcedureQuery] = useState("");
  const [draftProcedureQuery, setDraftProcedureQuery] = useState("");
  const [procedureQuery, setProcedureQuery] = useState("");
  const [rangeMode, setRangeMode] = useState("30");
  const [customDays, setCustomDays] = useState(14);
  const [dashboardBillingMode, setDashboardBillingMode] = useState("all");
  const [dashboardPayers, setDashboardPayers] = useState([]);
  const [dashboardSeriesVisibility, setDashboardSeriesVisibility] = useState({ billed: true, posted: true, paid: true, recouped: true });
  const [queueOptions, setQueueOptions] = useState({
    unsubmitted: { order: "oldest", query: "", scope: "all", ageFilter: "all", customAgeDays: 14 },
    "no-response": { order: "oldest", query: "", scope: "all" },
  });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [queueDetail, setQueueDetail] = useState(null);
  const requestRef = useRef(null);
  const isQueue = mode === "unsubmitted" || mode === "no-response";
  const activeQueueOrder = isQueue ? queueOptions[mode].order : "";
  const activeQueueScope = mode === "no-response" ? queueOptions[mode].scope : "";

  useEffect(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setData(null);
    const request = mode === "icu"
      ? fetchHighLevelClaimIcu({
        limit,
        page,
        sort: icuSort,
        includePastDeadline,
        procedureQuery: icuProcedureQuery,
      }, { signal: controller.signal })
      : mode === "dashboard"
        ? fetchHighLevelDashboard({ ...range, billingMode: dashboardBillingMode, payers: dashboardPayers, procedureQuery }, { signal: controller.signal })
        : mode === "claims"
          ? fetchHighLevelClaims({ ...range, limit, page, sort, procedureQuery }, { signal: controller.signal })
          : fetchHighLevelQueue(mode, { ...queueOptions[mode], ...range }, { signal: controller.signal });
    request.then((payload) => setData({ mode, payload })).catch((nextError) => {
      if (nextError.name !== "AbortError") setError(nextError.message);
    }).finally(() => {
      if (requestRef.current === controller) setLoading(false);
    });
    return () => controller.abort();
  }, [mode, range, limit, page, sort, icuSort, includePastDeadline, icuProcedureQuery, retryKey, activeQueueOrder, activeQueueScope, dashboardBillingMode, dashboardPayers, procedureQuery]);

  useEffect(() => setQueueDetail(null), [mode]);

  const currentData = data?.mode === mode ? data.payload : null;

  function applyRange(event) {
    event.preventDefault();
    const nextRange = resolveDateRange(rangeMode, draftDates, customDays, isoDate(new Date()));
    if (!nextRange) {
      setError(rangeMode === "custom-days" ? "Enter a number of days from 1 to 3,650." : "Choose a valid start and end date.");
      return;
    }
    if (nextRange.start !== range.start || nextRange.end !== range.end) setDashboardPayers([]);
    setPage(1);
    if (!isQueue) setProcedureQuery(draftProcedureQuery.trim().toUpperCase());
    setRange(nextRange);
  }

  return (
    <section className="high-level-page">
      <header className="high-level-toolbar">
        <div className="high-level-modes" role="tablist" aria-label="High level queues">
          {MODES.map(([value, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={mode === value ? "high-level-mode-active" : ""}
              key={value}
              onClick={() => {
                setMode(value);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "icu" ? (
          <form
            className="high-level-filters claim-icu-filters"
            aria-label="Claim ICU controls"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              setIcuProcedureQuery(draftIcuProcedureQuery.trim().toUpperCase());
            }}
          >
            <label className="claim-icu-cpt-search">
              <span>CPT / HCPCS</span>
              <input
                type="search"
                value={draftIcuProcedureQuery}
                onChange={(event) => setDraftIcuProcedureQuery(event.target.value.toUpperCase())}
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
              <select value={icuSort} onChange={(event) => { setPage(1); setIcuSort(event.target.value); }}>
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
              <input
                type="checkbox"
                checked={includePastDeadline}
                onChange={(event) => { setPage(1); setIncludePastDeadline(event.target.checked); }}
              />
              <span>Include past filing limits</span>
            </label>
            <button type="submit">Search</button>
          </form>
        ) : (
        <form className="high-level-filters" onSubmit={applyRange}>
          {!isQueue ? (
            <label className="high-level-procedure-search">
              <span>CPT / HCPCS</span>
              <input
                type="search"
                value={draftProcedureQuery}
                onChange={(event) => setDraftProcedureQuery(event.target.value.toUpperCase())}
                placeholder="Code or partial code"
                aria-label="Search CPT or HCPCS code"
                title="Enter a full or partial code, then select Apply. Clear the field and apply to show all codes."
                maxLength={20}
                pattern="[A-Za-z0-9.\-]{1,20}"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
              />
            </label>
          ) : null}
          <label className="high-level-range"><span>Range</span><select value={rangeMode} onChange={(event) => setRangeMode(event.target.value)}>{RANGE_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          {rangeMode === "custom-dates" ? (
            <>
              <label className="high-level-date-field"><span>From</span><input type="date" value={draftDates.start} onChange={(event) => setDraftDates((current) => ({ ...current, start: event.target.value }))} /></label>
              <label className="high-level-date-field"><span>To</span><input type="date" value={draftDates.end} onChange={(event) => setDraftDates((current) => ({ ...current, end: event.target.value }))} /></label>
            </>
          ) : null}
          {rangeMode === "custom-days" ? <label className="high-level-days"><span>Days</span><input type="number" min="1" max="3650" inputMode="numeric" value={customDays} onChange={(event) => setCustomDays(event.target.value)} /></label> : null}
          {mode === "claims" ? <label className="high-level-row-count"><span>Rows</span><select value={limit} onChange={(event) => { setPage(1); setLimit(Number(event.target.value)); }}><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label> : null}
          {mode === "claims" ? <label className="high-level-sort"><span>Sort</span><select value={sort} onChange={(event) => { setPage(1); setSort(event.target.value); }}>{SORT_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label> : null}
          <button type="submit">Apply</button>
        </form>
        )}
      </header>

      <div className="high-level-content" aria-live="polite" aria-busy={loading}>
        {loading ? <div className="high-level-state"><span className="high-level-spinner" />{mode === "icu" ? "Prioritizing claims for review" : mode === "dashboard" ? "Aggregating financial activity" : mode === "unsubmitted" ? "Finding appointments without claims" : mode === "no-response" ? "Checking claims awaiting responses" : "Loading claims"}</div> : null}
        {!loading && error ? (
          <div className="high-level-state high-level-state-error">
            <strong>Unable to load this view</strong>
            <span>{error}</span>
            <button type="button" onClick={() => setRetryKey((value) => value + 1)}>Retry</button>
          </div>
        ) : null}
        {!loading && !error && currentData && mode === "dashboard" ? (
          <HighLevelDashboard
            data={currentData}
            billingMode={dashboardBillingMode}
            onBillingModeChange={(nextMode) => {
              setDashboardPayers([]);
              setDashboardBillingMode(nextMode);
            }}
            selectedPayers={dashboardPayers}
            onPayersChange={setDashboardPayers}
            visibleSeries={dashboardSeriesVisibility}
            onToggleSeries={(series) => setDashboardSeriesVisibility((current) => ({
              ...current,
              [series]: !current[series],
            }))}
          />
        ) : null}
        {!loading && !error && currentData && mode === "claims" ? <ClaimOverview data={currentData} onPageChange={setPage} /> : null}
        {!loading && !error && currentData && mode === "icu" ? <ClaimIcu data={currentData} onPageChange={setPage} /> : null}
        {!loading && !error && currentData && isQueue ? (
          <AgingQueue
            data={currentData}
            mode={mode}
            options={queueOptions[mode]}
            onOptionsChange={(nextOptions) => setQueueOptions((current) => ({ ...current, [mode]: nextOptions }))}
            onItemOpen={(item) => setQueueDetail({ item, mode })}
            key={mode}
          />
        ) : null}
      </div>
      {queueDetail ? (
        <QueueDetailDialog
          item={queueDetail.item}
          mode={queueDetail.mode}
          onClose={() => setQueueDetail(null)}
        />
      ) : null}
    </section>
  );
}
