import { formatDate, formatMoney } from "./ClaimSummary.jsx";

function displayValue(value) {
  if (!value) return "Not provided";
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function confidence(value) {
  if (value == null || !Number.isFinite(Number(value))) return "Not provided";
  const number = Number(value);
  return `${Math.round((number <= 1 ? number * 100 : number) * 10) / 10}%`;
}

function Detail({ label, value }) {
  return (
    <div className="claim-detail">
      <dt>{label}</dt>
      <dd>{value || value === 0 ? value : "Not provided"}</dd>
    </div>
  );
}

function CodeList({ label, codes }) {
  return (
    <div>
      <span>{label}</span>
      <div className="categorization-code-list">
        {codes?.length ? codes.map((code) => <strong key={code}>{code}</strong>) : <em>None provided</em>}
      </div>
    </div>
  );
}

function IntegrationState({ integration }) {
  return (
    <section className={`categorization-empty categorization-empty-${integration?.status || "error"}`}>
      <span aria-hidden="true">i</span>
      <div>
        <p className="section-kicker">RCM Claims API</p>
        <h3>Categorized claim data</h3>
        <p>{integration?.message || "Categorized claim data is unavailable."}</p>
      </div>
    </section>
  );
}

export function ClaimCategorizationPanel({ data }) {
  const claim = data.categorization;
  if (!claim) return <IntegrationState integration={data.categorizationIntegration} />;

  const category = claim.category?.display || claim.clusterDisplay || claim.category?.label;
  const reason = claim.reasonDisplay || claim.normalizedReason;

  return (
    <div className="claim-categorization-panel">
      <section className="drawer-summary-band categorization-summary-band">
        <div>
          <span>Category</span>
          <strong>{displayValue(category)}</strong>
        </div>
        <div>
          <span>Reason</span>
          <strong>{displayValue(reason)}</strong>
        </div>
        <div>
          <span>Confidence</span>
          <strong>{confidence(claim.confidence)}</strong>
        </div>
      </section>

      <section className="detail-section">
        <div className="detail-section-heading">
          <div>
            <p className="section-kicker">API classification</p>
            <h3>Category and processing state</h3>
          </div>
          <span>{claim.workflow || "Workflow not provided"}</span>
        </div>
        <dl className="claim-detail-grid categorization-detail-grid">
          <Detail label="Category key" value={claim.category?.label} />
          <Detail label="Cluster" value={displayValue(claim.clusterDisplay || claim.clusterLabel)} />
          <Detail label="Primary issue" value={displayValue(claim.primaryIssueType)} />
          <Detail label="Pipeline status" value={displayValue(claim.pipelineStatus)} />
          <Detail label="Salesforce status" value={displayValue(claim.salesforceStatus)} />
          <Detail label="LLM status" value={displayValue(claim.llmStatus)} />
          <Detail label="RCM case" value={claim.rcmCaseId} />
          <Detail label="Date of service" value={formatDate(claim.dateOfService)} />
          <Detail label="Payer" value={claim.payer} />
        </dl>
        <div className="categorization-flags" aria-label="Review flags">
          <span className={claim.requiresHumanReview ? "flag-warning" : "flag-clear"}>
            {claim.requiresHumanReview ? "Human review required" : "No human review required"}
          </span>
          <span className={claim.conflictingSignals ? "flag-warning" : "flag-clear"}>
            {claim.conflictingSignals ? "Conflicting signals" : "No conflicting signals"}
          </span>
        </div>
      </section>

      {claim.summary || claim.evidence ? (
        <section className="detail-section categorization-narrative">
          <div className="detail-section-heading">
            <div>
              <p className="section-kicker">Classification rationale</p>
              <h3>Summary and evidence</h3>
            </div>
          </div>
          {claim.summary ? <div><span>Summary</span><p>{claim.summary}</p></div> : null}
          {claim.evidence ? <div><span>Evidence</span><p>{claim.evidence}</p></div> : null}
        </section>
      ) : null}

      <section className="categorization-codes-and-money">
        <div className="detail-section categorization-codes">
          <div className="detail-section-heading">
            <div>
              <p className="section-kicker">Payer response</p>
              <h3>Adjustment codes</h3>
            </div>
          </div>
          <CodeList label="CARC" codes={claim.carcCodes} />
          <CodeList label="RARC" codes={claim.rarcCodes} />
        </div>
        <div className="detail-section categorization-financials">
          <div className="detail-section-heading">
            <div>
              <p className="section-kicker">API totals</p>
              <h3>Claim financials</h3>
            </div>
          </div>
          <div><span>Total charges</span><strong>{formatMoney(claim.totalChargeAmount)}</strong></div>
          <div><span>Insurance owed</span><strong>{formatMoney(claim.totalInsuranceOwed)}</strong></div>
        </div>
      </section>

      {claim.lineItems?.length ? (
        <section className="detail-section">
          <div className="detail-section-heading">
            <div>
              <p className="section-kicker">Service-level classification</p>
              <h3>Line items</h3>
            </div>
            <span>{claim.lineItems.length} line{claim.lineItems.length === 1 ? "" : "s"}</span>
          </div>
          <div className="categorization-line-items">
            {claim.lineItems.map((item, index) => (
              <article key={item.lineItemId || `${item.cptCode}-${index}`}>
                <header><strong>{item.cptCode || "CPT not provided"}</strong><span>{formatMoney(item.owedAmount)} owed</span></header>
                <dl>
                  <Detail label="Modifier" value={item.modifier} />
                  <Detail label="Units" value={item.units} />
                  <Detail label="Charge" value={formatMoney(item.chargeAmount)} />
                  <Detail label="Paid" value={formatMoney(item.paidAmount)} />
                </dl>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {claim.notes?.length ? (
        <section className="detail-section">
          <div className="detail-section-heading">
            <div>
              <p className="section-kicker">Categorized source notes</p>
              <h3>Notes</h3>
            </div>
            <span>{claim.notes.length} note{claim.notes.length === 1 ? "" : "s"}</span>
          </div>
          <div className="categorization-notes">
            {claim.notes.map((note, index) => (
              <article key={note.sourceId || `${note.createdDate}-${index}`}>
                <header>
                  <div><strong>{note.title || `Note ${index + 1}`}</strong><small>{formatDate(note.createdDate)}</small></div>
                  {note.category ? <span>{note.category}</span> : null}
                </header>
                {note.body ? <p>{note.body}</p> : null}
                <dl>
                  <Detail label="Action" value={note.action} />
                  <Detail label="Follow-up" value={note.followUpAction} />
                  <Detail label="Denial reason" value={note.denialReason} />
                  <Detail label="Resolution" value={note.resolution} />
                </dl>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
