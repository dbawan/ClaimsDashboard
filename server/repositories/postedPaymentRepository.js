import { config } from "../config.js";

// Amount is the signed action amount. Receipt/pay are repeated balance snapshots.
export async function readPostedPayments(session, { start, end, claimIds } = {}) {
  if (claimIds && !claimIds.length) return [];
  const parameters = [];
  let predicate = "CLAIMTRANSACTIONTYPENAME IN ('Applied payment', 'Payment applied', 'Payment reversal', 'Voided payment', 'Insurance payment', 'Payment posted', 'Payment received', 'Remittance payment', 'Paid transaction', 'Receipt')";
  if (claimIds) {
    predicate += ` AND ENCOUNTERID IN (${claimIds.map(() => "?").join(", ")})`;
    parameters.push(...claimIds);
  }
  if (start && end) {
    predicate += " AND POSTINGDATE >= ? AND POSTINGDATE < DATE_ADD(?, INTERVAL 1 DAY)";
    parameters.push(start, end);
  }
  return session.select(
    `SELECT DISTINCT EHR AS sourceSystem, CLAIMTRANSACTIONID AS transactionId,
            CLAIMTRANSACTIONTYPENAME AS eventType, PAYMENTID AS paymentId,
            PAYMENTCLAIMID AS chargeId, CAST(ENCOUNTERID AS CHAR) AS reference,
            POSTINGDATE AS eventDate, DATEOFSERVICE AS serviceDate,
            PROCEDURECODE AS procedureCode, MOD1 AS modifier, Amount AS paid,
            COALESCE(NULLIF(CompanyName1, ''), NULLIF(PayerPlan1, '')) AS payer
       FROM \`${config.schemas.transactions}\`.\`${config.tables.transactions}\`
      WHERE ${predicate}`,
    parameters,
    { label: "payments.posted-transactions" },
  );
}
