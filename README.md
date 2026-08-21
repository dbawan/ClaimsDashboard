# United Theranostics Claim Lifecycle

A compact React and Express application for viewing a claim from initial creation through submission, adjudication, and payment.

## Run locally

1. Copy the database settings shown in `.env.example` into `.env` and use a MySQL account with `SELECT`-only grants.
2. Install dependencies with `npm install`.
3. Start the application with `npm run dev`.
4. Open `http://localhost:4200`. Unauthenticated sessions are sent through Cognito SSO and returned to `http://localhost:4200/callback`.

Use `npm run check` to run the automated tests and production build.

## Run with Docker

1. Keep the database credentials in `.env`; that file is excluded from the image build.
2. If MySQL runs directly on the Docker host, set `DB_HOST=host.docker.internal`. Keep the existing hostname for a remote MySQL server.
3. Start the production container with `docker compose up --build`.
4. Open `http://localhost:4200`. The callback registered for this Cognito app client requires port 4200.
5. Stop it with `docker compose down`.

Open a claim directly with the `claim` query parameter, for example
`http://localhost:4200/?claim=78820`. The Claims workspace loads that claim automatically after SSO.

## Single sign-on

The app uses the Cognito authorization-code flow. `/auth/login` creates state and nonce checks, Cognito returns to `/callback`, and the Express server exchanges the code so the client secret and tokens never enter browser JavaScript. Session and refresh tokens are stored only in HTTP-only, SameSite cookies (and receive the Secure attribute on HTTPS deployments). The Claims and High Level APIs require a valid ID token and the configured Cognito group; `/api/health` remains public for container health checks.

The supplied local `.env` is already configured for the provided Cognito app client and is excluded from version control. For another environment, copy the SSO settings from `.env.example`, set `COGNITO_CLIENT_SECRET` through that environment's secret store, and register its exact `APP_ORIGIN/callback` and `APP_ORIGIN` sign-out URLs in Cognito. Set `COGNITO_ALLOWED_GROUPS` to a comma-separated list, or to an empty value to allow any authenticated pool user.

The runtime image uses an unprivileged user, drops Linux capabilities, enables `no-new-privileges`, and mounts its filesystem read-only. No source data, `.env` credentials, Python exports, or development dependencies are included in the runtime image.

Categorized claim data, Salesforce comments, and Gemini categorization are optional. Populate `CLAIMS_API_KEY`, the `SF_*` values, and the `GEMINI_*` values documented in `.env.example`, then restart the application. `CLAIMS_API_BASE_URL` is already set to the provided RCM Claims API. The API key is used only by Express and is never exposed in the browser bundle. Salesforce cases are matched only through the resolved claim's exact ENCOUNTERID/alternate claim identifiers. Each comment is categorized independently and the result is cached in application memory for the life of the server process.

## Read-only guarantees

- The API exposes claim retrieval through `GET` only and rejects mutation-style methods with HTTP 405.
- Every lookup runs inside a MySQL `READ ONLY` transaction.
- The repository session exposes only a guarded `select()` method and rejects non-`SELECT` or multi-statement SQL.
- Every database session is rolled back before its connection is released.
- Successful MySQL result sets for Claims and every High Level queue are cached in server memory for 24 hours. Cache entries never write to MySQL, disk, or browser storage, and a server restart clears them.
- Salesforce data access is limited to guarded, non-locking SOQL `SELECT` queries. The OAuth token refresh is the only Salesforce POST request and does not edit Salesforce data.
- The client does not use local storage, upload files, or expose edit controls.
- The Compose runtime filesystem is read-only and has no application data volume.

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
- `ClaimStatus` and `edi_835` are authoritative for payment amounts.
- A posted practice-management payment is counted only when no matching non-zero ERA payment exists.
- Patient name, date of service, and CPT differences are displayed as informational correction/rebill changes. They never merge, reject, or establish claim membership.
- ERA and payment events remain chronological even when their dates overlap the logical suffix sequence.
- Service-line rows are aggregated for display: claim creation, billing, payment posting, adjustment, settlement, and each ERA remittance appear once per event rather than once per CPT. The ERA section exposes source references, trace/check details, financial totals, adjustment information, and expandable line detail without double-counting duplicate ClaimStatus/835 copies.
- Each CPT payment graph accumulates only authoritative ERA amounts and true transaction fallbacks, including reversals, and compares that progression with the CPT's charge without counting matched payment postings twice.
- The claim-status bar combines transaction and ERA evidence with appointment-linked prior-authorization data. Prior authorization is retrieved from the EHR views only when `AppointmentFID` equals the canonical claim/visit ID, using `EHR_SCHEMA` and `EHR_LICENSE_KEY`; this targeted query runs inside the same guarded read-only transaction and 24-hour claim cache.
- Claim lookup lives in the global header and appears only in the Claims workspace. The aggregate claim graph is replaced by large CPT payment charts presented in paged grids of three per row; the bottom slider moves between complete chart pages, and each chart opens an expanded dated-payment view.
- The High Level Dashboard uses exact transaction types and `POSTINGDATE` for every billing mode. All submissions includes `Billed`, `Re-billed claim`, and `Re-billed`; latest only ranks those posting dates across each ENCOUNTERID's complete submission history and keeps the newest family member; original only uses `Claim created` rows directly. The billed total, graph, hover detail, and selected-date billed claims follow that choice. Its payer dropdown is populated from the selected date range, displays distinct claim-family counts for every payer, supports multiple selections, and filters billing, remittance, recoupment, and denial results from the same cached range data. Deduplicated authoritative ClaimStatus/EDI payments remain grouped by remittance date. Related same-day remittances are first netted by claim/rebill reference and payer, so a reversal followed by a reduced replacement payment contributes only the actual difference. The resulting positive payments and negative recoupments are shown as separate graph lines, totals, hover values, and selected-date claim lists. Each billed, received, and recoupment graph line can be independently shown or hidden. Zero-paid remittance lines with adjustment reasons drive the denial rankings. Denied CPT rows expand to their claim references, using only the CPT amount from each encounter's latest billed/re-billed posting date; claim links open the Claims workspace in a new tab.
- Unsubmitted and No Response support the same preset, custom-day, and custom-date ranges as the Dashboard. Unsubmitted ranges use the appointment/service date; No Response ranges use the latest submission posting date. The Unsubmitted queue can also include every appointment, exclude appointments younger than 14 days, or apply a user-selected minimum age. These age switches filter the selected cached queue locally without another MySQL request.
- Dense chart dates use collision-aware axis labels. Every date band and event card supports hover, keyboard focus, and tap/click selection to reveal cumulative paid, the counted change, marker category, source, and full event details.
- Salesforce comments extend the same graph using category-colored markers/cards. Same-day comments retain their Salesforce timestamp order and are numbered in sequence.
- The chronological timeline is collapsed by default and expands from its accessible Claim Timeline control.
