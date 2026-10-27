import { StatusBadge } from "../../components/StatusBadge.jsx";
import { buildAppealRebillItems } from "./claimActivityModel.js";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const date = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatMoney(value) {
  return currency.format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "Not provided";
  const dateOnly = String(value).slice(0, 10);
  const [year, month, day] = dateOnly.split("-").map(Number);
  if (!year || !month || !day) return value;
  return date.format(new Date(Date.UTC(year, month - 1, day)));
}

function Detail({ label, value }) {
  return (
    <div className="claim-detail">
      <dt>{label}</dt>
      <dd>{value || "Not provided"}</dd>
    </div>
  );
}

function daysValue(value) {
  if (value == null) return "Unavailable";
  const days = Number(value);
  return `${days.toLocaleString("en-US")} day${days === 1 ? "" : "s"}`;
}

function deadlineStatus(daysLeft) {
  if (daysLeft == null) return { value: "Unavailable", tone: "neutral" };
  if (daysLeft < 0) {
    return {
      value: `${Math.abs(daysLeft).toLocaleString("en-US")}d overdue`,
      tone: "danger",
    };
  }
  if (daysLeft === 0) return { value: "Due today", tone: "danger" };
  return {
    value: `${daysLeft.toLocaleString("en-US")}d left`,
    tone: daysLeft <= 7 ? "warning" : "neutral",
  };
}

function optionalMoney(value) {
  return value == null ? "Unavailable" : formatMoney(value);
}

function formatUnits(value) {
  const units = Number(value);
  if (!Number.isFinite(units)) return "1 unit";
  return `${units.toLocaleString("en-US")} unit${units === 1 ? "" : "s"}`;
}

function ExpectedReimbursementRow({ metric, vitals }) {
  const breakdown = vitals.expectedReimbursementBreakdown || [];
  const matched = Number(vitals.expectedReimbursementMatchedCptCount) || 0;
  const total = Number(vitals.expectedReimbursementTotalCptCount) || breakdown.length;

  return (
    <div className="claim-vitals-summary-row claim-vitals-reimbursement-row">
      <details className="claim-vitals-reimbursement">
        <summary
          title={metric.detail}
          aria-label={`${metric.label}: ${metric.value}. ${metric.detail}. Click for CPT breakdown.`}
        >
          <span className="claim-vitals-reimbursement-label">
            {metric.label}
            <small>{total ? `${matched}/${total} CPTs matched` : "No CPT codes"}</small>
          </span>
          <strong>{metric.value}</strong>
          <i aria-hidden="true">⌄</i>
        </summary>
        <div className="claim-vitals-reimbursement-breakdown">
          <p>
            {vitals.expectedReimbursementPayer
              ? `Rate payer: ${vitals.expectedReimbursementPayer}`
              : "Payer/CPT reimbursement matrix"}
          </p>
          {breakdown.length ? (
            <ol>
              {breakdown.map((line) => (
                <li key={line.procedure}>
                  <span>
                    <b>{line.procedure}</b>
                    <small>
                      {line.ratePerUnit == null
                        ? "No payer rate found"
                        : `${formatUnits(line.units)} × ${formatMoney(line.ratePerUnit)}`}
                    </small>
                  </span>
                  <strong>{optionalMoney(line.expected)}</strong>
                </li>
              ))}
            </ol>
          ) : <p>No CPT codes are available for this claim.</p>}
        </div>
      </details>
    </div>
  );
}

function ClaimVitalsSummary({ data, statusTone }) {
  const vitals = data.claimVitals || {};
  const filing = deadlineStatus(vitals.filingLimitDaysLeft);
  const appeal = deadlineStatus(vitals.appealDaysLeft);
  const claimAge = vitals.claimAgeDays == null ? null : Number(vitals.claimAgeDays);
  const daysSinceTouch = vitals.daysSinceTouch == null ? null : Number(vitals.daysSinceTouch);
  const metrics = [
    {
      key: "claim-age",
      label: "Claim Age",
      value: daysValue(vitals.claimAgeDays),
      detail: data.claim?.serviceDate ? `Since DOS ${formatDate(data.claim.serviceDate)}` : "Date of service unavailable",
      tone: claimAge >= 90 ? "danger" : claimAge >= 30 ? "warning" : "neutral",
    },
    {
      key: "days-since-touch",
      label: "Days Since Touch",
      value: daysValue(vitals.daysSinceTouch),
      detail: vitals.lastTouchDate
        ? `Latest claim transaction or Salesforce comment ${formatDate(vitals.lastTouchDate)}`
        : "No claim transaction or Salesforce comment date available",
      tone: daysSinceTouch >= 30 ? "danger" : daysSinceTouch >= 7 ? "warning" : "neutral",
    },
    {
      key: "outstanding-ar",
      label: "Outstanding AR",
      value: optionalMoney(vitals.outstandingArAmount),
      detail: "Total charge − paid − write-offs",
      tone: Number(vitals.outstandingArAmount) > 0 ? "warning" : "neutral",
    },
    {
      key: "original-charge",
      label: "Original Charge",
      value: optionalMoney(vitals.originalCharge),
      detail: "Original claim-created service lines",
    },
    {
      key: "expected-reimbursement",
      label: "Expected Reimb.",
      value: optionalMoney(vitals.expectedReimbursement),
      detail: vitals.expectedReimbursementTotalCptCount
        ? `Payer/CPT matrix total · ${vitals.expectedReimbursementMatchedCptCount || 0} of ${vitals.expectedReimbursementTotalCptCount} CPT codes matched`
        : "No CPT codes available for a payer/CPT matrix lookup",
      expandable: true,
    },
    {
      key: "paid",
      label: "Paid",
      value: optionalMoney(vitals.paid),
      detail: "Reconciled authoritative payments",
      tone: vitals.paid == null ? "neutral" : "success",
    },
    {
      key: "attempts",
      label: "Attempts",
      value: vitals.attempts == null ? "Unavailable" : Number(vitals.attempts).toLocaleString("en-US"),
      detail: "Distinct submissions, corrections, and rebills",
    },
    {
      key: "filing-limit",
      label: "Filing Limit Left",
      value: filing.value,
      detail: vitals.filingLimitDate
        ? `90-day deadline ${formatDate(vitals.filingLimitDate)} · ${vitals.filingStartReason === "appeal_or_rebill" ? "appeal/rebill" : "DOS"} ${formatDate(vitals.filingStartDate)}`
        : "No service date or appeal/rebill date available",
      tone: filing.tone,
    },
    {
      key: "appeal-deadline",
      label: "Appeal Deadline",
      value: vitals.appealDeadline ? formatDate(vitals.appealDeadline) : "Unavailable",
      detail: vitals.appealDeadline
        ? `${appeal.value} · 90 days from ${vitals.filingStartReason === "appeal_or_rebill" ? "the latest appeal/rebill" : "the date of service"} ${formatDate(vitals.filingStartDate)}`
        : "No service date or recorded appeal/rebill available",
      tone: appeal.tone,
    },
  ];

  return (
    <section className="claim-vitals-summary" aria-labelledby="claim-result-heading">
      <header className="claim-vitals-summary-header">
        <div>
          <p className="section-kicker">Claim Vitals</p>
          <h2 id="claim-result-heading">{data.claim?.claimId}</h2>
          <small>As of {formatDate(vitals.asOfDate)}</small>
        </div>
        <StatusBadge tone={statusTone}>{data.claim?.status}</StatusBadge>
      </header>
      <dl className="claim-vitals-summary-list" aria-label="Claim vitals">
        {metrics.map((metric) => metric.expandable ? (
          <ExpectedReimbursementRow key={metric.key} metric={metric} vitals={vitals} />
        ) : (
          <div
            className={`claim-vitals-summary-row claim-vitals-summary-row-${metric.tone || "neutral"}`}
            key={metric.key}
            title={metric.detail}
            aria-label={`${metric.label}: ${metric.value}. ${metric.detail}`}
          >
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ClaimSummary({ data, cptPaymentSnapshot, onOpenPanel }) {
  const { claim, summary, provenance } = data;
  const access = data.access || { claimOverview: true, paymentsAndEra: true, supportingRecords: true };
  const paidTone = access.paymentsAndEra && summary.totalPaid < 0
    ? "danger"
    : access.paymentsAndEra && summary.totalPaid > 0
      ? "success"
      : "neutral";
  const cptPayments = cptPaymentSnapshot?.items || [];
  const appealRebillItems = access.claimOverview ? buildAppealRebillItems(data) : [];

  function openPanel(panel, event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    onOpenPanel(panel, {
      left: Math.round(bounds.right + 12),
      bottom: Math.round(Math.max(12, window.innerHeight - bounds.bottom)),
    });
  }

  return (
    <aside className="claim-overview" aria-labelledby="claim-result-heading">
      <ClaimVitalsSummary data={data} statusTone={paidTone} />

      {access.claimOverview ? (
        <dl className="snapshot-list" aria-label="Claim snapshot">
          <Detail label="Patient" value={claim.patientName} />
          <Detail label="Payer" value={claim.payer} />
          <Detail label="Service date" value={formatDate(claim.serviceDate)} />
          <Detail label="Procedure" value={claim.procedure} />
        </dl>
      ) : null}

      {access.paymentsAndEra ? <section className="claim-cpt-summary" aria-labelledby="claim-cpt-payment-heading">
        <header>
          <span id="claim-cpt-payment-heading">
            {cptPaymentSnapshot?.selectedProcedure
              ? `${cptPaymentSnapshot.selectedProcedure} ${cptPaymentSnapshot.paymentView === "received" ? "received" : "posted"} payment`
              : `CPT ${cptPaymentSnapshot?.paymentView === "received" ? "received" : "posted"} payments`}
          </span>
          <strong aria-live="polite">
            {cptPaymentSnapshot?.hovering
              ? `As of ${formatDate(cptPaymentSnapshot.date)}`
              : "Current"}
          </strong>
        </header>
        {cptPayments.length ? (
          <ol>
            {cptPayments.map((item) => (
              <li key={item.procedure}>
                <span>{item.procedure}</span>
                <strong className={item.paid < 0 ? "amount-negative" : "amount-positive"}>
                  {formatMoney(item.paid)}
                </strong>
              </li>
            ))}
          </ol>
        ) : <p>No CPT codes available</p>}
      </section> : null}

      {access.claimOverview ? <section className="claim-appeal-summary" aria-labelledby="claim-appeal-rebill-heading">
        <header>
          <span id="claim-appeal-rebill-heading">Appeals &amp; rebills</span>
          <strong>{appealRebillItems.length}</strong>
        </header>
        {appealRebillItems.length ? (
          <ol>
            {appealRebillItems.map((item) => (
              <li className={`claim-activity-${item.type}`} key={item.id}>
                <i aria-hidden="true" />
                <div>
                  <strong>{item.label}</strong>
                  <time dateTime={item.date || undefined}>{formatDate(item.date)}</time>
                </div>
              </li>
            ))}
          </ol>
        ) : <p>No appeals or rebills recorded</p>}
      </section> : null}

      {access.paymentsAndEra ? <div className="source-rule">
        <span aria-hidden="true">i</span>
        <p>{provenance.sources.length} sources reconciled. Received and posted payments are tracked separately.</p>
      </div> : null}

      <nav className="claim-action-stack" aria-label="Claim record sections">
        {access.supportingRecords ? <button type="button" onClick={(event) => openPanel("categorization", event)}>
          <span><i aria-hidden="true">01</i>Claim category</span>
          {data.categorization?.category?.display ? (
            <em className="claim-category-value">{data.categorization.category.display}</em>
          ) : <b aria-hidden="true">›</b>}
        </button> : null}
        {access.claimOverview || access.supportingRecords ? <button type="button" onClick={(event) => openPanel("details", event)}>
          <span><i aria-hidden="true">02</i>{access.claimOverview ? "Claim details" : "Prior authorization"}</span>
          <b aria-hidden="true">›</b>
        </button> : null}
        {access.paymentsAndEra ? <button type="button" onClick={(event) => openPanel("eras", event)}>
          <span><i aria-hidden="true">03</i>ERA records</span>
          <em>{data.eras?.length || 0}</em>
        </button> : null}
        {access.claimOverview ? <button type="button" onClick={(event) => openPanel("timeline", event)}>
          <span><i aria-hidden="true">04</i>All records</span>
          <em>{data.timeline?.length || 0}</em>
        </button> : null}
      </nav>
    </aside>
  );
}

export function ClaimDetailPanel({ data }) {
  const { claim, provenance } = data;
  const access = data.access || { claimOverview: true, paymentsAndEra: true, supportingRecords: true };
  const submissionReferences = claim.submissionReferences || [];
  const priorAuthorizations = data.priorAuthorizations || [];

  return (
    <div className="claim-detail-panel">
      <section className="drawer-summary-band">
        <div>
          <span>Claim</span>
          <strong>{claim.claimId}</strong>
        </div>
        {access.claimOverview ? <div>
          <span>Patient</span>
          <strong>{claim.patientName || "Not provided"}</strong>
        </div> : null}
        <div>
          <span>Status</span>
          <strong>{claim.status || "Not provided"}</strong>
        </div>
      </section>

      {access.supportingRecords ? <section className="detail-section">
        <div className="detail-section-heading">
          <div>
            <p className="section-kicker">Appointment-linked</p>
            <h3>Prior authorization</h3>
          </div>
          <span>{priorAuthorizations.length} record{priorAuthorizations.length === 1 ? "" : "s"}</span>
        </div>
        {priorAuthorizations.length ? (
          <div className="prior-authorization-list">
            {priorAuthorizations.map((authorization, index) => (
              <article key={`${authorization.id || "authorization"}-${index}`}>
                <div>
                  <strong>{authorization.number || authorization.description || "Authorization recorded"}</strong>
                  <span>{authorization.status || "Status not provided"}</span>
                </div>
                <dl>
                  <Detail label="Effective" value={formatDate(authorization.effectiveDate)} />
                  <Detail label="Expires" value={formatDate(authorization.expirationDate)} />
                  <Detail label="Appointment" value={authorization.appointment?.id} />
                  <Detail label="Facility" value={authorization.appointment?.facility} />
                </dl>
              </article>
            ))}
          </div>
        ) : <p className="drawer-empty-copy">No authorization row matched this claim visit ID.</p>}
      </section> : null}

      {access.claimOverview ? <section className="detail-section">
        <div className="detail-section-heading">
          <div>
            <p className="section-kicker">Reconciled identity</p>
            <h3>Claim details</h3>
          </div>
          <span>{provenance.sources.length} sources</span>
        </div>
        <dl className="claim-detail-grid">
          <Detail label="Patient" value={claim.patientName} />
          <Detail label="Date of birth" value={formatDate(claim.dateOfBirth)} />
          <Detail label="MRN" value={claim.medicalRecordNumber} />
          <Detail label="Provider" value={claim.provider} />
          <Detail label="Location" value={claim.location} />
          <Detail label="Payer" value={claim.payer} />
          <Detail label="Service date" value={formatDate(claim.serviceDate)} />
          <Detail label="Procedure" value={claim.procedure} />
          <Detail label="First established" value={formatDate(claim.createdAt)} />
        </dl>
      </section> : null}

      {access.claimOverview ? <section className="detail-section">
        <div className="detail-section-heading">
          <div>
            <p className="section-kicker">Iteration history</p>
            <h3>Submission / correction / rebill sequence</h3>
          </div>
        </div>
        {submissionReferences.length ? (
          <ol className="submission-detail-list">
            {submissionReferences.map((reference, index) => (
              <li key={reference}>
                <span>{index + 1}</span>
                <div><strong>{reference}</strong><small>Logical submission iteration</small></div>
              </li>
            ))}
          </ol>
        ) : <p className="drawer-empty-copy">No ERA reference was observed for this claim.</p>}
      </section> : null}

      {access.paymentsAndEra ? <section className="detail-section payment-rule-panel">
        <span className="provenance-icon" aria-hidden="true">i</span>
        <div>
          <p className="section-kicker">Payment source rule</p>
          <h3>How totals were reconciled</h3>
          <p>{provenance.paymentRule}</p>
          <p>{provenance.matchRule}</p>
        </div>
      </section> : null}

      {access.paymentsAndEra ? <section className="reconciliation-metrics" aria-label="Reconciliation totals">
        <div><span>Duplicates removed</span><strong>{provenance.duplicatesRemoved}</strong></div>
        <div><span>ERA-matched postings</span><strong>{provenance.eraMatchedPostings}</strong></div>
        <div><span>Data notes</span><strong>{data.warnings?.length || 0}</strong></div>
      </section> : null}

      {access.paymentsAndEra && data.warnings?.length ? (
        <section className="reconciliation-notes">
          <h3>Data quality / reconciliation notes</h3>
          <ul>{data.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

export { formatDate, formatMoney };
