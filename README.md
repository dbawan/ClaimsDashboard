# United Theranostics Claim Lifecycle

A compact React and Express application for viewing a claim from initial creation through submission, adjudication, and payment.

## Run locally

1. Create the SSO permission table with `sql/create_claims_dashboard_user_permissions.sql`, then run `sql/create_claims_dashboard_worklists.sql` once to add the Problem List/Diagnosis permissions and tables.
2. Copy the settings shown in `.env.example` into `.env`. Use a `SELECT`-only MySQL account for claim sources and a separate permission-table account with only the access described below.
3. Install dependencies with `npm install`.
4. Set `APP_ENV=development` in `.env`.
5. Start the application with `npm run dev` and open `http://localhost:4200`.

Use `npm run check` to run the automated tests and production build.

The backend writes each completed HTTP request to the server console with its method,
path, response status, duration, and completion state. Query strings are omitted and
claim IDs are redacted from these access logs.

## Run with Docker

1. Keep the database credentials in `.env`; that file is excluded from the image build.
2. If MySQL runs directly on the Docker host, set `DB_HOST=host.docker.internal`. Keep the existing hostname for a remote MySQL server.
3. Select `APP_ENV=development` or `APP_ENV=production` in `.env`.
4. Start the selected profile with `docker compose up --build`.
5. Open `http://localhost:4200` for development or use the production URL after configuring the reverse proxy.
6. Stop it with `docker compose down`.

Only `APP_ENV` needs to change when switching. The selected profile supplies its own host, port, public origin, and base path:

```dotenv
APP_ENV=development

DEVELOPMENT_HOST=127.0.0.1
DEVELOPMENT_PORT=4200
DEVELOPMENT_APP_ORIGIN=http://localhost:4200
DEVELOPMENT_APP_BASE_PATH=

PRODUCTION_HOST=127.0.0.1
PRODUCTION_PORT=43127
PRODUCTION_APP_ORIGIN=https://apps.unithera.com
PRODUCTION_APP_BASE_PATH=/dashboardapp
```

Open a claim directly with the `claim` query parameter, for example
`https://apps.unithera.com/dashboardapp/?claim=78820`. The Claims workspace loads that claim automatically after SSO.

## EC2 deployment

Set `APP_ENV=production` on EC2. That profile uses `https://apps.unithera.com/dashboardapp` and publishes the container only on the EC2 loopback interface at the uncommon host port `43127`. Port `3000` remains internal to the container and does not occupy an EC2 host port.

Register these exact URLs on the Cognito app client before deploying:

- Callback URL: `https://apps.unithera.com/dashboardapp/callback`
- Allowed sign-out URL: `https://apps.unithera.com/dashboardapp`

Keep `.env` out of a broadly shared ZIP because it contains credentials. Upload it separately to the application directory, restrict it with `chmod 600 .env`, then start the container:

```bash
docker compose up -d --build
curl --fail http://127.0.0.1:43127/dashboardapp/api/health
```

Use an Nginx location that preserves the `/dashboardapp` prefix:

```nginx
location = /dashboardapp {
    return 301 /dashboardapp/;
}

location /dashboardapp/ {
    proxy_pass http://127.0.0.1:43127;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Do not add a trailing slash to `proxy_pass`; the Express server expects to receive the `/dashboardapp` prefix. Keep EC2 port `43127` closed in the public security group because Nginx reaches it through `127.0.0.1`.

## Single sign-on

The app uses the Cognito authorization-code flow. `/dashboardapp/auth/login` creates state and nonce checks, Cognito returns to `/dashboardapp/callback`, and the Express server exchanges the code so the client secret and tokens never enter browser JavaScript. Cognito ID and refresh tokens remain in a bounded server-memory session store; the browser receives only a small, random HTTP-only, SameSite session cookie scoped to the application path (with the Secure attribute on HTTPS deployments). This keeps callback headers within the default Nginx limits. Sessions survive token refreshes but not a container restart, so a restart requires users to sign in again. `COGNITO_SESSION_DAYS` controls the fixed session lifetime and `COGNITO_MAX_SESSIONS` bounds server memory. The Claims and High Level APIs require a valid server session and the configured Cognito group; `/dashboardapp/api/health` remains public for container health checks.

The supplied local `.env` is already configured for the provided Cognito app client and is excluded from version control. For another environment, copy the SSO settings from `.env.example`, set `COGNITO_CLIENT_SECRET` through that environment's secret store, and register both profiles' documented callback and sign-out URLs. Set `COGNITO_ALLOWED_GROUPS` to a comma-separated list, or to an empty value to allow any authenticated pool user.

After Cognito verifies an ID token, the server uses its immutable `sub` claim as the user ID. The first successful sign-in inserts that ID into the permission table with the four read permission blocks enabled; both worklist levels remain disabled by default. Later sign-ins update only `last_login_at`; they never reset permission values changed by an administrator. Permission values are loaded from MySQL for every authenticated request, so a change applies on the user's next API request without requiring another login.

The runtime image uses an unprivileged user, drops Linux capabilities, enables `no-new-privileges`, and mounts its filesystem read-only. No source data, `.env` credentials, Python exports, or development dependencies are included in the runtime image.

Categorized claim data, Salesforce comments, and Gemini categorization are optional. Populate `CLAIMS_API_KEY`, the `SF_*` values, and the `GEMINI_*` values documented in `.env.example`, then restart the application. `CLAIMS_API_BASE_URL` is already set to the provided RCM Claims API. The API key is used only by Express and is never exposed in the browser bundle. Salesforce cases are matched only through the resolved claim's exact ENCOUNTERID/alternate claim identifiers. Salesforce is queried again for every claim search; each immutable comment is categorized independently, and its content-addressed Gemini result is cached in application memory for the life of the server process.

Patient-name search reads `EHR_PATIENT_TABLE` (default `vw_ODBC_pt_PatientInfo`) under `EHR_SCHEMA` and `EHR_LICENSE_KEY`. Type-ahead starts after two name characters and returns at most ten recommendations containing only the patient name, DOB, chart number, inactive indicator, and numeric patient ID needed for exact selection. After selection, the server re-resolves that ID and restricts claim rows to the same `PATIENTGUID` plus `EHR_TRANSACTION_SOURCE` (default `AMD`). Claim summaries are returned newest-first and can be searched by full or partial CPT/HCPCS code, including numeric, A, and J codes. Billed and paid totals and their sort options are included only for users with `payments_and_era` permission and use the same ERA-first reconciliation as the claim workspace. The response is bounded to the newest 100 claims and explicitly reports when more exist.

Salesforce note creation is separately gated and defaults off. To expose the note composer, both `SF_NOTE_WRITES_ENABLED=true` and a non-empty `SF_NOTE_WRITER_GROUPS` list are required. The signed-in user must belong to one of those Cognito groups and must also have `supporting_records` permission. Keep the switch false until the integration user, record type, writer group, and production rollback procedure have been reviewed. `SF_NOTE_RECORD_TYPE` defaults to `Claim`; the server resolves that record type before creating anything and refuses to write if it is missing or ambiguous. Every created note receives a server-generated attribution footer containing the signed-in SSO user's name (and email when available) plus the Claim Lifecycle application as its submission source.

## User permissions

See [Claim Dashboard Permission Columns](docs/permission-columns.md) for the dedicated security-column reference and the exact data boundary controlled by each flag.

The default schema and table are `UniLocus.claims_dashboard_user_permissions`. Both identifiers are configurable with `USER_PERMISSIONS_SCHEMA` and `USER_PERMISSIONS_TABLE`. Permission-database connection settings use the dedicated `PERMISSIONS_DB_*` values and intentionally never fall back to the claim-source `DB_*` connection. Fill in `PERMISSIONS_DB_HOST`, `PERMISSIONS_DB_USER`, and `PERMISSIONS_DB_PASSWORD` with the dev-database credentials before starting the app. When that dev MySQL server runs directly on the Docker host, use `PERMISSIONS_DB_HOST=host.docker.internal`. The application account needs `SELECT`, permission to insert `cognito_uid` and `last_login_at`, and permission to update `last_login_at` on the permission table. For the two worklist tables it also needs `SELECT`, `INSERT`, and `UPDATE`; the application exposes no worklist delete operation. It does not need permission to alter tables or update permission columns.

Each boolean column is one independent block. An enabled claim block is enforced in the API response as well as the UI, so disabling it removes the protected data rather than merely hiding a screen.

| Column | Permission block | Data and screens it permits |
| --- | --- | --- |
| `claim_overview` | Claim overview | Claim lookup, identity/demographics, payer, service/procedure details, submission history, status, and non-financial lifecycle events. |
| `payments_and_era` | Payments & ERA | Charges, balances, CPT financials, payments, reversals/recoupments, denials, ERA records, reconciliation rules, and financial lifecycle events. |
| `supporting_records` | Supporting records | Prior authorizations, Salesforce comments, claim categorization, patient invoices, and their integration status. |
| `high_level_operations` | High-level operations | Claim ICU prioritization, High Level Dashboard aggregates, and the all-patient Claims, Unsubmitted, and No Response queues. |
| `worklist_access` | Problem List access | View the Problem List assigned to a claim, complete its tasks, and see completion attribution. Defaults to `FALSE`. |
| `worklist_management` | Diagnosis access | Includes Problem List access, plus the Diagnosis panel for reusable types, claim notes, and type assignment. Defaults to `FALSE`. |

Run this once with a database-administration account (or run the checked-in SQL file):

```sql
CREATE TABLE IF NOT EXISTS `UniLocus`.`claims_dashboard_user_permissions` (
  `cognito_uid` VARCHAR(128) NOT NULL,
  `claim_overview` BOOLEAN NOT NULL DEFAULT TRUE,
  `payments_and_era` BOOLEAN NOT NULL DEFAULT TRUE,
  `supporting_records` BOOLEAN NOT NULL DEFAULT TRUE,
  `high_level_operations` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_login_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`cognito_uid`)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

For example, an administrator can remove payment and high-level access without changing the other blocks:

```sql
UPDATE `UniLocus`.`claims_dashboard_user_permissions`
SET `payments_and_era` = FALSE,
    `high_level_operations` = FALSE
WHERE `cognito_uid` = 'the-cognito-sub-value';
```

If the schema or table environment values are changed, update the qualified identifiers in administrative SQL to match. The server rejects invalid identifier characters during startup.

Run [the checked-in worklist migration](sql/create_claims_dashboard_worklists.sql) once after the permission table exists. It adds both default-off worklist permission columns and creates `claims_dashboard_worklist_types` plus `claims_dashboard_claim_worklists`. If the earlier single-permission version of that migration has already run, apply only [the incremental access-permission migration](sql/add_worklist_access_permission.sql) instead.

For a database that already has both worklist tables, also run [the notes and completion migration](sql/add_claim_worklist_notes_and_completion.sql) once. It adds the claim-specific Diagnosis note and per-task completion-attribution fields used by the Problem List.

Run [the worklist owner-name migration](sql/add_claim_worklist_owner_name.sql) once on an existing installation so Claim ICU can show the assigning user's display name. The server remains compatible before that migration and shows an assigned state without a name.

Run [the multiple-worklists migration](sql/allow_multiple_claim_worklists.sql) once on an existing installation. It preserves the current assignment and changes the assignment key so each claim can carry multiple distinct Diagnosis/Problem List worklists at the same time. New installations receive this key from `create_claims_dashboard_worklists.sql`.

Grant level-one checklist access with:

```sql
UPDATE `UniLocus`.`claims_dashboard_user_permissions`
SET `worklist_access` = TRUE,
    `worklist_management` = FALSE
WHERE `cognito_uid` = 'the-cognito-sub-value';
```

Grant level-two creation and assignment access with:

```sql
UPDATE `UniLocus`.`claims_dashboard_user_permissions`
SET `worklist_access` = TRUE,
    `worklist_management` = TRUE
WHERE `cognito_uid` = 'the-cognito-sub-value';
```

## Data-safety guarantees

- Claim-source retrieval remains `GET`-only. Mutations are limited to permission-gated worklist configuration/state in `UniLocus` and the explicitly gated Salesforce-note endpoint.
- Every claim-source lookup runs inside a MySQL `READ ONLY` transaction.
- The claim-source repository session exposes only a guarded `select()` method and rejects non-`SELECT` or multi-statement SQL.
- Every claim-source database session is rolled back before its connection is released.
- Application MySQL writes are isolated to the SSO permission upsert and the two `UniLocus` worklist tables. Source claim, ERA, EHR, and transaction schemas are never written.
- Individual claim details use a 24-hour server-memory cache. Patient-name searches, patient claim lists, CPT/HCPCS lookups, and every High Level view retain a six-hour cache. Matching concurrent MySQL requests share one load. Expiry is measured from successful load completion and is not extended by reads; each cache holds at most 500 entries and evicts the least recently used result when full. Cache entries never write to MySQL, disk, or browser storage, and a server restart clears them.
- A claim search first returns the cached MySQL snapshot, then refreshes Salesforce comments and categorized activity separately so the claim workspace can render without waiting on live integrations. Salesforce comments are never served from the claim cache. Diagnosis and Problem List endpoints also remain uncached and set `Cache-Control: no-store`; Claim ICU refreshes its Problem List owner lookup on every request even when its claim-source snapshot is cached. Failed loads and temporary integration errors remain retryable. Access checks and response filtering still run on every request, and patient-list cache keys include financial permissions, dates, pagination, and CPT filters. Calendar-based claim ages and deadlines are recalculated whenever a cached claim is served and again after live comments arrive.
- Salesforce reads remain limited to guarded, non-locking SOQL `SELECT` queries. When note creation is enabled, the isolated writer can only send `POST` to the configured `UniSuite_RCM_Case_Note__c` collection; it has no update or delete method.
- Before creating a note, the server resolves the internal claim through read-only MySQL, requires a unique Salesforce ticket match, resolves the configured Claim record type, validates message length, enforces same-origin submission, and applies an idempotency key. Ambiguous or missing tickets fail without writing.
- The client does not use local storage or upload files. The Problem List is hidden without either worklist permission, while the Diagnosis tab and every type creation, catalog removal, note, and assignment control require `worklist_management`. Catalog removal is a soft removal that blocks future selection while preserving every claim that already uses the type. The Salesforce note composer is hidden unless the server reports that all feature, integration, supporting-record, and writer-group gates passed.
- The Compose runtime filesystem is read-only and has no application data volume.

If Salesforce confirms creation, the server audit log records only the authenticated user ID, Salesforce case ID, and new note ID; the note body and application claim ID are not logged. If the response is interrupted or otherwise uncertain, the same idempotency key is retained temporarily and the interface instructs the user to verify Salesforce rather than blindly resubmit.

## Comment data and Gemini

- Salesforce note text is sent from the server directly to the configured Gemini account; credentials and notes are never placed in the browser bundle.
- Use only a Gemini account and Google project approved for medical billing claim-comment data.
- The Gemini taxonomy is: appeal submitted, appeal planned/prepared, appeal follow-up/status, payment identified/posting, corrected claim/rebill, denial/pending, write-off/adjustment, other, and insufficient evidence.
- Gemini must return structured JSON with one known category, a known confidence level, and evidence that is an exact excerpt from the Salesforce action, follow-up, or comment text.
- Comments are ordered by Salesforce `CreatedDate`. They appear as informational graph/timeline events and never change ERA payments, cumulative payments, charges, or balances.
- If credentials are missing, a query fails, or a per-comment classification fails, the primary MySQL/ERA lifecycle remains available and the UI reports the comment-integration status.

## Reconciliation rules

- `FlattenTransctions2.ENCOUNTERID` is the canonical claim ID and supplies claim creation and lifecycle activity.
- An ERA patient-control number belongs to an encounter only when it is exactly the ENCOUNTERID followed by letters. Those suffixes are correction/rebill iterations within one claim, ordered A, B, C, and so on.
- **Posted payment** comes only from signed `FlattenTransctions2.Amount` payment actions, including reversals and voids. Repeated `Receipt`/`pay` snapshots are not summed. Posting dates drive posted-payment graphs and the posting threshold.
- **Payment received** comes from deduplicated AdvancedMD ERA, `ClaimStatus`, and `edi_835` remittances. Receipt amounts use the ERA check/EFT date (with receipt/import-date fallback); the AdvancedMD ERA arrival date is displayed separately. Received and posted amounts are independent and are never added together.
- AdvancedMD reads use `EHR_SCHEMA` and `EHR_LICENSE_KEY`. Report headers join claims on license and `ReportFID`; details join on license, report and `ERAClaimFID`. Native `ChargeDetailID` corresponds to AMD `PAYMENTCLAIMID`; `FlattenTransctions2.CLAIMID` is the native charge ID plus **40,000**. This offset does not apply to `VisitID` / `ENCOUNTERID`.
- ERA claims without service lines remain visible; claim/header differences appear as unallocated received amounts. Display, dismissed and posting-failure metadata do not independently establish ledger posting. Zero IDs are not used as charge links.
- Complete remittance copies and remaining matching service lines are deduplicated across sources with claim identity required even when several claims share a check. AdvancedMD is preferred for complete matching copies. No schema migrations or source database writes are required.
- Patient name, date of service, and CPT differences are displayed as informational correction/rebill changes. They never merge, reject, or establish claim membership.
- ERA and payment events remain chronological even when their dates overlap the logical suffix sequence.
- Service-line rows are aggregated for display: claim creation, billing, payment posting, adjustment, settlement, and each ERA remittance appear once per event rather than once per CPT. The ERA section exposes source references, trace/check details, financial totals, adjustment information, and expandable line detail without double-counting duplicate ClaimStatus/835 copies.
- CPT charts switch between posted and received payment streams. Both preserve signed reversals; the posted view never falls back to ERA amounts when no posting exists.
- The claim-status bar combines transaction and ERA evidence with appointment-linked prior-authorization data. Prior authorization is retrieved from the EHR views only when `AppointmentFID` equals the canonical claim/visit ID, using `EHR_SCHEMA` and `EHR_LICENSE_KEY`; this targeted query runs inside the same guarded read-only transaction and 24-hour individual-claim cache.
- Claim lookup lives in the global header and appears only in the Claims workspace. The aggregate claim graph is replaced by large CPT payment charts presented in paged grids of three per row; the bottom slider moves between complete chart pages, and each chart opens an expanded dated-payment view.
- The High Level Dashboard uses exact transaction types and `POSTINGDATE` for every billing mode. All submissions includes `Billed`, `Re-billed claim`, and `Re-billed`; latest only ranks those posting dates across each ENCOUNTERID's complete submission history and keeps the newest family member; original only uses `Claim created` rows directly. The billed total, graph, hover detail, and selected-date billed claims follow that choice. Its payer dropdown is populated from the selected date range, displays distinct claim-family counts for every payer, supports multiple selections, and filters billing, remittance, recoupment, and denial results from the same cached range data. Deduplicated AdvancedMD/ClaimStatus/EDI receipts remain grouped by remittance date. A separate posted-payment series and selected-date claim list use signed Flatten payment actions and their posting dates. Related same-day remittances are first netted by claim/rebill reference and payer, so a reversal followed by a reduced replacement payment contributes only the actual difference. The resulting positive payments and negative recoupments are shown as separate graph lines, totals, hover values, and selected-date claim lists. Each billed, posted, received, and ERA recoupment graph line can be independently shown or hidden. Zero-paid remittance lines with adjustment reasons drive the denial rankings. Denied CPT rows expand to their claim references, using only the CPT amount from each encounter's latest billed/re-billed posting date; claim links open the Claims workspace in a new tab.
- Claims and the High Level claim list show when cumulative posted payments first reach the configured percentage of the latest charge. The default is 50%, equality counts as reached, partial payments are aggregated chronologically, and the metric reports calendar days from claim creation. Set `CLAIM_PAID_THRESHOLD_PERCENT` in `.env` to a value greater than 0 and no more than 100, then restart the server.
- In High Level Claims, clicking the timeline area of a row expands its CPT breakdown: latest charge, net posted payment, received payment, and a horizontal posted-payment-to-charge bar. The breakdown uses the full claim history and the same latest charge snapshot as the left tile, independently of the visible timeline date window. Expansion reuses the six-hour cached result without another database query. The left claim tile continues to open the Claims workspace in a new tab. Enter or Space toggles the breakdown; Escape closes it.
- Claim Vitals uses a 90-calendar-day filing window from DOS, reset by the latest recorded appeal submission or corrected claim/rebill. It compares dated Flatten action transactions with Salesforce comments classified as `appeal_submitted` or `corrected_claim_or_rebill` (using their recorded creation dates). Planned appeals, status follow-ups, and inferred ERA suffix observations do not reset the window; an action older than DOS cannot move the deadline backwards. The appeal deadline displays the date produced by that same 90-day timer. Outstanding AR is total service-line charges minus net posted payments minus booked write-offs (`FlattenTransctions2.Adjustments`, deduplicated per service line), not Salesforce insurance owed or a sum of ERA adjustment reasons. Signed reversals and credit balances are preserved, and AR follows the payments/ERA permission.
- With no claim argument, the application opens High Level on Claim ICU. Claim ICU shows claims with outstanding AR and defaults to the nearest non-expired 90-day filing deadline; users can instead prioritize the highest charged amount or include already-expired deadlines. Its Recovery estimate is the unpaid matrix-based expected reimbursement capped by the claim's outstanding AR, and its Owner is the current Problem List assignment. Claim links open the existing Claims workspace in a new tab.
- High Level Dashboard and Claims share a CPT / HCPCS search field. Enter a full or partial code and select Apply; clear it and apply to restore all codes. Dashboard filters billing, payment, recoupment, and denial lines before aggregating totals and date detail, while retaining the selected payer and billing mode. Claims filters matching encounter families before counting and pagination, resets to page one on Apply, and preserves each matching claim's full financial history and paid-age metric.
- Unsubmitted and No Response support the same preset, custom-day, and custom-date ranges as the Dashboard. Unsubmitted ranges use the appointment/service date; No Response ranges use the latest submission posting date. The Unsubmitted queue can also include every appointment, exclude appointments younger than 14 days, or apply a user-selected minimum age. These age switches filter the selected cached queue locally without another MySQL request.
- Dense chart dates use collision-aware axis labels. Every date band and event card supports hover, keyboard focus, and tap/click selection to reveal cumulative paid, the counted change, marker category, source, and full event details.
- Salesforce comments extend the same graph using category-colored markers/cards. Same-day comments retain their Salesforce timestamp order and are numbered in sequence.
- The chronological timeline is collapsed by default and expands from its accessible Claim Timeline control.
