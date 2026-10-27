import { useEffect, useId, useMemo, useRef, useState } from "react";
import { fetchClaimsForPatient, fetchPatientSuggestions } from "./api.js";
import {
  filterAndSortPatientClaims,
  patientClaimDateRange,
} from "./patientClaimListModel.js";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.25 4.25" />
    </svg>
  );
}

function formatDate(value) {
  if (!value) return "Date unavailable";
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function formatCurrency(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? currencyFormatter.format(amount) : "—";
}

function patientMeta(patient) {
  return [
    patient.dateOfBirth ? `DOB ${formatDate(patient.dateOfBirth)}` : null,
    patient.chartNumber ? `Chart ${patient.chartNumber}` : null,
    patient.inactive ? "Inactive patient" : null,
  ].filter(Boolean).join(" · ") || "Patient record";
}

export function ClaimSearchForm({
  value,
  onChange,
  onSubmit,
  onClaimSelect,
  loading,
  error,
  canViewFinancials = false,
}) {
  const inputId = useId();
  const suggestionsId = `${inputId}-patient-suggestions`;
  const errorId = `${inputId}-error`;
  const customDateErrorId = `${inputId}-custom-date-error`;
  const formRef = useRef(null);
  const suggestionRequestRef = useRef(null);
  const claimRequestRef = useRef(null);
  const pageRequestRef = useRef(null);
  const loadMoreRef = useRef(null);
  const [mode, setMode] = useState("claim");
  const [patientQuery, setPatientQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionsHaveMore, setSuggestionsHaveMore] = useState(false);
  const [suggestionStatus, setSuggestionStatus] = useState("idle");
  const [patientError, setPatientError] = useState("");
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [patientClaims, setPatientClaims] = useState(null);
  const [claimsStatus, setClaimsStatus] = useState("idle");
  const [pageStatus, setPageStatus] = useState("idle");
  const [pageError, setPageError] = useState("");
  const [procedureQuery, setProcedureQuery] = useState("");
  const [appliedProcedureQuery, setAppliedProcedureQuery] = useState("");
  const [dateRange, setDateRange] = useState("30");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const defaultDateRange = useMemo(() => patientClaimDateRange("30"), []);
  const activeDateRange = useMemo(() => patientClaimDateRange(dateRange, {
    customStartDate,
    customEndDate,
    referenceDate: defaultDateRange.endDate,
  }), [dateRange, customStartDate, customEndDate, defaultDateRange.endDate]);
  const customDateError = dateRange !== "custom"
    ? ""
    : !customStartDate || !customEndDate
      ? "Choose both a From and To date."
      : customStartDate > customEndDate
        ? "The From date must be on or before the To date."
        : "";

  const financialAccess = Boolean(
    canViewFinancials && patientClaims?.access?.paymentsAndEra,
  );
  const normalizedProcedureQuery = appliedProcedureQuery.trim().toUpperCase();
  const filterPending = procedureQuery !== appliedProcedureQuery;
  const filtersLoading = !customDateError && (claimsStatus === "loading" || filterPending);
  const sortedClaims = useMemo(() => filterAndSortPatientClaims(
    patientClaims?.claims,
    {
      procedureQuery: appliedProcedureQuery,
      startDate: activeDateRange.startDate,
      endDate: activeDateRange.endDate,
    },
  ), [patientClaims, appliedProcedureQuery, activeDateRange.startDate, activeDateRange.endDate]);

  async function loadSuggestions(query) {
    suggestionRequestRef.current?.abort();
    const controller = new AbortController();
    suggestionRequestRef.current = controller;
    setSuggestionStatus("loading");
    setPatientError("");
    setPanelOpen(true);
    try {
      const result = await fetchPatientSuggestions(query, { signal: controller.signal });
      setSuggestions(result.patients || []);
      setSuggestionsHaveMore(Boolean(result.hasMore));
      setActiveSuggestion(-1);
      setSuggestionStatus("ready");
    } catch (nextError) {
      if (nextError.name !== "AbortError") {
        setSuggestions([]);
        setSuggestionsHaveMore(false);
        setSuggestionStatus("error");
        setPatientError(nextError.message);
      }
    }
  }

  useEffect(() => {
    if (mode !== "patient" || selectedPatient) return undefined;
    const query = patientQuery.trim();
    if ((query.match(/[\p{L}\p{N}]/gu) || []).length < 2) {
      suggestionRequestRef.current?.abort();
      setSuggestions([]);
      setSuggestionsHaveMore(false);
      setSuggestionStatus("idle");
      return undefined;
    }
    const timeout = window.setTimeout(() => void loadSuggestions(query), 250);
    return () => window.clearTimeout(timeout);
  }, [mode, patientQuery, selectedPatient]);

  useEffect(() => () => {
    suggestionRequestRef.current?.abort();
    claimRequestRef.current?.abort();
    pageRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    if (procedureQuery === appliedProcedureQuery) return undefined;
    const timeout = window.setTimeout(() => {
      setClaimsStatus("loading");
      setAppliedProcedureQuery(procedureQuery);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [procedureQuery, appliedProcedureQuery]);

  useEffect(() => {
    if (mode !== "patient" || !selectedPatient || customDateError) return undefined;
    claimRequestRef.current?.abort();
    pageRequestRef.current?.abort();
    pageRequestRef.current = null;
    const controller = new AbortController();
    claimRequestRef.current = controller;
    setClaimsStatus("loading");
    setPageStatus("idle");
    setPageError("");
    setPatientError("");
    void fetchClaimsForPatient(selectedPatient.patientId, {
      startDate: activeDateRange.startDate,
      endDate: activeDateRange.endDate,
      procedureQuery: appliedProcedureQuery,
      signal: controller.signal,
    }).then((result) => {
      if (claimRequestRef.current !== controller) return;
      setPatientClaims(result);
      setClaimsStatus("ready");
    }).catch((nextError) => {
      if (nextError.name === "AbortError" || claimRequestRef.current !== controller) return;
      setClaimsStatus("error");
      setPatientError(nextError.message);
    });
    return () => controller.abort();
  }, [
    mode,
    selectedPatient,
    activeDateRange.startDate,
    activeDateRange.endDate,
    customDateError,
    appliedProcedureQuery,
  ]);

  async function loadMoreClaims() {
    if (
      mode !== "patient"
      || claimsStatus !== "ready"
      || !patientClaims?.hasMore
      || !Number.isSafeInteger(patientClaims.nextOffset)
      || pageRequestRef.current
    ) return;

    const controller = new AbortController();
    pageRequestRef.current = controller;
    setPageStatus("loading");
    setPageError("");
    try {
      const nextPage = await fetchClaimsForPatient(selectedPatient.patientId, {
        startDate: activeDateRange.startDate,
        endDate: activeDateRange.endDate,
        offset: patientClaims.nextOffset,
        procedureQuery: appliedProcedureQuery,
        signal: controller.signal,
      });
      if (pageRequestRef.current !== controller) return;
      setPatientClaims((current) => {
        if (!current) return current;
        const existingIds = new Set(current.claims.map(({ claimId }) => claimId));
        const additionalClaims = nextPage.claims.filter(({ claimId }) => !existingIds.has(claimId));
        return {
          ...current,
          total: nextPage.total,
          hasMore: nextPage.hasMore,
          nextOffset: nextPage.nextOffset,
          claims: [...current.claims, ...additionalClaims],
        };
      });
      setPageStatus("idle");
    } catch (nextError) {
      if (nextError.name !== "AbortError" && pageRequestRef.current === controller) {
        setPageStatus("error");
        setPageError(nextError.message);
      }
    } finally {
      if (pageRequestRef.current === controller) pageRequestRef.current = null;
    }
  }

  useEffect(() => {
    const target = loadMoreRef.current;
    if (
      !target
      || !patientClaims?.hasMore
      || claimsStatus !== "ready"
      || pageStatus === "error"
      || typeof window.IntersectionObserver !== "function"
    ) return undefined;

    const observer = new window.IntersectionObserver((entries) => {
      if (entries.some(({ isIntersecting }) => isIntersecting)) void loadMoreClaims();
    }, {
      root: target.closest(".patient-claim-list"),
      rootMargin: "120px 0px",
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [patientClaims, claimsStatus, pageStatus]);

  function selectPatient(patient) {
    suggestionRequestRef.current?.abort();
    claimRequestRef.current?.abort();
    setSelectedPatient(patient);
    setPatientQuery(patient.name);
    setSuggestions([]);
    setPatientClaims(null);
    setPatientError("");
    setClaimsStatus("loading");
    setPageStatus("idle");
    setPageError("");
    setPanelOpen(true);
    setProcedureQuery("");
    setAppliedProcedureQuery("");
    setDateRange("30");
    setCustomStartDate("");
    setCustomEndDate("");
  }

  function clearPatientSelection({ clearQuery = false } = {}) {
    claimRequestRef.current?.abort();
    pageRequestRef.current?.abort();
    pageRequestRef.current = null;
    setSelectedPatient(null);
    setPatientClaims(null);
    setClaimsStatus("idle");
    setPageStatus("idle");
    setPageError("");
    setProcedureQuery("");
    setAppliedProcedureQuery("");
    setDateRange("30");
    setCustomStartDate("");
    setCustomEndDate("");
    setPatientError("");
    setPanelOpen(Boolean(clearQuery));
    if (clearQuery) {
      setPatientQuery("");
      setSuggestions([]);
      setSuggestionStatus("idle");
    }
  }

  function updateDateRange(nextRange) {
    if (nextRange === "custom" && (!customStartDate || !customEndDate)) {
      setCustomStartDate(activeDateRange.startDate || defaultDateRange.startDate);
      setCustomEndDate(activeDateRange.endDate || defaultDateRange.endDate);
    }
    setClaimsStatus("loading");
    setDateRange(nextRange);
    setPatientError("");
  }

  function updateMode(nextMode) {
    suggestionRequestRef.current?.abort();
    claimRequestRef.current?.abort();
    pageRequestRef.current?.abort();
    pageRequestRef.current = null;
    setMode(nextMode);
    setPatientError("");
    setPanelOpen(nextMode === "patient" && Boolean(selectedPatient || suggestions.length));
  }

  function updatePatientQuery(nextValue) {
    if (selectedPatient) clearPatientSelection();
    setPatientQuery(nextValue);
    setPatientError("");
    setPanelOpen(true);
  }

  function handleSubmit(event) {
    if (mode === "claim") {
      onSubmit(event);
      return;
    }
    event.preventDefault();
    if (activeSuggestion >= 0 && suggestions[activeSuggestion]) {
      void selectPatient(suggestions[activeSuggestion]);
      return;
    }
    const query = patientQuery.trim();
    if ((query.match(/[\p{L}\p{N}]/gu) || []).length < 2) {
      setPatientError("Enter at least two letters of the patient's name.");
      setPanelOpen(true);
      return;
    }
    if (!selectedPatient) void loadSuggestions(query);
  }

  function handlePatientKeyDown(event) {
    if (!suggestions.length || selectedPatient) {
      if (event.key === "Escape") setPanelOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion((current) => (current + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
    } else if (event.key === "Escape") {
      setPanelOpen(false);
      setActiveSuggestion(-1);
    }
  }

  function chooseClaim(claimId) {
    onClaimSelect(String(claimId || "").trim());
    setPanelOpen(false);
  }

  const patientBusy = suggestionStatus === "loading" || claimsStatus === "loading";
  const visibleError = mode === "claim" ? error : patientError;
  const showPatientPanel = mode === "patient" && panelOpen && (
    selectedPatient
    || suggestionStatus !== "idle"
    || Boolean(patientError)
  );

  return (
    <form
      ref={formRef}
      className={`claim-search-bar claim-search-bar-${mode}`}
      onSubmit={handleSubmit}
      onBlur={(event) => {
        if (formRef.current?.contains(event.relatedTarget)) return;
        window.requestAnimationFrame(() => {
          if (!formRef.current?.contains(document.activeElement)) setPanelOpen(false);
        });
      }}
      noValidate
    >
      <div className="claim-search-mode">
        <label htmlFor={`${inputId}-mode`}>Search by</label>
        <select
          id={`${inputId}-mode`}
          value={mode}
          disabled={loading}
          onChange={(event) => updateMode(event.target.value)}
        >
          <option value="claim">Claim ID</option>
          <option value="patient">Patient name</option>
        </select>
      </div>

      <div className={`compact-search-field ${visibleError ? "input-error" : ""}`}>
        <label htmlFor={inputId}>{mode === "claim" ? "Claim ID" : "Patient name"}</label>
        <SearchIcon />
        <input
          id={inputId}
          name={mode === "claim" ? "claimId" : "patientName"}
          type="search"
          value={mode === "claim" ? value : patientQuery}
          onChange={(event) => (
            mode === "claim" ? onChange(event.target.value) : updatePatientQuery(event.target.value)
          )}
          onKeyDown={mode === "patient" ? handlePatientKeyDown : undefined}
          onFocus={() => {
            if (mode === "patient" && (selectedPatient || suggestions.length || patientError)) {
              setPanelOpen(true);
            }
          }}
          placeholder={mode === "claim"
            ? "Search claim ID, payer claim, or ERA reference"
            : "Start typing a patient's first or last name"}
          autoComplete="off"
          spellCheck="false"
          maxLength="80"
          aria-invalid={Boolean(visibleError)}
          aria-describedby={visibleError ? errorId : undefined}
          role={mode === "patient" ? "combobox" : undefined}
          aria-autocomplete={mode === "patient" ? "list" : undefined}
          aria-controls={mode === "patient" ? suggestionsId : undefined}
          aria-expanded={mode === "patient" ? showPatientPanel : undefined}
          aria-activedescendant={mode === "patient" && activeSuggestion >= 0
            ? `${suggestionsId}-${activeSuggestion}`
            : undefined}
          disabled={loading}
        />
        {visibleError ? <span id={errorId} className="field-error">{visibleError}</span> : null}
      </div>

      <button
        className="primary-button search-button"
        type="submit"
        aria-label={mode === "claim" ? "Find claim" : "Find patient"}
        disabled={loading || (mode === "patient" && patientBusy)}
      >
        {loading || (mode === "patient" && patientBusy)
          ? <span className="button-loading-mark" aria-hidden="true" />
          : <SearchIcon />}
        <span>{loading || (mode === "patient" && patientBusy)
          ? "Searching"
          : mode === "claim" ? "Find claim" : "Find patient"}</span>
      </button>

      <details className="lookup-help">
        <summary aria-label="Open lookup tips">?</summary>
        <div className="lookup-help-popover">
          <strong>Lookup tips</strong>
          <p>
            Search by claim reference, or choose Patient name and select an exact patient from
            the recommendation list. Patient matches require at least two letters.
          </p>
        </div>
      </details>

      {showPatientPanel ? (
        <section className="patient-name-search-panel" aria-label="Patient claim search results">
          {!selectedPatient ? (
            <div className="patient-suggestion-section">
              <header>
                <div>
                  <span>Patient recommendations</span>
                  <strong>{suggestionStatus === "loading" ? "Searching patient records…" : "Select an exact patient"}</strong>
                </div>
                <button type="button" onClick={() => setPanelOpen(false)} aria-label="Close patient recommendations">×</button>
              </header>
              {suggestionStatus === "ready" && suggestions.length ? (
                <div id={suggestionsId} className="patient-suggestion-list" role="listbox">
                  {suggestions.map((patient, index) => (
                    <button
                      id={`${suggestionsId}-${index}`}
                      className={index === activeSuggestion ? "patient-suggestion-active" : ""}
                      type="button"
                      role="option"
                      aria-selected={index === activeSuggestion}
                      key={patient.patientId}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectPatient(patient)}
                    >
                      <span className="patient-suggestion-avatar" aria-hidden="true">
                        {patient.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <strong>{patient.name}</strong>
                        <small>{patientMeta(patient)}</small>
                      </span>
                      <em>Select</em>
                    </button>
                  ))}
                </div>
              ) : null}
              {suggestionStatus === "ready" && !suggestions.length ? (
                <p className="patient-search-state">No matching patients were found. Try more of the first or last name.</p>
              ) : null}
              {suggestionsHaveMore ? (
                <p className="patient-search-note">More matches exist. Type more of the name to narrow the recommendations.</p>
              ) : null}
              {patientError ? <p className="patient-search-state patient-search-error" role="alert">{patientError}</p> : null}
            </div>
          ) : (
            <div className="patient-claim-section">
              <header className="patient-claim-header">
                <div>
                  <span>Selected patient</span>
                  <strong>{selectedPatient.name}</strong>
                  <small>{patientMeta(selectedPatient)}</small>
                </div>
                <div className="patient-claim-header-actions">
                  <button type="button" onClick={() => clearPatientSelection({ clearQuery: true })}>Change patient</button>
                  <button type="button" onClick={() => setPanelOpen(false)} aria-label="Close patient claims">×</button>
                </div>
              </header>

              {patientClaims || ["loading", "error"].includes(claimsStatus) ? (
                <>
                  <div className="patient-claim-controls">
                    <p>
                      {filtersLoading || !patientClaims ? (
                        <><strong aria-hidden="true">…</strong> Loading claims</>
                      ) : (
                        <>
                          <strong>{patientClaims.claims.length.toLocaleString("en-US")}</strong>
                          {normalizedProcedureQuery
                            ? patientClaims.hasMore
                              ? ` of ${patientClaims.total.toLocaleString("en-US")} matching claims loaded`
                              : ` matching claim${patientClaims.total === 1 ? "" : "s"}`
                            : patientClaims.hasMore
                              ? ` of ${patientClaims.total.toLocaleString("en-US")} claims loaded`
                              : ` claim${patientClaims.total === 1 ? "" : "s"}`}
                        </>
                      )}
                    </p>
                    <div className="patient-claim-filter-stack">
                      <div className="patient-claim-filters">
                        <label>
                          Search CPT / HCPCS
                          <input
                            type="search"
                            value={procedureQuery}
                            placeholder="Type a code"
                            autoComplete="off"
                            autoCapitalize="characters"
                            spellCheck="false"
                            maxLength="20"
                            onChange={(event) => {
                              pageRequestRef.current?.abort();
                              pageRequestRef.current = null;
                              setPageStatus("idle");
                              setPageError("");
                              setProcedureQuery(event.target.value.toUpperCase());
                            }}
                          />
                        </label>
                        <label>
                          Date of service
                          <select value={dateRange} onChange={(event) => updateDateRange(event.target.value)}>
                            <option value="30">Past 30 days</option>
                            <option value="90">Past 90 days</option>
                            <option value="custom">Custom date range</option>
                          </select>
                        </label>
                      </div>
                      {dateRange === "custom" ? (
                        <div className="patient-claim-custom-range">
                          <label>
                            From
                            <input
                              type="date"
                              value={customStartDate}
                              max={customEndDate || defaultDateRange.endDate}
                              aria-invalid={Boolean(customDateError)}
                              aria-describedby={customDateError ? customDateErrorId : undefined}
                              onChange={(event) => {
                                setClaimsStatus("loading");
                                setCustomStartDate(event.target.value);
                              }}
                            />
                          </label>
                          <label>
                            To
                            <input
                              type="date"
                              value={customEndDate}
                              min={customStartDate || undefined}
                              max={defaultDateRange.endDate}
                              aria-invalid={Boolean(customDateError)}
                              aria-describedby={customDateError ? customDateErrorId : undefined}
                              onChange={(event) => {
                                setClaimsStatus("loading");
                                setCustomEndDate(event.target.value);
                              }}
                            />
                          </label>
                          {customDateError ? (
                            <small id={customDateErrorId} role="alert">{customDateError}</small>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {customDateError ? (
                    <p className="patient-search-state patient-search-error" role="alert">{customDateError}</p>
                  ) : filtersLoading ? (
                    <div className="patient-claim-filter-loading" role="status" aria-live="polite">
                      <span aria-hidden="true" />
                      <strong>Loading filtered claims…</strong>
                      <p>Checking the selected CPT / HCPCS and date-of-service range.</p>
                    </div>
                  ) : claimsStatus === "error" ? (
                    <p className="patient-search-state patient-search-error" role="alert">{patientError}</p>
                  ) : patientClaims && (sortedClaims.length || patientClaims.hasMore) ? (
                    <div
                      className="patient-claim-list"
                      onScroll={(event) => {
                        const list = event.currentTarget;
                        if (list.scrollHeight - list.scrollTop - list.clientHeight < 140) {
                          void loadMoreClaims();
                        }
                      }}
                    >
                      {sortedClaims.map((claim) => (
                        <button
                          type="button"
                          key={claim.claimId}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => chooseClaim(claim.claimId)}
                        >
                          <span className="patient-claim-main">
                            <span>
                              <strong>Claim {claim.claimId}</strong>
                              <small>{formatDate(claim.serviceDate)} · {claim.status}</small>
                            </span>
                            <em>Open claim</em>
                          </span>
                          <span className="patient-claim-details">
                            <span><small>Payer</small><strong>{claim.payer || "Not provided"}</strong></span>
                            <span><small>Procedures</small><strong>{claim.procedureCodes?.join(", ") || "—"}</strong></span>
                            {financialAccess ? (
                              <span>
                                <small>Latest charge · {claim.paidThresholdPercent || 50}% posted</small>
                                <strong title={claim.daysToPaid != null
                                  ? `Reached on ${formatDate(claim.paidThresholdDate)}`
                                  : "Posting threshold not reached"}
                                >
                                  {formatCurrency(claim.latestCharge)} · {claim.daysToPaid != null ? `Posted in ${claim.daysToPaid}d` : "Not reached"}
                                </strong>
                              </span>
                            ) : null}
                            {financialAccess ? <span><small>Posted payment</small><strong>{formatCurrency(claim.paid)}</strong><small>Received {formatCurrency(claim.received)}</small></span> : null}
                          </span>
                        </button>
                      ))}
                      {patientClaims.hasMore ? (
                        <div
                          ref={loadMoreRef}
                          className={`patient-claim-load-more patient-claim-load-more-${pageStatus}`}
                          aria-live="polite"
                        >
                          {pageStatus === "loading" ? (
                            <span>Loading more claims…</span>
                          ) : pageStatus === "error" ? (
                            <>
                              <span>{pageError || "More claims could not be loaded."}</span>
                              <button type="button" onClick={() => void loadMoreClaims()}>Try again</button>
                            </>
                          ) : (
                            <span>Scroll to load more claims</span>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : patientClaims ? (
                    <p className="patient-search-state">
                      {!normalizedProcedureQuery
                        ? "No claims for this patient fall within the selected date-of-service range."
                        : `No claims match procedure code ${normalizedProcedureQuery} within the selected date-of-service range.`}
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
    </form>
  );
}
