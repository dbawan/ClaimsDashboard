import { cptPaymentProgress } from "./highLevelModel.js";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function ClaimCptPayments({ claim, id }) {
  const rows = claim.cptPayments || [];
  return (
    <section className="claim-cpt-payments" id={id} aria-label={`Payments by CPT for claim ${claim.claimId}`}>
      <header>
        <div>
          <h3>Payments by CPT</h3>
          <p>Full claim history{claim.latestChargeDate ? ` · Latest charge ${claim.latestChargeDate}` : ""}</p>
        </div>
        <span className="claim-cpt-bar-legend"><i />Posted payment / latest charge</span>
      </header>
      {rows.length ? (
        <div className="claim-cpt-table-scroll">
          <table>
            <thead><tr><th scope="col">CPT / HCPCS</th><th scope="col">Latest charge</th><th scope="col">Posted payment</th><th scope="col">Payment received</th><th scope="col">Charge paid</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const progress = cptPaymentProgress(row);
                const label = row.procedure === "UNCODED" ? "Unallocated" : row.procedure;
                const percentage = progress.percent == null ? "No positive charge" : `${percent.format(progress.percent)}% posted`;
                return (
                  <tr key={row.procedure}>
                    <th scope="row">{label}</th>
                    <td>{row.latestCharge == null ? <span className="claim-cpt-unavailable">Not in latest charge</span> : money.format(row.latestCharge)}</td>
                    <td className={row.posted < 0 ? "amount-negative" : "amount-positive"}>{money.format(row.posted)}</td>
                    <td>{money.format(row.received)}</td>
                    <td>
                      <div className={`claim-cpt-progress${row.posted < 0 ? " claim-cpt-progress-negative" : ""}`}>
                        <div
                          className="claim-cpt-progress-track"
                          role={progress.percent == null ? undefined : "meter"}
                          aria-label={`${label} posted payment against latest charge`}
                          aria-valuemin={progress.percent == null ? undefined : 0}
                          aria-valuemax={progress.percent == null ? undefined : 100}
                          aria-valuenow={progress.percent == null ? undefined : progress.width}
                          aria-valuetext={`${money.format(row.posted)} posted${row.latestCharge == null ? "; no latest charge available" : ` of ${money.format(row.latestCharge)} charged`}; ${percentage}`}
                        >
                          <span style={{ width: `${progress.width}%` }} />
                        </div>
                        <span>{percentage}{progress.excess > 0 ? ` · ${money.format(progress.excess)} above charge` : ""}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="claim-cpt-empty">No CPT charge or payment detail is available for this claim.</p>}
    </section>
  );
}
