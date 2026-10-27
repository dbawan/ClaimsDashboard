import { useEffect, useState } from "react";
import {
  fetchClaimWorklists,
  saveClaimWorklistChecks,
} from "./api.js";

const completionDateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
  timeZoneName: "short",
});

function formatCompletion(value) {
  if (!value) return "Completion time unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : completionDateTime.format(parsed);
}

function itemCompletion(worklist, itemId) {
  const completion = worklist?.completionDetails?.[itemId];
  if (!completion) return null;
  return {
    name: completion.completedBy?.name || "Authenticated user",
    at: formatCompletion(completion.completedAt),
    timestamp: new Date(completion.completedAt || 0).getTime() || 0,
  };
}

function WorklistAccordion({ worklist, saving, onToggleItem }) {
  const completedCount = worklist.checkedItemIds?.length || 0;
  const totalCount = worklist.type?.checkboxes?.length || 0;
  const isComplete = totalCount > 0 && completedCount === totalCount;
  const latestCompletion = isComplete
    ? worklist.type.checkboxes
      .map(({ id }) => itemCompletion(worklist, id))
      .filter(Boolean)
      .sort((left, right) => right.timestamp - left.timestamp)[0] || null
    : null;

  return (
    <details className="claim-worklist-accordion">
      <summary>
        <span>
          <small>{isComplete ? "Completed problem" : "Active problem"}</small>
          <strong>{worklist.type.name}</strong>
        </span>
        <b>{completedCount}/{totalCount}</b>
      </summary>
      <div className="claim-worklist-accordion-body">
        {worklist.note ? (
          <div className="claim-worklist-note">
            <strong>Diagnosis note</strong>
            <p>{worklist.note}</p>
          </div>
        ) : null}

        <ul>
          {worklist.type.checkboxes.map((item) => {
            const checked = worklist.checkedItemIds.includes(item.id);
            const completion = checked ? itemCompletion(worklist, item.id) : null;
            return (
              <li className={checked ? "claim-worklist-item-complete" : ""} key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={saving}
                    onChange={() => onToggleItem(worklist, item.id)}
                  />
                  <span>
                    <b>{item.label}</b>
                    {completion ? <small>Completed by {completion.name} · {completion.at}</small> : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        {saving ? <small className="claim-worklist-saving">Saving Problem List…</small> : null}
        {isComplete ? (
          <div className="claim-worklist-complete" role="status">
            <strong>Problem completed</strong>
            {latestCompletion ? <span>Finished by {latestCompletion.name} · {latestCompletion.at}</span> : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function ClaimWorklistPanel({
  data,
  mode,
  inactive,
  onOpen,
  onCollapse,
  closeRef,
  tabRef,
}) {
  const claimId = data.claim?.claimId;
  const [worklists, setWorklists] = useState([]);
  const [loadVersion, setLoadVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [savingTypeId, setSavingTypeId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setWorklists([]);
    setError("");
    setNotice("");
  }, [claimId]);

  useEffect(() => {
    if (mode !== "expanded" || !claimId) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setNotice("");
    void fetchClaimWorklists(claimId, { signal: controller.signal })
      .then(setWorklists)
      .catch((nextError) => {
        if (nextError.name !== "AbortError") setError(nextError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mode, claimId, loadVersion]);

  async function toggleItem(worklist, itemId) {
    const typeId = String(worklist.type.id);
    if (savingTypeId) return;
    const checked = new Set(worklist.checkedItemIds || []);
    if (checked.has(itemId)) checked.delete(itemId);
    else checked.add(itemId);
    const checkedItemIds = worklist.type.checkboxes
      .map(({ id }) => id)
      .filter((id) => checked.has(id));
    const optimistic = { ...worklist, checkedItemIds };
    setWorklists((current) => current.map((item) => String(item.type.id) === typeId ? optimistic : item));
    setSavingTypeId(typeId);
    setError("");
    setNotice("");
    try {
      const updated = await saveClaimWorklistChecks(claimId, worklist.type.id, checkedItemIds);
      setWorklists((current) => current.map((item) => String(item.type.id) === typeId ? updated : item));
      setNotice(`${updated.type.name} saved.`);
    } catch (nextError) {
      setWorklists((current) => current.map((item) => String(item.type.id) === typeId ? worklist : item));
      setError(nextError.message);
    } finally {
      setSavingTypeId("");
    }
  }

  return (
    <aside
      className={`claim-dock-panel claim-dock-panel-worklist claim-dock-panel-${mode}`}
      role={mode === "expanded" ? "dialog" : "complementary"}
      aria-modal={mode === "expanded" ? "true" : undefined}
      aria-hidden={inactive || undefined}
      aria-label={mode === "expanded" ? undefined : "Problem List"}
      aria-labelledby={mode === "expanded" ? "claim-worklist-heading" : undefined}
    >
      {mode === "collapsed" ? (
        <button ref={tabRef} type="button" className="claim-worklist-tab" onClick={onOpen} aria-label="Open Problem List">
          <span aria-hidden="true">✓</span><strong>Problem List</strong><i aria-hidden="true">‹</i>
        </button>
      ) : null}

      {mode === "expanded" ? (
        <div className="claim-worklist-shell">
          <header className="claim-worklist-header">
            <div><p>Assigned claim work</p><h2 id="claim-worklist-heading">Problem List</h2><span>Claim {claimId}</span></div>
            <button ref={closeRef} type="button" onClick={onCollapse} aria-label="Close Problem List">×</button>
          </header>

          <div className="claim-worklist-scroll" aria-busy={loading || Boolean(savingTypeId)}>
            {loading ? (
              <div className="claim-worklist-state" role="status">
                <span className="patient-claim-loading" aria-hidden="true" />
                <strong>Loading Problem List</strong><p>Checking all work assigned to this claim.</p>
              </div>
            ) : null}

            {!loading && error && !worklists.length ? (
              <div className="claim-worklist-state claim-worklist-state-error" role="alert">
                <strong>Problem List could not be loaded</strong><p>{error}</p>
                <button type="button" onClick={() => setLoadVersion((current) => current + 1)}>Try again</button>
              </div>
            ) : null}

            {!loading && (worklists.length || !error) ? (
              <>
                <section className="claim-worklist-collection" aria-label="Assigned problems">
                  <header><p>Assigned problems</p><strong>{worklists.length.toLocaleString()}</strong></header>
                  {worklists.length ? worklists.map((worklist) => (
                    <WorklistAccordion
                      key={worklist.type.id}
                      worklist={worklist}
                      saving={savingTypeId === String(worklist.type.id)}
                      onToggleItem={toggleItem}
                    />
                  )) : <p>No problems are assigned to this claim. An authorized Diagnosis user can add one or more.</p>}
                </section>
                {error ? <p className="claim-worklist-message claim-worklist-message-error" role="alert">{error}</p> : null}
                {notice ? <p className="claim-worklist-message claim-worklist-message-success" role="status">{notice}</p> : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
