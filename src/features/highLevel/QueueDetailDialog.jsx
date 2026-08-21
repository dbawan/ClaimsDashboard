import { useEffect, useId, useRef } from "react";
import { openClaimWorkspace } from "../claims/claimNavigation.js";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value) {
  if (!value) return "Not provided";
  const parsed = Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) ? dateFormatter.format(new Date(parsed)) : value;
}

function procedures(item) {
  if (Array.isArray(item.procedures)) return item.procedures;
  return String(item.procedures || "").split(",").map((value) => value.trim()).filter(Boolean);
}

function Detail({ label, value }) {
  return <div><dt>{label}</dt><dd>{value || "Not provided"}</dd></div>;
}

export function QueueDetailDialog({ item, mode, onClose }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const isUnsubmitted = mode === "unsubmitted";
  const cpts = procedures(item);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  function handleBackdrop(event) {
    if (event.target !== dialogRef.current) return;
    const bounds = dialogRef.current.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    if (!inside) onClose();
  }

  return (
    <dialog
      className="queue-detail-dialog"
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onClick={handleBackdrop}
    >
      <div className="queue-detail-shell">
        <header>
          <div>
            <span>{isUnsubmitted ? "Unsubmitted encounter" : "Awaiting payer response"}</span>
            <h2 id={titleId}>{item.patientName || "Patient not provided"}</h2>
            <small>{isUnsubmitted ? "Encounter" : "Claim"} {item.claimId}</small>
          </div>
          <button type="button" onClick={onClose} aria-label="Close queue details">×</button>
        </header>

        <section className="queue-detail-alert">
          <strong>{item.elapsedDays} days</strong>
          <p>{isUnsubmitted
            ? "No billed, submitted, corrected, or rebill transaction was found for this encounter."
            : "No ClaimStatus or EDI 835 payer response was found for this submitted claim."}</p>
        </section>

        <dl className="queue-detail-grid">
          <Detail label={isUnsubmitted ? "Appointment" : "Submitted"} value={formatDate(isUnsubmitted ? item.serviceDate : item.submittedDate)} />
          {!isUnsubmitted ? <Detail label="Service date" value={formatDate(item.serviceDate)} /> : null}
          <Detail label="Provider" value={item.provider} />
          <Detail label="Location" value={item.location} />
          <Detail label="Payer" value={item.payer} />
          <Detail label="MRN" value={item.mrn} />
          <Detail label="Date of birth" value={formatDate(item.dateOfBirth)} />
        </dl>

        <section className="queue-detail-cpts">
          <span>CPT codes</span>
          <div>{cpts.length ? cpts.map((cpt) => <strong key={cpt}>{cpt}</strong>) : <p>No CPT codes available</p>}</div>
        </section>

        <footer>
          <button type="button" className="queue-detail-secondary" onClick={onClose}>Close</button>
          <button type="button" className="queue-detail-primary" onClick={() => openClaimWorkspace(item.claimId)}>
            Open {isUnsubmitted ? "encounter" : "claim"} workspace
          </button>
        </footer>
      </div>
    </dialog>
  );
}
