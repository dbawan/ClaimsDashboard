import { config } from "../config.js";
import { submissionSuffix } from "../lib/claimIdentity.js";

const EHR = `\`${config.schemas.ehr}\``;
const MAX_ROWS = 100_000;

// Source charge IDs are unshifted. Only Flatten.CLAIMID carries the AMD offset.
export { ADVANCED_MD_CLAIM_OFFSET } from "../lib/eraReconciliation.js";

export async function readAdvancedMdEra(session, { claimIds, start, end } = {}) {
  if (claimIds && !claimIds.length) return [];
  const parameters = [config.ehr.licenseKey];
  let predicate = "c.LicenseKey = ?";
  if (claimIds) {
    const placeholders = claimIds.map(() => "?").join(", ");
    predicate += ` AND (c.VisitID IN (${placeholders}) OR CAST(c.ClaimID AS UNSIGNED) IN (${placeholders}))`;
    parameters.push(...claimIds, ...claimIds);
  }
  if (start && end) {
    predicate += " AND COALESCE(r.CheckOrEFTDate, r.DateReceived, c.CreatedAt) >= ? AND COALESCE(r.CheckOrEFTDate, r.DateReceived, c.CreatedAt) < DATE_ADD(?, INTERVAL 1 DAY)";
    parameters.push(start, end);
  }
  const rows = await session.select(
    `SELECT c.LicenseKey AS licenseKey, c.ERAClaim_UID AS eraClaimId,
            c.ReportFID AS reportId, c.VisitID AS visitId, c.ClaimID AS reference,
            c.CarrierClaimID AS payerClaimControl, c.CarrierName AS payer,
            c.ClaimStatus AS claimStatus, c.ClaimPaymentAmount AS claimPaid,
            c.PostFailed AS postFailed, c.Display AS claimDisplay,
            COALESCE(r.CheckOrEFTDate, r.DateReceived, c.CreatedAt) AS eventDate,
            r.DateReceived AS receivedAt, r.PaymentNumber AS traceNumber,
            r.DismissedAt AS dismissedAt, r.StatusFID AS reportStatus,
            d.ERAReportDetail_UID AS detailId, d.ChargeDetailID AS chargeId,
            d.ChargeCode AS procedureCode, d.ServiceDate AS serviceDate,
            d.AmountPaid AS paid, d.AmountClaim AS charge,
            d.AmountAllowed AS allowed, d.AmountPatient AS patientResponsibility,
            d.AmountAdjusted AS adjusted, reasons.reason
       FROM ${EHR}.vw_ODBC_edi_Era_ReportClaim c
       LEFT JOIN ${EHR}.vw_ODBC_edi_Era_Report r
         ON r.LicenseKey = c.LicenseKey AND r.Report_UID = c.ReportFID
       LEFT JOIN ${EHR}.vw_ODBC_edi_Era_ReportDetail d
         ON d.LicenseKey = c.LicenseKey AND d.ERAClaimFID = c.ERAClaim_UID AND d.ReportFID = c.ReportFID
       LEFT JOIN (
         SELECT reason.LicenseKey, reason.ERAReportDetailFID,
                GROUP_CONCAT(DISTINCT CONCAT_WS(': ', dictionary.Code, dictionary.Reason)
                  ORDER BY dictionary.Code SEPARATOR ', ') AS reason
           FROM ${EHR}.vw_ODBC_edi_Era_ReportDetailReason reason
           LEFT JOIN ${EHR}.vw_ODBC_mf_PaymentReasons dictionary
             ON dictionary.LicenseKey = reason.LicenseKey AND dictionary.PaymentReason_UID = reason.PaymentReasonFID
          GROUP BY reason.LicenseKey, reason.ERAReportDetailFID
       ) reasons ON reasons.LicenseKey = d.LicenseKey AND reasons.ERAReportDetailFID = d.ERAReportDetail_UID
      WHERE ${predicate}
      ORDER BY c.ERAClaim_UID, d.ERAReportDetail_UID
      LIMIT ${MAX_ROWS + 1}`,
    parameters,
    { label: "era.advancedmd.received-payments" },
  );
  if (rows.length > MAX_ROWS) throw new Error("AdvancedMD ERA result exceeds the complete-result limit. Narrow the date range.");
  return claimIds ? rows.filter((row) => claimIds.some((id) => (
    submissionSuffix(id, row.reference) !== null
    && (!Number(row.visitId) || String(row.visitId) === id)
  ))) : rows;
}
