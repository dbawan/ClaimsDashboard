import { useEffect, useRef, useState } from "react";
import {
  assignClaimWorklist,
  createWorklistType,
  fetchClaimWorklists,
  fetchWorklistTypes,
  removeWorklistType,
} from "./api.js";

function sortedTypes(types) {
  return [...types].sort((left, right) => left.name.localeCompare(right.name));
}

function emptyDraft(id = 1) {
  return [{ id, label: "" }];
}

function assignmentProgress(worklist) {
  return `${worklist.checkedItemIds?.length || 0}/${worklist.type?.checkboxes?.length || 0}`;
}

function canScrollVertically(element, deltaY) {
  const maximum = element.scrollHeight - element.clientHeight;
  if (maximum <= 1) return false;
  return deltaY > 0 ? element.scrollTop < maximum - 1 : element.scrollTop > 1;
}

function wheelDistance(event, element) {
  const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
  return event.deltaY * multiplier;
}

function scrollAccordionBody(event) {
  const element = event.currentTarget;
  if (!canScrollVertically(element, event.deltaY)) return;
  event.preventDefault();
  event.stopPropagation();
  element.scrollTop += wheelDistance(event, element);
}

function relayAccordionWheel(event) {
  if (!event.deltaY || event.ctrlKey) return;
  const root = event.currentTarget;
  const target = event.target?.closest ? event.target : null;
  if (!target || !root.contains(target)) return;

  const textarea = target.closest("textarea");
  if (textarea && canScrollVertically(textarea, event.deltaY)) return;

  const origin = target.closest(".claim-diagnosis-accordion-scroll");
  if (!origin || origin === root || !root.contains(origin)) return;
  if (canScrollVertically(origin, event.deltaY)) return;

  let destination = origin.parentElement;
  while (destination && destination !== root) {
    if (destination.classList.contains("claim-diagnosis-accordion-scroll")
      && canScrollVertically(destination, event.deltaY)) break;
    destination = destination.parentElement;
  }
  if (!destination || !root.contains(destination)) destination = root;
  if (!canScrollVertically(destination, event.deltaY)) return;

  event.preventDefault();
  destination.scrollTop += wheelDistance(event, destination);
}

export function ClaimDiagnosisPanel({ data, mode, inactive, onOpen, onCollapse, closeRef, tabRef }) {
  const claimId = data.claim?.claimId;
  const nextDraftIdRef = useRef(2);
  const [types, setTypes] = useState([]);
  const [worklists, setWorklists] = useState([]);
  const [notesByType, setNotesByType] = useState({});
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypeNote, setNewTypeNote] = useState("");
  const [draftItems, setDraftItems] = useState(() => emptyDraft());
  const [loadVersion, setLoadVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setTypes([]);
    setWorklists([]);
    setNotesByType({});
    setNewTypeName("");
    setNewTypeNote("");
    setDraftItems(emptyDraft());
    nextDraftIdRef.current = 2;
    setError("");
    setNotice("");
  }, [claimId]);

  useEffect(() => {
    if (mode !== "expanded" || !claimId) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setNotice("");
    void Promise.all([
      fetchWorklistTypes({ signal: controller.signal }),
      fetchClaimWorklists(claimId, { signal: controller.signal }),
    ]).then(([nextTypes, nextWorklists]) => {
      setTypes(sortedTypes(nextTypes));
      setWorklists(nextWorklists);
      setNotesByType(Object.fromEntries(nextWorklists.map((worklist) => [String(worklist.type.id), worklist.note || ""])));
    }).catch((nextError) => {
      if (nextError.name !== "AbortError") setError(nextError.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [mode, claimId, loadVersion]);

  function assignedWorklist(typeId) {
    return worklists.find((worklist) => String(worklist.type.id) === String(typeId)) || null;
  }

  function setTypeNote(typeId, value) {
    setNotesByType((current) => ({ ...current, [String(typeId)]: value }));
  }

  function saveAssignment(nextWorklist) {
    setWorklists((current) => {
      const exists = current.some((worklist) => worklist.type.id === nextWorklist.type.id);
      return exists
        ? current.map((worklist) => worklist.type.id === nextWorklist.type.id ? nextWorklist : worklist)
        : [...current, nextWorklist];
    });
    setTypeNote(nextWorklist.type.id, nextWorklist.note || "");
  }

  async function applyType(type) {
    const typeKey = String(type.id);
    if (saving) return null;
    const existing = assignedWorklist(type.id);
    setSaving(typeKey);
    setError("");
    setNotice("");
    try {
      const assignment = await assignClaimWorklist(claimId, type.id, { note: notesByType[typeKey] || "" });
      saveAssignment(assignment.worklist);
      const assignmentNotice = existing
        ? `${assignment.worklist.type.name} note saved.`
        : `${assignment.worklist.type.name} was added to the Problem List.`;
      setNotice(assignment.salesforceNotification?.status === "created"
        ? `${assignmentNotice} Salesforce was notified.`
        : assignmentNotice);
      if (assignment.salesforceNotification?.status === "failed") {
        setError(`The Problem List was updated, but ${assignment.salesforceNotification.message}`);
      }
      return assignment.worklist;
    } catch (nextError) {
      setError(nextError.message);
      return null;
    } finally {
      setSaving("");
    }
  }

  async function removeType(type) {
    if (saving) return;
    const confirmed = window.confirm(
      `Remove “${type.name}” from the reusable Diagnosis catalog? Existing claim assignments will remain unchanged.`,
    );
    if (!confirmed) return;
    const savingKey = `remove:${type.id}`;
    setSaving(savingKey);
    setError("");
    setNotice("");
    try {
      const removed = await removeWorklistType(type.id);
      setTypes((current) => current.filter((item) => item.id !== removed.id));
      setNotesByType((current) => {
        const next = { ...current };
        delete next[String(removed.id)];
        return next;
      });
      setNotice(`${removed.name} was removed from the reusable Diagnosis catalog. Existing claim assignments remain unchanged.`);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setSaving("");
    }
  }

  function updateDraftItem(id, label) {
    setDraftItems((current) => current.map((item) => item.id === id ? { ...item, label } : item));
  }

  function addDraftItem() {
    if (draftItems.length >= 40) return;
    const id = nextDraftIdRef.current++;
    setDraftItems((current) => [...current, { id, label: "" }]);
  }

  function removeDraftItem(id) {
    setDraftItems((current) => current.length === 1 ? current : current.filter((item) => item.id !== id));
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (saving) return;
    setSaving("create");
    setError("");
    setNotice("");
    let createdType = null;
    try {
      createdType = await createWorklistType({
        name: newTypeName,
        checkboxes: draftItems.map(({ label }) => label),
      });
      setTypes((current) => sortedTypes([...current.filter(({ id }) => id !== createdType.id), createdType]));
      const assignment = await assignClaimWorklist(claimId, createdType.id, { note: newTypeNote });
      saveAssignment(assignment.worklist);
      setNewTypeName("");
      setNewTypeNote("");
      setDraftItems(emptyDraft(nextDraftIdRef.current++));
      const assignmentNotice = `${createdType.name} was created and added to the Problem List.`;
      setNotice(assignment.salesforceNotification?.status === "created"
        ? `${assignmentNotice} Salesforce was notified.`
        : assignmentNotice);
      if (assignment.salesforceNotification?.status === "failed") {
        setError(`The Problem List was updated, but ${assignment.salesforceNotification.message}`);
      }
    } catch (nextError) {
      setError(createdType
        ? `${createdType.name} was created, but it could not be assigned: ${nextError.message}`
        : nextError.message);
    } finally {
      setSaving("");
    }
  }

  return (
    <aside
      className={`claim-dock-panel claim-dock-panel-diagnosis claim-dock-panel-${mode}`}
      role={mode === "expanded" ? "dialog" : "complementary"}
      aria-modal={mode === "expanded" ? "true" : undefined}
      aria-hidden={inactive || undefined}
      aria-label={mode === "expanded" ? undefined : "Diagnosis"}
      aria-labelledby={mode === "expanded" ? "claim-diagnosis-heading" : undefined}
    >
      {mode === "collapsed" ? (
        <button ref={tabRef} type="button" className="claim-diagnosis-tab" onClick={onOpen} aria-label="Open Diagnosis">
          <span aria-hidden="true">+</span><strong>Diagnosis</strong><i aria-hidden="true">‹</i>
        </button>
      ) : null}

      {mode === "expanded" ? (
        <div className="claim-worklist-shell claim-diagnosis-shell">
          <header className="claim-worklist-header claim-diagnosis-header">
            <div><p>Problem setup</p><h2 id="claim-diagnosis-heading">Diagnosis</h2><span>Claim {claimId}</span></div>
            <button ref={closeRef} type="button" onClick={onCollapse} aria-label="Close Diagnosis">×</button>
          </header>

          <div
            className="claim-worklist-scroll"
            tabIndex={0}
            aria-label="Scrollable Diagnosis content"
            aria-busy={loading || Boolean(saving)}
            onWheelCapture={relayAccordionWheel}
          >
            {loading ? (
              <div className="claim-worklist-state" role="status">
                <span className="patient-claim-loading" aria-hidden="true" />
                <strong>Loading Diagnosis</strong><p>Checking this claim and the reusable problem types.</p>
              </div>
            ) : null}

            {!loading && error && !types.length && !worklists.length ? (
              <div className="claim-worklist-state claim-worklist-state-error" role="alert">
                <strong>Diagnosis could not be loaded</strong><p>{error}</p>
                <button type="button" onClick={() => setLoadVersion((current) => current + 1)}>Try again</button>
              </div>
            ) : null}

            {!loading && (types.length || worklists.length || !error) ? (
              <>
                <section className="claim-diagnosis-current" aria-label="Problems already assigned">
                  <header className="claim-diagnosis-current-header">
                    <span className="claim-diagnosis-current-icon" aria-hidden="true">✓</span>
                    <div>
                      <p>On this claim</p>
                      <strong>Assigned diagnoses</strong>
                      <small>Expand a card to review its note and tasks.</small>
                    </div>
                    <b>{worklists.length.toLocaleString()}</b>
                  </header>
                  {worklists.length ? (
                    <div className="claim-diagnosis-assigned-list">
                      {worklists.map((worklist) => {
                        const complete = worklist.type.checkboxes.length > 0
                          && worklist.checkedItemIds.length === worklist.type.checkboxes.length;
                        return (
                        <details
                          className={complete ? "claim-diagnosis-assigned-complete" : "claim-diagnosis-assigned-active"}
                          key={worklist.type.id}
                        >
                          <summary>
                            <span className="claim-diagnosis-assigned-status" aria-hidden="true">{complete ? "✓" : "•"}</span>
                            <span className="claim-diagnosis-assigned-copy">
                              <small>{complete ? "Completed" : "In progress"}</small>
                              <strong>{worklist.type.name}</strong>
                            </span>
                            <b>{assignmentProgress(worklist)} tasks</b>
                          </summary>
                          <div
                            className="claim-diagnosis-assigned-body claim-diagnosis-accordion-scroll"
                            tabIndex={0}
                            aria-label={`${worklist.type.name} diagnosis details`}
                            onWheel={scrollAccordionBody}
                          >
                            <strong>Claim-specific note</strong>
                            {worklist.note ? <p>{worklist.note}</p> : <p>No claim-specific note.</p>}
                            <strong>Tasks in this diagnosis</strong>
                            <ol>{worklist.type.checkboxes.map((item) => <li key={item.id}>{item.label}</li>)}</ol>
                          </div>
                        </details>
                        );
                      })}
                    </div>
                  ) : <span className="claim-diagnosis-none">No diagnoses have been added yet. Choose one from the catalog below.</span>}
                </section>

                {error ? <p className="claim-worklist-message claim-worklist-message-error" role="alert">{error}</p> : null}
                {notice ? <p className="claim-worklist-message claim-worklist-message-success" role="status">{notice}</p> : null}

                <details
                  className="claim-diagnosis-section claim-diagnosis-section-existing"
                  open
                >
                  <summary>
                    <span className="claim-diagnosis-section-icon" aria-hidden="true">▦</span>
                    <span className="claim-diagnosis-section-copy">
                      <strong>Browse existing diagnoses</strong>
                      <small>Expand a diagnosis, review its tasks, then add it to this claim.</small>
                    </span>
                    <b>{types.length.toLocaleString()} available</b>
                  </summary>
                  <div
                    className="claim-diagnosis-section-body claim-diagnosis-accordion-scroll claim-diagnosis-catalog-body"
                    tabIndex={0}
                    aria-label="Existing diagnosis catalog"
                    onWheel={scrollAccordionBody}
                  >
                    {types.length ? types.map((type) => {
                      const existing = assignedWorklist(type.id);
                      const typeKey = String(type.id);
                      const note = notesByType[typeKey] || "";
                      const noteUnchanged = Boolean(existing) && note === (existing.note || "");
                      const assignmentCount = Number(type.assignmentCount || 0);
                      return (
                        <details className="claim-diagnosis-type" key={type.id}>
                          <summary>
                            <span className={`claim-diagnosis-type-marker${existing ? " claim-diagnosis-type-marker-added" : ""}`} aria-hidden="true">{existing ? "✓" : "+"}</span>
                            <span className="claim-diagnosis-type-copy">
                              <small>{existing ? "Already on this claim" : "Available diagnosis"}</small>
                              <strong>{type.name}</strong>
                              <em>{type.checkboxes.length} task{type.checkboxes.length === 1 ? "" : "s"} included</em>
                            </span>
                            <b className={existing ? "claim-diagnosis-type-added" : "claim-diagnosis-type-review"}>{existing ? "Added" : "Review"}</b>
                          </summary>
                          <div
                            className="claim-diagnosis-type-body claim-diagnosis-accordion-scroll"
                            tabIndex={0}
                            aria-label={`${type.name} diagnosis setup`}
                            onWheel={scrollAccordionBody}
                          >
                            <p className="claim-diagnosis-field-heading">Tasks included in this diagnosis</p>
                            <ol className="claim-worklist-type-preview">
                              {type.checkboxes.map((item) => <li key={item.id}>{item.label}</li>)}
                            </ol>
                            <label>
                              Note for the Problem List
                              <textarea
                                value={note}
                                maxLength={4000}
                                rows={4}
                                placeholder="Add claim-specific context or instructions for the assigned user."
                                onChange={(event) => setTypeNote(type.id, event.target.value)}
                              />
                            </label>
                            <small>{note.length.toLocaleString("en-US")} / 4,000</small>
                            <div className="claim-diagnosis-type-actions">
                              <button className="claim-diagnosis-type-primary" type="button" disabled={Boolean(saving) || noteUnchanged} onClick={() => void applyType(type)}>
                                {saving === typeKey ? "Saving…" : existing ? noteUnchanged ? "Already added" : "Save note" : "Add to Problem List"}
                              </button>
                              <button
                                className="claim-diagnosis-type-remove"
                                type="button"
                                disabled={Boolean(saving)}
                                title={`Remove ${type.name} from future reuse; existing claim assignments stay intact`}
                                onClick={() => void removeType(type)}
                              >
                                {saving === `remove:${type.id}` ? "Removing…" : "Remove from catalog"}
                              </button>
                            </div>
                            <p className="claim-diagnosis-removal-state">
                              {assignmentCount > 0 || existing
                                ? `Used by ${Math.max(assignmentCount, existing ? 1 : 0).toLocaleString()} claim${Math.max(assignmentCount, existing ? 1 : 0) === 1 ? "" : "s"}. Removing it hides it from future selection but preserves every existing assignment.`
                                : "Removing this diagnosis hides it from future selection. It is not currently assigned to a claim."}
                            </p>
                          </div>
                        </details>
                      );
                    }) : <p>No reusable problem types exist yet. Create the first one.</p>}
                  </div>
                </details>

                <details
                  className="claim-diagnosis-section claim-diagnosis-section-create"
                >
                  <summary>
                    <span className="claim-diagnosis-section-icon" aria-hidden="true">+</span>
                    <span className="claim-diagnosis-section-copy">
                      <strong>Create a new diagnosis</strong>
                      <small>Build a reusable task set and add it to this claim.</small>
                    </span>
                    <b>New</b>
                  </summary>
                  <form
                    className="claim-worklist-create claim-diagnosis-section-body claim-diagnosis-accordion-scroll claim-diagnosis-create-body"
                    tabIndex={0}
                    aria-label="Create a new diagnosis"
                    onWheel={scrollAccordionBody}
                    onSubmit={handleCreate}
                  >
                    <p className="claim-diagnosis-create-intro">This creates a reusable diagnosis for future claims and assigns it to this claim immediately.</p>
                    <label>Problem type name<input type="text" value={newTypeName} maxLength={120} placeholder="e.g. Denial follow-up" onChange={(event) => setNewTypeName(event.target.value)} /></label>
                    <fieldset>
                      <legend>Problem List tasks</legend>
                      {draftItems.map((item, index) => (
                        <div className="claim-worklist-draft-item" key={item.id}>
                          <input type="text" value={item.label} maxLength={120} placeholder={`Task ${index + 1}`} aria-label={`Task ${index + 1} label`} onChange={(event) => updateDraftItem(item.id, event.target.value)} />
                          <button type="button" disabled={draftItems.length === 1} onClick={() => removeDraftItem(item.id)} aria-label={`Remove task ${index + 1}`}>×</button>
                        </div>
                      ))}
                      <button type="button" disabled={draftItems.length >= 40} onClick={addDraftItem}>+ Add task</button>
                    </fieldset>
                    <label>Note for the Problem List<textarea value={newTypeNote} maxLength={4000} rows={5} placeholder="Add claim-specific context or instructions for the assigned user." onChange={(event) => setNewTypeNote(event.target.value)} /></label>
                    <small>{newTypeNote.length.toLocaleString("en-US")} / 4,000</small>
                    <button type="submit" disabled={Boolean(saving)}>{saving === "create" ? "Creating and assigning…" : "Create and add to this claim"}</button>
                  </form>
                </details>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
