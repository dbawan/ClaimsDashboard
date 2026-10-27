-- Run once for an existing worklist installation. New installations already
-- receive these columns from create_claims_dashboard_worklists.sql.
ALTER TABLE `UniLocus`.`claims_dashboard_claim_worklists`
  ADD COLUMN `note_text` TEXT NULL
  AFTER `checkbox_state_json`,
  ADD COLUMN `completion_details_json` JSON NULL
  AFTER `note_text`;
