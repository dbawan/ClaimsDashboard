-- Run this migration once on installations that already use
-- claims_dashboard_claim_worklists. It preserves every existing assignment and
-- allows a claim to carry one assignment for each worklist type.
ALTER TABLE `UniLocus`.`claims_dashboard_claim_worklists`
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (`claim_id`, `worklist_type_id`);
