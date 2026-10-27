-- Run this only if create_claims_dashboard_worklists.sql was previously applied
-- when it contained the single worklist_management permission.
ALTER TABLE `UniLocus`.`claims_dashboard_user_permissions`
  ADD COLUMN `worklist_access` BOOLEAN NOT NULL DEFAULT FALSE
  AFTER `high_level_operations`;

-- Level 1: view the assigned worklist and update its checkmarks.
-- UPDATE `UniLocus`.`claims_dashboard_user_permissions`
-- SET `worklist_access` = TRUE,
--     `worklist_management` = FALSE
-- WHERE `cognito_uid` = 'the-cognito-sub-value';

-- Level 2: level 1 plus creating and assigning worklist types.
-- UPDATE `UniLocus`.`claims_dashboard_user_permissions`
-- SET `worklist_access` = TRUE,
--     `worklist_management` = TRUE
-- WHERE `cognito_uid` = 'the-cognito-sub-value';
