import { useId } from "react";

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.25 4.25" />
    </svg>
  );
}

export function ClaimSearchForm({ value, onChange, onSubmit, loading, error }) {
  const inputId = useId();
  const errorId = `${inputId}-error`;

  return (
    <form className="claim-search-bar" onSubmit={onSubmit} noValidate>
      <div className={`compact-search-field ${error ? "input-error" : ""}`}>
        <label htmlFor={inputId}>Claim ID</label>
        <SearchIcon />
        <input
          id={inputId}
          name="claimId"
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search claim ID, payer claim, or ERA reference"
          autoComplete="off"
          spellCheck="false"
          maxLength="80"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          disabled={loading}
        />
        {error ? <span id={errorId} className="field-error">{error}</span> : null}
      </div>

      <button className="primary-button search-button" type="submit" disabled={loading}>
        {loading ? <span className="button-loading-mark" aria-hidden="true" /> : <SearchIcon />}
        <span>{loading ? "Searching" : "Find claim"}</span>
      </button>

      <details className="lookup-help">
        <summary aria-label="Open claim lookup tips">?</summary>
        <div className="lookup-help-popover">
          <strong>Lookup tips</strong>
          <p>
            Search an ENCOUNTERID, Claim835ID, payer claim number, or suffixed ERA reference.
            Results reconcile three read-only sources.
          </p>
        </div>
      </details>
    </form>
  );
}
