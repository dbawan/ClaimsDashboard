-- Run once for an existing worklist installation. New installations already
-- receive this column from create_claims_dashboard_worklists.sql.
ALTER TABLE `UniLocus`.`claims_dashboard_claim_worklists`
  ADD COLUMN `assigned_by_name` VARCHAR(200) NULL
  AFTER `assigned_by_cognito_uid`;
