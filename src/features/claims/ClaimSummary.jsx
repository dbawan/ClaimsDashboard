import { StatusBadge } from "../../components/StatusBadge.jsx";
import { buildAppealRebillItems } from "./claimActivityModel.js";
import { buildClaimStory } from "./claimStoryModel.js";

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

function SummaryMetric({ label, value, tone }) {
  return (
    <div className={`summary-cell ${tone ? `summary-${tone}` : ""}`}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

export function ClaimSummary({ data, cptPaymentSnapshot, onOpenPanel }) {
  const { claim, summary, provenance } = data;
  const paidTone = summary.totalPaid < 0 ? "danger" : summary.totalPaid > 0 ? "success" : "neutral";
  const storyStepCount = buildClaimStory(data).length;
  const cptPayments = cptPaymentSnapshot?.items || [];
  const appealRebillItems = buildAppealRebillItems(data);

  function openPanel(panel, event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    onOpenPanel(panel, {
      left: Math.round(bounds.right + 12),
      bottom: Math.round(Math.max(12, window.innerHeight - bounds.bottom)),
    });
  }

  return (
    <aside className="claim-overview" aria-labelledby="claim-result-heading">
      <div className="result-heading-row">
        <div>
          <p className="section-kicker">Claim located</p>
          <h2 id="claim-result-heading">{claim.claimId}</h2>
        </div>
        <StatusBadge tone={paidTone}>{claim.status}</StatusBadge>
      </div>

      <div className="summary-grid" aria-label="Claim financial summary">
        <SummaryMetric label="Charges" value={formatMoney(summary.charges)} />
        <SummaryMetric label="Paid" value={formatMoney(summary.totalPaid)} tone="paid" />
        <SummaryMetric label="Balance" value={formatMoney(summary.balance)} tone="pending" />
        <SummaryMetric label="Story steps" value={String(storyStepCount)} />
      </div>

      <dl className="snapshot-list" aria-label="Claim snapshot">
        <Detail label="Patient" value={claim.patientName} />
        <Detail label="Payer" value={claim.payer} />
        <Detail label="Service date" value={formatDate(claim.serviceDate)} />
        <Detail label="Procedure" value={claim.procedure} />
      </dl>

      <section className="claim-cpt-summary" aria-labelledby="claim-cpt-payment-heading">
        <header>
          <span id="claim-cpt-payment-heading">CPT payments</span>
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
      </section>

      <section className="claim-appeal-summary" aria-labelledby="claim-appeal-rebill-heading">
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
      </section>

      <div className="source-rule">
        <span aria-hidden="true">i</span>
        <p>{provenance.sources.length} sources reconciled. Payments follow the authoritative ERA rule.</p>
      </div>

      <nav className="claim-action-stack" aria-label="Claim record sections">
        <button type="button" onClick={(event) => openPanel("categorization", event)}>
          <span><i aria-hidden="true">01</i>Claim category</span>
          {data.categorization?.category?.display ? (
            <em className="claim-category-value">{data.categorization.category.display}</em>
          ) : <b aria-hidden="true">›</b>}
        </button>
        <button type="button" onClick={(event) => openPanel("details", event)}>
          <span><i aria-hidden="true">02</i>Claim details</span>
          <b aria-hidden="true">›</b>
        </button>
        <button type="button" onClick={(event) => openPanel("eras", event)}>
          <span><i aria-hidden="true">03</i>ERA records</span>
          <em>{data.eras?.length || 0}</em>
        </button>
        <button type="button" onClick={(event) => openPanel("timeline", event)}>
          <span><i aria-hidden="true">04</i>All records</span>
          <em>{data.timeline?.length || 0}</em>
        </button>
      </nav>
    </aside>
  );
}

export function ClaimDetailPanel({ data }) {
  const { claim, provenance } = data;
  const submissionReferences = claim.submissionReferences || [];
  const priorAuthorizations = data.priorAuthorizations || [];

  return (
    <div className="claim-detail-panel">
      <section className="drawer-summary-band">
        <div>
          <span>Claim</span>
          <strong>{claim.claimId}</strong>
        </div>
        <div>
          <span>Patient</span>
          <strong>{claim.patientName || "Not provided"}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{claim.status || "Not provided"}</strong>
        </div>
      </section>

      <section className="detail-section">
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
      </section>

      <section className="detail-section">
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
      </section>

      <section className="detail-section">
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
      </section>

      <section className="detail-section payment-rule-panel">
        <span className="provenance-icon" aria-hidden="true">i</span>
        <div>
          <p className="section-kicker">Payment source rule</p>
          <h3>How totals were reconciled</h3>
          <p>{provenance.paymentRule}</p>
          <p>{provenance.matchRule}</p>
        </div>
      </section>

      <section className="reconciliation-metrics" aria-label="Reconciliation totals">
        <div><span>Duplicates removed</span><strong>{provenance.duplicatesRemoved}</strong></div>
        <div><span>ERA-matched postings</span><strong>{provenance.eraMatchedPostings}</strong></div>
        <div><span>Data notes</span><strong>{data.warnings?.length || 0}</strong></div>
      </section>

      {data.warnings?.length ? (
        <section className="reconciliation-notes">
          <h3>Data quality / reconciliation notes</h3>
          <ul>{data.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

export { formatDate, formatMoney };
