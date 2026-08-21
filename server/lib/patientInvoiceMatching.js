import { normalizeIdentifier } from "./claimIdentity.js";

export const PATIENT_INVOICE_CPT_MAPPINGS = Object.freeze([
  Object.freeze({ product: "Pluvicto", cpt: "A9607", queryPattern: "%PLUVICTO%" }),
  Object.freeze({ product: "Lutathera", cpt: "A9513", queryPattern: "%LUTATHERA%" }),
  Object.freeze({ product: "Xofigo", cpt: "A9606", queryPattern: "%XOFIGO%" }),
  Object.freeze({ product: "Illuccix", cpt: "A9596", queryPattern: "%ILLUCCIX%" }),
  Object.freeze({ product: "I-313 Therapy doses", cpt: "A9517", queryPattern: "%I%313%THERAPY%DOSES%" }),
]);

export function invoiceProductText(row) {
  return normalizeIdentifier([row.ProductName, row.Description, row.ProcedureName].join(" "));
}
