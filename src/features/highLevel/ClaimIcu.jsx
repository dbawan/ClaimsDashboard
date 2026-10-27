import { Fragment, useEffect, useState } from "react";
import { claimWorkspaceUrl } from "../claims/claimNavigation.js";

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function money(value) {
  return value == null ? "Unavailable" : moneyFormatter.format(value);
}

function date(value) {
  const parsed = value ? Date.parse(`${value}T00:00:00Z`) : NaN;
  return Number.isFinite(parsed) ? dateFormatter.format(new Date(parsed)) : "Not available";
}

function pluralDays(value, suffix) {
  const count = Math.abs(Number(value) || 0);
  return `${count.toLocaleString()} day${count === 1 ? "" : "s"} ${suffix}`;
}

function Deadline({ claim }) {
  if (!claim.deadlineDate) return <span className="icu-muted">Not available</span>;
  return <strong className="icu-deadline">{date(claim.deadlineDate)}</strong>;
}

function FilingTimelyDaysLeft({ value }) {
  const days = Number(value);
  if (value == null || !Number.isFinite(days)) return <span className="icu-muted">Not available</span>;

  const timingClass = days < 0
    ? " icu-filing-days-overdue"
    : days <= 14
      ? " icu-filing-days-urgent"
      : "";
  const label = days === 0
    ? "Due today"
    : days < 0
      ? pluralDays(days, "overdue")
      : pluralDays(days, "left");

  return <strong className={`icu-filing-days${timingClass}`}>{label}</strong>;
}

function CptBreakdown({ claim, id }) {
  const cpts = claim.cptDetails || [];
  return (
    <section className="claim-icu-cpt-breakdown" id={id} aria-label={`All CPT codes for claim ${claim.claimId}`}>
      <header>
        <div>
          <span>Full claim breakdown</span>
          <strong>All CPT / HCPCS codes on claim {claim.claimId}</strong>
        </div>
        <b>{cpts.length.toLocaleString()} code{cpts.length === 1 ? "" : "s"}</b>
      </header>
      {cpts.length ? (
        <div className="claim-icu-cpt-scroll">
          <table>
            <thead>
              <tr>
                <th>CPT / HCPCS</th>
                <th>Units</th>
                <th>Billed</th>
                <th>Posted</th>
                <th>Outstanding AR</th>
                <th>Rate / unit</th>
                <th>Expected</th>
                <th>Recovery</th>
              </tr>
            </thead>
            <tbody>
              {cpts.map((cpt) => (
                <tr key={cpt.procedure}>
                  <th scope="row">{cpt.procedure}</th>
                  <td>{Number(cpt.units || 0).toLocaleString()}</td>
                  <td>{money(cpt.chargedAmount)}</td>
                  <td>{money(cpt.postedAmount)}</td>
                  <td>{money(cpt.outstandingArAmount)}</td>
                  <td>{money(cpt.ratePerUnit)}</td>
                  <td>{money(cpt.expectedReimbursement)}</td>
                  <td>{money(cpt.recoveryAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p>No CPT-level financial data is available for this claim.</p>}
    </section>
  );
}

export function ClaimIcu({ data, onPageChange, onClaimSelect }) {
  const claims = data.claims || [];
  const normalizedProcedureQuery = String(data.procedureQuery || "").replace(/[^A-Z0-9]/g, "");
  const [expandedClaimId, setExpandedClaimId] = useState(null);

  useEffect(() => setExpandedClaimId(null), [data.page, data.procedureQuery]);

  function toggleClaim(claimId) {
    setExpandedClaimId((current) => current === claimId ? null : claimId);
  }

  return (
    <section className="claim-icu" aria-label="Claim ICU prioritized claims">
      <header className="claim-icu-summary">
        <div>
          <span className="claim-icu-kicker">Priority queue</span>
          <strong>{data.total.toLocaleString()} open claim{data.total === 1 ? "" : "s"}</strong>
          <span>
            {data.includePastDeadline ? "Expired filing deadlines included" : "Expired filing deadlines excluded"}
            {data.procedureQuery ? ` · Showing ${data.procedureQuery} only` : ""}
          </span>
        </div>
        <nav className="claim-pagination" aria-label="Claim ICU pages">
          <button type="button" disabled={data.page <= 1} onClick={() => onPageChange(data.page - 1)} aria-label="Previous page">‹</button>
          <span>Page {data.page.toLocaleString()} of {data.totalPages.toLocaleString()}</span>
          <button type="button" disabled={data.page >= data.totalPages} onClick={() => onPageChange(data.page + 1)} aria-label="Next page">›</button>
        </nav>
      </header>

      {claims.length ? (
        <div className="claim-icu-table-wrap">
          <table className="claim-icu-table">
            <thead>
              <tr>
                <th>Claim</th>
                <th>Patient</th>
                <th>Payer</th>
                <th>DOS</th>
                <th>Age</th>
                <th>CPT / HCPCS</th>
                <th>Outstanding AR</th>
                <th>Primary DX</th>
                <th>Deadline</th>
                <th className="claim-icu-filing-heading" title="Filing timely limit days left">
                  <span>Filing limit</span>
                  <span>days left</span>
                </th>
                <th>Recovery</th>
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim, index) => {
                const focusedCpt = data.procedureQuery
                  ? claim.cptDetails?.find(({ procedure }) => procedure === normalizedProcedureQuery) || null
                  : null;
                const financials = focusedCpt || claim;
                const expanded = expandedClaimId === claim.claimId;
                const breakdownId = `claim-icu-cpts-${data.page}-${index}`;
                const rowClassName = [
                  "claim-icu-main-row",
                  index % 2 ? "claim-icu-row-alt" : "",
                  claim.daysToDeadline < 0 ? "claim-icu-row-expired" : "",
                  expanded ? "claim-icu-row-expanded" : "",
                ].filter(Boolean).join(" ");
                return (
                  <Fragment key={claim.claimId}>
                <tr
                  className={rowClassName}
                  onClick={(event) => {
                    if (event.target.closest("a, button")) return;
                    toggleClaim(claim.claimId);
                  }}
                  title={`${expanded ? "Hide" : "Show"} all CPT codes for claim ${claim.claimId}`}
                >
                  <td>
                    <div className="claim-icu-claim-cell">
                      <a
                        href={claimWorkspaceUrl(claim.claimId)}
                        {...(onClaimSelect ? {} : { target: "_blank", rel: "noopener noreferrer" })}
                        title={onClaimSelect ? `Open claim ${claim.claimId}` : `Open claim ${claim.claimId} in a new tab`}
                        onClick={onClaimSelect ? (event) => {
                          event.preventDefault();
                          onClaimSelect(claim.claimId);
                        } : undefined}
                      >
                        {claim.claimId}
                      </a>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={breakdownId}
                        onClick={() => toggleClaim(claim.claimId)}
                      >
                        {expanded ? "Hide CPTs" : "All CPTs"}<span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
                      </button>
                    </div>
                  </td>
                  <td><strong>{claim.patientName || "Not provided"}</strong></td>
                  <td><span className="claim-icu-payer" title={claim.payer || "Payer not provided"}>{claim.payer || "Not provided"}</span></td>
                  <td><strong>{date(claim.serviceDate)}</strong></td>
                  <td><strong>{claim.ageDays == null ? "—" : `${claim.ageDays.toLocaleString()}d`}</strong></td>
                  <td>
                    {focusedCpt ? (
                      <>
                        <strong className="claim-icu-cpt-code">{focusedCpt.procedure}</strong>
                        <span>{focusedCpt.units.toLocaleString()} unit{focusedCpt.units === 1 ? "" : "s"}</span>
                      </>
                    ) : (
                      <>
                        <strong className="claim-icu-cpt-count">{(claim.cptDetails?.length || 0).toLocaleString()}</strong>
                        <span>codes on claim</span>
                      </>
                    )}
                  </td>
                  <td>
                    <strong className="claim-icu-money">{money(financials.outstandingArAmount)}</strong>
                    <span>Billed {money(financials.chargedAmount)}</span>
                  </td>
                  <td>{claim.primaryDiagnosis ? <span className="claim-icu-diagnosis">{claim.primaryDiagnosis}</span> : <span className="icu-muted">Not provided</span>}</td>
                  <td><Deadline claim={claim} /></td>
                  <td><FilingTimelyDaysLeft value={claim.daysToDeadline} /></td>
                  <td>
                    <strong className="claim-icu-recovery">{money(financials.recoveryAmount)}</strong>
                    <span>{financials.expectedReimbursement == null ? "No matrix match" : `Expected ${money(financials.expectedReimbursement)}${focusedCpt || claim.expectedReimbursementComplete ? "" : " · partial"}`}</span>
                  </td>
                  <td>
                    <strong>{claim.owner?.name || (claim.ownerAssigned ? "Assigned" : data.ownerStatus === "unavailable" ? "Unavailable" : "Unassigned")}</strong>
                    {claim.owner?.worklistType ? (
                      <span>{claim.owner.worklistCount > 1
                        ? `${claim.owner.worklistCount.toLocaleString()} worklists`
                        : claim.owner.worklistType}</span>
                    ) : null}
                  </td>
                </tr>
                    {expanded ? (
                      <tr className="claim-icu-cpt-detail-row">
                        <td colSpan="12"><CptBreakdown claim={claim} id={breakdownId} /></td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="high-level-empty claim-icu-empty">
          <strong>No claims match this queue</strong>
          <span>{data.procedureQuery
            ? `No open claims contain CPT / HCPCS ${data.procedureQuery} with these filing-limit settings.`
            : data.includePastDeadline
              ? "There are no claims with outstanding AR."
              : "Try including claims that are past their filing deadline."}</span>
        </div>
      )}
    </section>
  );
}
