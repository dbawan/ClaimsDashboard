# Claim Dashboard Permission Columns

The `UniLocus.claims_dashboard_user_permissions` table stores one row for each Cognito user. The `cognito_uid` value is the immutable `sub` claim from the user's verified Cognito ID token.

Every permission column is a non-null MySQL boolean. The four read permissions default to `TRUE`; `worklist_access` and `worklist_management` default to `FALSE` so they must be granted explicitly to designated users. Permissions are enforced by the Express API as well as the React interface, so disabling a column removes the protected response data and its related navigation, panels, and controls.

## `claim_overview`

Controls access to the general claim record and non-financial lifecycle information.

When enabled, the user can access:

- Claim lookup.
- Claim and encounter identifiers.
- Patient identity and demographic information.
- Provider, location, payer, service date, and procedure information.
- Claim status and first-known activity dates.
- Submission, correction, and rebill history.
- Non-financial lifecycle events and claim progress.

When disabled, those overview fields and lifecycle records are removed from the API response. Claim lookup remains available only if `payments_and_era` or `supporting_records` is enabled.

## `payments_and_era`

Controls access to financial claim information and authoritative remittance records.

When enabled, the user can access:

- Charges, adjustments, balances, and paid totals.
- CPT-level charge and payment information.
- Payment postings and authoritative ERA payments.
- Reversals and recoupments.
- Denials and financial adjustment information.
- ClaimStatus and EDI 835 ERA records.
- Payment reconciliation rules, duplicate counts, and matched-posting information.
- Financial lifecycle events and payment charts.

When disabled, financial totals, ERA collections, CPT financials, financial events, charts, and reconciliation details are omitted from the API response and UI.

## `supporting_records`

Controls access to records and integrations that support the primary claim lifecycle.

When enabled, the user can access:

- Appointment-linked prior authorizations.
- Salesforce claim cases and comments.
- Gemini-generated comment categorization results.
- RCM Claims API categorization records.
- Patient invoice records and invoice-matching details.
- Supporting-integration status and diagnostic messages.

This permission alone does not authorize Salesforce writes. Creating a new Salesforce claim note additionally requires the default-off `SF_NOTE_WRITES_ENABLED` switch and membership in one of the Cognito groups listed in `SF_NOTE_WRITER_GROUPS`. Existing Salesforce claims and notes remain non-editable from this application.

Supporting records may contain their own claim, financial, or patient context because they are displayed as complete source records. When disabled, the supporting collections, related timeline comments, source counts, drawer panels, and bottom-dock controls are omitted.

## `high_level_operations`

Controls access to aggregate and all-patient operational screens.

When enabled, the user can access:

- The High Level Dashboard.
- Aggregate billing, payment, recoupment, and denial data.
- High-level claim lists and drill-down links.
- The Unsubmitted operational queue.
- The No Response operational queue.
- Date-range, payer, billing-mode, and operational filters.

When disabled, the High Level navigation is hidden and every `/api/high-level/*` route returns HTTP 403.

## `worklist_access`

Controls level-one access to the claim Problem List panel.

When enabled, the user can:

- View all Problem List worklists currently assigned to a claim, including each Diagnosis note.
- Check or uncheck tasks, with the authenticated user's name and completion time recorded for each completed task.

This permission does not allow the user to list reusable types, create a type, or add a type to a claim.

## `worklist_management`

Controls access to the claim Diagnosis panel. A user with this permission can:

- Use the assigned checklist, even when `worklist_access` is `FALSE`.
- View active reusable worklist types.
- Create a worklist type with server-validated checkbox definitions stored as JSON.
- Remove a type from the reusable Diagnosis catalog. Existing claim assignments, notes, tasks, and completion history remain available on those claims.
- Attach multiple existing or newly created worklist types to the current claim and add a claim-specific note to each one for the Problem List user.

Both worklist permissions default to `FALSE` and neither grants claim lookup by itself; the user must also have at least one claim read permission. When both are disabled, both Problem List and Diagnosis are omitted and every worklist endpoint returns HTTP 403. Diagnosis is omitted unless `worklist_management` is enabled.

## Default and update behavior

The first successful SSO login inserts a row using the table defaults, which grants the four read permission blocks and leaves both worklist levels disabled. Subsequent logins update only `last_login_at`; they do not restore or grant a permission changed by an administrator.

For example, this keeps overview and supporting-record access while removing financial and high-level access:

```sql
UPDATE `UniLocus`.`claims_dashboard_user_permissions`
SET `claim_overview` = TRUE,
    `payments_and_era` = FALSE,
    `supporting_records` = TRUE,
    `high_level_operations` = FALSE,
    `worklist_access` = TRUE,
    `worklist_management` = TRUE
WHERE `cognito_uid` = 'the-cognito-sub-value';
```

Permission changes are loaded on the user's next authenticated API request. If all four read permission columns are `FALSE`, the user can authenticate but receives an access-unavailable screen even if either worklist permission is enabled, because worklists operate only within a permitted claim.

## Non-permission columns

The remaining columns support identity and auditing; they do not grant access:

- `cognito_uid`: Primary key containing the verified Cognito `sub` value.
- `created_at`: Time the permission row was first created.
- `updated_at`: Time the row was last changed, including an administrative permission change or login timestamp update.
- `last_login_at`: Time of the latest successful SSO login or provisioning event.
