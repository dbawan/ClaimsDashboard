import { useEffect, useMemo, useRef, useState } from "react";

const commentDateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

const calendarDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatCommentDate(value) {
  if (!value) return "Date unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value).slice(0, 10) : commentDateTime.format(parsed);
}

function formatDate(value) {
  if (!value) return "Date unavailable";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return String(value);
  return calendarDate.format(new Date(Date.UTC(year, month - 1, day)));
}

function formatMoney(value) {
  return value == null ? null : currency.format(Number(value));
}

function titleCase(value) {
  return String(value || "Not provided")
    .replaceAll("_", " ")
    .toLocaleLowerCase()
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function commentPreview(comment) {
  return comment.summary
    || comment.text
    || comment.action
    || comment.followUpAction
    || "Salesforce activity was recorded for this claim.";
}

function financialDetails(comment) {
  return [
    ["Paid", formatMoney(comment.paid)],
    ["Allowed", formatMoney(comment.allowed)],
    ["Amount", formatMoney(comment.amount)],
    ["Check / EFT", comment.checkEft],
    ["Issue date", comment.issueDate],
    ["Cleared date", comment.clearedDate],
    ["Posting issue", comment.paymentPostingIssue ? "Flagged" : null],
  ].filter(([, value]) => value != null && value !== "");
}

function commentCountLabel(integration, count) {
  if (count) return `${count} comment${count === 1 ? "" : "s"}`;
  if (integration?.status === "no_comments") return "No comments";
  if (["not_configured", "misconfigured"].includes(integration?.status)) return "Setup needed";
  if (integration?.status === "error") return "Unavailable";
  return "No comments";
}

function invoiceCountLabel(count) {
  return `${count} invoice${count === 1 ? "" : "s"}`;
}

function allocationCountLabel(allocations) {
  if (allocations.length === 1) {
    return allocations[0].status === "estimated_equal_pool" ? "1 pooled estimate" : "1 unresolved pool";
  }
  return `${allocations.length} review pools`;
}

function DockTab({ kind, label, countLabel, onOpen, tabRef }) {
  return (
    <button ref={tabRef} className="claim-dock-tab" type="button" onClick={onOpen} aria-expanded="false">
      <span className="claim-dock-tab-icon" aria-hidden="true">{kind === "invoices" ? "▤" : "•••"}</span>
      <span><strong>{label}</strong><small>{countLabel}</small></span>
      <i aria-hidden="true">⌃</i>
    </button>
  );
}

function PreviewShell({ kind, title, countLabel, onExpand, onCollapse, children, previewRef }) {
  return (
    <div className="claim-dock-preview">
      <button
        ref={previewRef}
        className="claim-dock-preview-main"
        type="button"
        onClick={onExpand}
        aria-expanded="false"
      >
        <span className="claim-dock-preview-icon" aria-hidden="true">{kind === "invoices" ? "▤" : "•••"}</span>
        <span className="claim-dock-preview-copy">
          <span className="claim-dock-preview-title"><span>{title}</span><strong>{countLabel}</strong></span>
          {children}
        </span>
        <span className="claim-dock-preview-open" aria-hidden="true">↗</span>
      </button>
      <button className="claim-dock-collapse" type="button" onClick={onCollapse} aria-label={`Collapse ${title}`}>⌄</button>
    </div>
  );
}

function CommentsPanel({ data, mode, inactive, onAdvance, onCollapse, closeRef, tabRef, previewRef }) {
  const comments = useMemo(() => [...(data.comments || [])].sort((left, right) => {
    const leftKey = left.createdAt || left.date || "";
    const rightKey = right.createdAt || right.date || "";
    return rightKey.localeCompare(leftKey) || Number(right.sequence || 0) - Number(left.sequence || 0);
  }), [data.comments]);
  const integration = data.commentIntegration || {};
  const countLabel = commentCountLabel(integration, comments.length);
  const caseStatus = data.claim?.salesforceStatus
    || comments.find((comment) => comment.caseStatus)?.caseStatus
    || "Status unavailable";

  return (
    <aside
      className={`claim-dock-panel claim-dock-panel-comments claim-dock-panel-${mode}`}
      role={mode === "expanded" ? "dialog" : "complementary"}
      aria-modal={mode === "expanded" ? "true" : undefined}
      aria-hidden={inactive || undefined}
      aria-label={mode === "expanded" ? undefined : "Salesforce comments"}
      aria-labelledby={mode === "expanded" ? "claim-comments-heading" : undefined}
    >
      {mode === "collapsed" ? (
        <DockTab
          kind="comments"
          label="Salesforce comments"
          countLabel={countLabel}
          onOpen={onAdvance}
          tabRef={tabRef}
        />
      ) : null}

      {mode === "preview" ? (
        <PreviewShell
          kind="comments"
          title="Salesforce comments"
          countLabel={countLabel}
          onExpand={onAdvance}
          onCollapse={onCollapse}
          previewRef={previewRef}
        >
          {comments.length ? comments.slice(0, 2).map((comment) => (
            <span className="claim-dock-preview-line" key={comment.commentId}>
              <small>{formatCommentDate(comment.createdAt || comment.date)}</small>
              <span>{commentPreview(comment)}</span>
            </span>
          )) : (
            <span className="claim-dock-preview-empty">
              {integration.message || "No Salesforce comments are attached to this claim."}
            </span>
          )}
        </PreviewShell>
      ) : null}

      {mode === "expanded" ? (
        <div className="claim-dock-expanded">
          <header className="claim-dock-header">
            <div>
              <p>Salesforce claim activity</p>
              <h2 id="claim-comments-heading">Comments for claim {data.claim?.claimId}</h2>
              <span className="claim-dock-status"><i aria-hidden="true" /> {caseStatus} · {countLabel}</span>
            </div>
            <button ref={closeRef} type="button" onClick={onCollapse} aria-label="Return to comment preview">×</button>
          </header>
          <div className="claim-dock-scroll">
            {integration.message ? (
              <div className={`claim-dock-integration claim-dock-integration-${integration.status || "unknown"}`}>
                <strong>Read-only Salesforce feed</strong>
                <span>{integration.message}</span>
              </div>
            ) : null}
            {comments.length ? (
              <ol className="claim-comments-list" aria-label="Salesforce comments, newest first">
                {comments.map((comment) => {
                  const details = financialDetails(comment);
                  return (
                    <li key={comment.commentId} className="claim-comment-card">
                      <div className="claim-comment-meta">
                        <time dateTime={comment.createdAt || comment.date || undefined}>{formatCommentDate(comment.createdAt || comment.date)}</time>
                        <span>{comment.categoryLabel || "Salesforce comment"}</span>
                      </div>
                      <div className="claim-comment-heading">
                        <strong>{comment.summary || comment.action || "Claim activity recorded"}</strong>
                        {comment.caseStatus ? <em>{comment.caseStatus}</em> : null}
                      </div>
                      {comment.text ? <p className="claim-comment-text">{comment.text}</p> : null}
                      {comment.action || comment.followUpAction ? (
                        <dl className="claim-comment-actions">
                          {comment.action ? <div><dt>Action</dt><dd>{comment.action}</dd></div> : null}
                          {comment.followUpAction ? <div><dt>Follow-up</dt><dd>{comment.followUpAction}</dd></div> : null}
                        </dl>
                      ) : null}
                      {details.length ? (
                        <dl className="claim-comment-financials">
                          {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
                        </dl>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            ) : <DockEmpty title={countLabel} message={integration.message} />}
          </div>
          <footer className="claim-dock-footer">
            <span><i aria-hidden="true" /> Query-only connection</span>
            <small>Newest activity first · Salesforce is never modified</small>
          </footer>
        </div>
      ) : null}
    </aside>
  );
}

function invoiceLineTitle(line) {
  return line.productName || line.description || line.procedureName || line.productNumber || "Invoice line";
}

function InvoiceCard({ invoice }) {
  return (
    <li className="claim-invoice-card">
      <div className="claim-invoice-meta">
        <time dateTime={invoice.dateOfService || undefined}>{formatDate(invoice.dateOfService)}</time>
        <span>{titleCase(invoice.vendor)}</span>
      </div>
      <div className="claim-invoice-heading">
        <div><small>Invoice</small><strong>{invoice.invoiceNumber || "Number unavailable"}</strong></div>
        <strong>{formatMoney(invoice.total) || "Total unavailable"}</strong>
      </div>
      <div className="claim-invoice-patient">
        <span>Patient</span><strong>{invoice.patientName || "Not provided"}</strong>
      </div>
      <ol className="claim-invoice-lines" aria-label={`Lines for invoice ${invoice.invoiceNumber || "without number"}`}>
        {invoice.lines.map((line) => {
          const facts = [
            ["RX", line.rx],
            ["Procedure", line.procedureName],
            ["Product", line.productNumber],
            ["Ordered", line.amount],
            ["Quantity", line.quantity == null ? null : `${line.quantity}${line.quantityType ? ` ${line.quantityType}` : ""}`],
            ["Used", line.quantityUsed],
            ["Price", formatMoney(line.price)],
            ["Extended", formatMoney(line.extendedPrice)],
            ["Tax", formatMoney(line.tax)],
            ["Batch", line.batchNumber],
            ["Injection", [line.injectionDate, line.injectionTime].filter(Boolean).join(" ")],
            ["Delivery", line.deliveryNumber],
            ["Batch expiry", line.batchExpiryDate],
            ["PO number", line.customerPoNumber],
            ["Reference invoice", line.referenceInvoiceNumber],
          ].filter(([, value]) => value != null && value !== "");
          return (
            <li key={line.id}>
              <div className="claim-invoice-line-heading">
                <strong>{invoiceLineTitle(line)}</strong>
                <span>{formatMoney(line.extendedPrice ?? line.price) || line.amount || "—"}</span>
              </div>
              {line.description && line.description !== invoiceLineTitle(line) ? <p>{line.description}</p> : null}
              {facts.length ? (
                <dl>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
              ) : null}
            </li>
          );
        })}
      </ol>
      {invoice.redactedPdfUrl ? (
        <a href={invoice.redactedPdfUrl} target="_blank" rel="noreferrer">Open redacted invoice PDF ↗</a>
      ) : null}
    </li>
  );
}

function InvoiceAllocationCard({ allocation }) {
  const estimated = allocation.status === "estimated_equal_pool";
  const candidateInvoices = allocation.candidateInvoiceNumbers || [];
  const candidateClaims = allocation.candidateClaimIds || [];
  return (
    <li className={`claim-invoice-allocation claim-invoice-allocation-${estimated ? "estimated" : "unresolved"}`}>
      <div className="claim-invoice-meta">
        <time dateTime={allocation.serviceDate || undefined}>{formatDate(allocation.serviceDate)}</time>
        <span>{estimated ? "Estimate only" : "Review required"}</span>
      </div>
      <div className="claim-invoice-allocation-heading">
        <div>
          <small>{estimated ? "Pooled invoice allocation" : "Unresolved invoice pool"}</small>
          <strong>{allocation.product || "Date-only candidates"}</strong>
        </div>
        <strong>{estimated ? formatMoney(allocation.estimatedAmount) : "Not allocated"}</strong>
      </div>
      <p>{allocation.reason}</p>
      <dl className="claim-invoice-allocation-facts">
        <div><dt>Candidate invoices</dt><dd>{allocation.invoiceCount}</dd></div>
        <div><dt>Candidate claims</dt><dd>{allocation.claimCount}</dd></div>
        <div><dt>Pool total</dt><dd>{formatMoney(allocation.poolTotal) || "Unknown"}</dd></div>
        <div><dt>Per-claim share</dt><dd>{estimated ? `${allocation.shareNumerator}/${allocation.shareDenominator}` : "Unresolved"}</dd></div>
      </dl>
      <div className="claim-invoice-allocation-candidates">
        <span>Invoice numbers</span><strong>{candidateInvoices.join(", ") || "Unavailable"}</strong>
        <span>Possible claims</span><strong>{candidateClaims.join(", ") || "Unavailable"}</strong>
      </div>
      <small className="claim-invoice-allocation-note">
        {estimated
          ? "This amount is an equal-pool estimate, not a confirmed invoice-to-claim assignment."
          : "No invoice amount has been assigned to this claim from this pool."}
      </small>
    </li>
  );
}

function DockEmpty({ title, message }) {
  return (
    <div className="claim-dock-empty">
      <span aria-hidden="true">•••</span>
      <strong>{title}</strong>
      <p>{message || "No matching records are available."}</p>
    </div>
  );
}

function InvoicesPanel({ data, mode, inactive, onAdvance, onCollapse, closeRef, tabRef, previewRef }) {
  const invoices = data.patientInvoices || [];
  const integration = data.invoiceIntegration || {};
  const allocations = integration.allocations || [];
  const allocationDates = new Set(allocations.map(({ serviceDate }) => serviceDate));
  const individuallyMatchedInvoices = invoices.filter((invoice) => !allocationDates.has(invoice.dateOfService));
  const countLabel = allocations.length && individuallyMatchedInvoices.length
    ? `${allocations.length + individuallyMatchedInvoices.length} invoice items`
    : allocations.length
      ? allocationCountLabel(allocations)
      : invoiceCountLabel(invoices.length);
  const previewInvoices = individuallyMatchedInvoices.slice(0, 2);
  const previewAllocations = allocations.slice(0, 2);
  const estimatedAllocation = allocations.find(({ status }) => status === "estimated_equal_pool");
  const usedCptFallback = integration.matchMethod === "service_date_and_cpt";
  const usedDateOnlyFallback = integration.matchMethod === "service_date_only";
  const invoiceMatchHeading = estimatedAllocation
    ? "Estimated pooled invoice allocation"
    : integration.isAmbiguous
      ? usedCptFallback
        ? "Review required · ambiguous CPT invoice pool"
        : "Review required · ambiguous date-only match"
    : usedDateOnlyFallback
      ? "Date-only fallback"
      : usedCptFallback
        ? "Service date + mapped CPT fallback"
        : "Exact patient + service-date match";

  return (
    <aside
      className={`claim-dock-panel claim-dock-panel-invoices claim-dock-panel-${mode}`}
      role={mode === "expanded" ? "dialog" : "complementary"}
      aria-modal={mode === "expanded" ? "true" : undefined}
      aria-hidden={inactive || undefined}
      aria-label={mode === "expanded" ? undefined : "Patient invoices"}
      aria-labelledby={mode === "expanded" ? "claim-invoices-heading" : undefined}
    >
      {mode === "collapsed" ? (
        <DockTab
          kind="invoices"
          label="Patient invoices"
          countLabel={countLabel}
          onOpen={onAdvance}
          tabRef={tabRef}
        />
      ) : null}

      {mode === "preview" ? (
        <PreviewShell
          kind="invoices"
          title="Patient invoices"
          countLabel={countLabel}
          onExpand={onAdvance}
          onCollapse={onCollapse}
          previewRef={previewRef}
        >
          {estimatedAllocation ? (
            <span className="claim-dock-preview-warning">
              ≈ {estimatedAllocation.shareNumerator}/{estimatedAllocation.shareDenominator} equal-pool estimate · not confirmed
            </span>
          ) : integration.isAmbiguous ? (
            <span className="claim-dock-preview-warning">⚑ Multiple claims share this invoice pool</span>
          ) : null}
          {previewAllocations.length ? previewAllocations.map((allocation) => (
            <span className="claim-dock-preview-line" key={allocation.id}>
              <small>{formatDate(allocation.serviceDate)}</small>
              <span>{allocation.product || "Unresolved invoice pool"} · {allocation.invoiceCount} invoices / {allocation.claimCount} claims</span>
              <strong>{formatMoney(allocation.estimatedAmount) || "Review"}</strong>
            </span>
          )) : previewInvoices.length ? previewInvoices.map((invoice) => (
            <span className="claim-dock-preview-line" key={invoice.id}>
              <small>{formatDate(invoice.dateOfService)}</small>
              <span>#{invoice.invoiceNumber || "—"} · {invoice.lines[0] ? invoiceLineTitle(invoice.lines[0]) : titleCase(invoice.vendor)}</span>
              <strong>{formatMoney(invoice.total) || "—"}</strong>
            </span>
          )) : (
            <span className="claim-dock-preview-empty">
              {integration.message || "No exact patient and service-date invoice match was found."}
            </span>
          )}
        </PreviewShell>
      ) : null}

      {mode === "expanded" ? (
        <div className="claim-dock-expanded">
          <header className="claim-dock-header">
            <div>
              <p>{invoiceMatchHeading}</p>
              <h2 id="claim-invoices-heading">Invoices for claim {data.claim?.claimId}</h2>
              <span className="claim-dock-status"><i aria-hidden="true" /> {data.claim?.patientName} · {countLabel}</span>
            </div>
            <button ref={closeRef} type="button" onClick={onCollapse} aria-label="Return to invoice preview">×</button>
          </header>
          <div className="claim-dock-scroll">
            <div className={`claim-dock-integration claim-dock-integration-${integration.status || "unknown"}`}>
              <strong>{integration.isAmbiguous ? "Review required" : "Read-only invoice feed"}</strong>
              <span>{integration.message || integration.matchRule || "Invoice matching completed."}</span>
            </div>
            {allocations.length || individuallyMatchedInvoices.length ? (
              <ol className="claim-invoice-list claim-invoice-allocation-list" aria-label="Pooled invoice reconciliation estimates">
                {allocations.map((allocation) => <InvoiceAllocationCard allocation={allocation} key={allocation.id} />)}
                {individuallyMatchedInvoices.map((invoice) => <InvoiceCard invoice={invoice} key={invoice.id} />)}
              </ol>
            ) : <DockEmpty title={countLabel} message={integration.message} />}
          </div>
          <footer className="claim-dock-footer">
            <span><i aria-hidden="true" /> SELECT-only connection</span>
            <small>{integration.matchRule || "Exact patient name + date of service"}</small>
          </footer>
        </div>
      ) : null}
    </aside>
  );
}

export function ClaimBottomDock({ data }) {
  const [modes, setModes] = useState({ invoices: "collapsed", comments: "collapsed" });
  const layerRef = useRef(null);
  const commentsTabRef = useRef(null);
  const commentsPreviewRef = useRef(null);
  const invoicesTabRef = useRef(null);
  const invoicesPreviewRef = useRef(null);
  const expandedCloseRef = useRef(null);
  const expandedPanel = Object.entries(modes).find(([, mode]) => mode === "expanded")?.[0] || null;
  const previewPanel = Object.entries(modes).find(([, mode]) => mode === "preview")?.[0] || null;

  useEffect(() => {
    setModes({ invoices: "collapsed", comments: "collapsed" });
  }, [data.claim?.claimId]);

  useEffect(() => {
    if (!expandedPanel) return undefined;
    window.requestAnimationFrame(() => expandedCloseRef.current?.focus());

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        setModes((current) => ({ ...current, [expandedPanel]: "preview" }));
        window.requestAnimationFrame(() => {
          (expandedPanel === "comments" ? commentsPreviewRef : invoicesPreviewRef).current?.focus();
        });
        return;
      }
      if (event.key !== "Tab") return;
      const panel = layerRef.current?.querySelector(".claim-dock-panel-expanded");
      const focusable = [...(panel?.querySelectorAll("button, [href], [tabindex]:not([tabindex='-1'])") || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [expandedPanel]);

  function setPanelMode(panel, mode) {
    setModes({
      invoices: panel === "invoices" ? mode : "collapsed",
      comments: panel === "comments" ? mode : "collapsed",
    });
  }

  function advance(panel) {
    setPanelMode(panel, modes[panel] === "collapsed" ? "preview" : "expanded");
  }

  function collapse(panel) {
    const nextMode = modes[panel] === "expanded" ? "preview" : "collapsed";
    setPanelMode(panel, nextMode);
    window.requestAnimationFrame(() => {
      const reference = nextMode === "preview"
        ? panel === "comments" ? commentsPreviewRef : invoicesPreviewRef
        : panel === "comments" ? commentsTabRef : invoicesTabRef;
      reference.current?.focus();
    });
  }

  return (
    <div
      ref={layerRef}
      className={`claim-dock-layer${expandedPanel ? ` claim-dock-has-expanded claim-dock-active-${expandedPanel}` : ""}${previewPanel ? ` claim-dock-has-preview claim-dock-active-${previewPanel}` : ""}`}
    >
      <button
        className="claim-dock-backdrop"
        type="button"
        aria-label={`Return to ${expandedPanel || "claim activity"} preview`}
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => expandedPanel && collapse(expandedPanel)}
      />
      <InvoicesPanel
        data={data}
        mode={modes.invoices}
        inactive={Boolean(expandedPanel && expandedPanel !== "invoices")}
        onAdvance={() => advance("invoices")}
        onCollapse={() => collapse("invoices")}
        closeRef={expandedPanel === "invoices" ? expandedCloseRef : undefined}
        tabRef={invoicesTabRef}
        previewRef={invoicesPreviewRef}
      />
      <CommentsPanel
        data={data}
        mode={modes.comments}
        inactive={Boolean(expandedPanel && expandedPanel !== "comments")}
        onAdvance={() => advance("comments")}
        onCollapse={() => collapse("comments")}
        closeRef={expandedPanel === "comments" ? expandedCloseRef : undefined}
        tabRef={commentsTabRef}
        previewRef={commentsPreviewRef}
      />
    </div>
  );
}
