-- Run this migration once after create_claims_dashboard_user_permissions.sql.
ALTER TABLE `UniLocus`.`claims_dashboard_user_permissions`
  ADD COLUMN `worklist_access` BOOLEAN NOT NULL DEFAULT FALSE
  AFTER `high_level_operations`,
  ADD COLUMN `worklist_management` BOOLEAN NOT NULL DEFAULT FALSE
  AFTER `worklist_access`;

CREATE TABLE IF NOT EXISTS `UniLocus`.`claims_dashboard_worklist_types` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `type_name` VARCHAR(120) NOT NULL,
  `checkboxes_json` JSON NOT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_by_cognito_uid` VARCHAR(128) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `worklist_type_name_unique` (`type_name`),
  KEY `worklist_type_active_name` (`is_active`, `type_name`)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `UniLocus`.`claims_dashboard_claim_worklists` (
  `claim_id` VARCHAR(80) NOT NULL,
  `worklist_type_id` BIGINT UNSIGNED NOT NULL,
  `checkbox_state_json` JSON NOT NULL,
  `note_text` TEXT NULL,
  `completion_details_json` JSON NULL,
  `assigned_by_cognito_uid` VARCHAR(128) NOT NULL,
  `assigned_by_name` VARCHAR(200) NULL,
  `updated_by_cognito_uid` VARCHAR(128) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`claim_id`, `worklist_type_id`),
  KEY `claim_worklist_type` (`worklist_type_id`),
  CONSTRAINT `claim_worklist_type_fk`
    FOREIGN KEY (`worklist_type_id`)
    REFERENCES `UniLocus`.`claims_dashboard_worklist_types` (`id`)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- Example: authorize one designated Cognito user.
-- UPDATE `UniLocus`.`claims_dashboard_user_permissions`
-- SET `worklist_access` = TRUE,
--     `worklist_management` = TRUE
-- WHERE `cognito_uid` = 'the-cognito-sub-value';
