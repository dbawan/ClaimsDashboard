import { StatusBadge } from "../../components/StatusBadge.jsx";
import { formatDate, formatMoney } from "./ClaimSummary.jsx";

function valueOrMissing(value) {
  return value || "Not provided";
}

function moneyOrMissing(value) {
  return value == null ? "Not provided" : formatMoney(value);
}

function EraFact({ label, children }) {
  return (
    <div className="era-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function procedureLabel(line) {
  if (!line.procedure) return "Not provided";
  return line.modifier ? `${line.procedure}-${line.modifier}` : line.procedure;
}

export function ClaimEraList({ data }) {
  const eras = data.eras || [];
  const claimStatusCount = eras.filter((era) => era.observedSources?.includes("ClaimStatus ERA")).length;
  const edi835Count = eras.filter((era) => era.observedSources?.includes("EDI 835 ERA")).length;

  return (
    <section className="era-list-card" aria-labelledby="era-list-heading">
      <div className="era-list-header">
        <div>
          <p className="section-kicker">Payment received</p>
          <h2 id="era-list-heading">ERA records</h2>
          <p>AdvancedMD, ClaimStatus and 835 remittances, counted once as received payments. Posting is tracked separately.</p>
        </div>
        <div className="era-source-counts" aria-label="ERA record source counts">
          <span>{eras.length} remittance{eras.length === 1 ? "" : "s"}</span>
          <small>{claimStatusCount} ClaimStatus · {edi835Count} EDI 835 · {eras.filter((era) => era.observedSources?.includes("AdvancedMD ERA")).length} AdvancedMD</small>
        </div>
      </div>

      {eras.length ? (
        <div className="era-record-list">
          {eras.map((era) => (
            <article className={`era-record era-record-${era.status}`} key={era.id}>
              <div className="era-record-heading">
                <div>
                  <div className="era-record-meta">
                    {(era.observedSources || [era.source]).map((source) => (
                      <StatusBadge tone={source === "ClaimStatus ERA" ? "warning" : "neutral"} key={source}>
                        {source}
                      </StatusBadge>
                    ))}
                    <time dateTime={era.date || undefined}>{formatDate(era.date)}</time>
                  </div>
                  <h3>{era.title}</h3>
                </div>
                <div className="era-paid-total">
                  <span>Payment received</span>
                  <strong className={era.paid < 0 ? "amount-negative" : "amount-positive"}>
                    {formatMoney(era.paid)}
                  </strong>
                </div>
              </div>

              {era.postFailed ? <p className="era-adjustments">AdvancedMD reported a posting failure for this remittance.</p> : null}
              <dl className="era-facts">
                {era.receivedAt ? <EraFact label="ERA received">{formatDate(era.receivedAt)}</EraFact> : null}
                <EraFact label="Submission / rebill">{valueOrMissing(era.submissionReference)}</EraFact>
                <EraFact label="Payer claim number">{valueOrMissing(era.payerClaimNumber)}</EraFact>
                <EraFact label="Trace / check number">{valueOrMissing(era.traceNumber)}</EraFact>
                <EraFact label="Payer">{era.payers?.length ? era.payers.join(", ") : "Not provided"}</EraFact>
                <EraFact label="Date(s) of service">
                  {era.serviceDates?.length ? era.serviceDates.map(formatDate).join(", ") : "Not provided"}
                </EraFact>
                <EraFact label="Service lines">{era.lineCount}</EraFact>
                <EraFact label="Total billed">{moneyOrMissing(era.billed)}</EraFact>
                <EraFact label="Total allowed">{moneyOrMissing(era.allowed)}</EraFact>
              </dl>

              {era.adjustments?.length ? (
                <div className="era-adjustments">
                  <strong>Adjustment codes / details</strong>
                  <p>{era.adjustments.join("; ")}</p>
                </div>
              ) : null}

              <details className="era-lines">
                <summary>
                  View {era.lineCount} service line{era.lineCount === 1 ? "" : "s"}
                  <span aria-hidden="true">⌄</span>
                </summary>
                <div className="era-lines-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">DOS</th>
                        <th scope="col">CPT / modifier</th>
                        <th scope="col">Units</th>
                        <th scope="col">Line reference</th>
                        <th scope="col">Billed</th>
                        <th scope="col">Allowed</th>
                        <th scope="col">Received</th>
                        <th scope="col">Codes / details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {era.serviceLines.map((line) => (
                        <tr key={line.id}>
                          <td>{formatDate(line.serviceDate)}</td>
                          <td><strong>{line.claimLevelOnly ? "Unallocated claim amount" : procedureLabel(line)}</strong></td>
                          <td>{valueOrMissing(line.units)}</td>
                          <td>{valueOrMissing(line.lineReference)}</td>
                          <td>{moneyOrMissing(line.billed)}</td>
                          <td>{moneyOrMissing(line.allowed)}</td>
                          <td className={line.paid < 0 ? "amount-negative" : "amount-positive"}>
                            {formatMoney(line.paid)}
                          </td>
                          <td>{valueOrMissing(line.adjustment)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </article>
          ))}
        </div>
      ) : (
        <p className="era-list-empty">
          No AdvancedMD, ClaimStatus or EDI 835 remittance was found for this claim.
          Posted payments are shown separately from the billing ledger.
        </p>
      )}
    </section>
  );
}
