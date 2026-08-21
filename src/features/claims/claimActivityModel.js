const APPEAL_CATEGORIES = new Set([
  "appeal_submitted",
  "appeal_planned_or_prepared",
  "appeal_follow_up_or_status",
]);

function eventDate(event) {
  const candidate = String(event?.date || event?.occurredAt || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function activityLabel(event, type) {
  if (event.categoryLabel) return event.categoryLabel;
  if (type === "rebill" && event.submissionReference) return `Rebill ${event.submissionReference}`;
  return event.title || (type === "appeal" ? "Appeal activity" : "Claim rebilled");
}

export function buildAppealRebillItems(data) {
  return (data?.timeline || [])
    .map((event, index) => {
      const searchable = [event.title, event.categoryLabel, event.description]
        .filter(Boolean)
        .join(" ");
      const eventHeading = [event.title, event.categoryLabel].filter(Boolean).join(" ");
      const isAppeal = APPEAL_CATEGORIES.has(event.category) || /\bappeal\b/i.test(searchable);
      const isRebill = event.category === "corrected_claim_or_rebill"
        || /re[- ]?bill|corrected claim|correction/i.test(eventHeading);
      const type = isAppeal ? "appeal" : isRebill ? "rebill" : null;
      if (!type) return null;

      const date = eventDate(event);
      return {
        id: event.id || `${type}-${date || "undated"}-${index}`,
        type,
        date,
        occurredAt: event.occurredAt || date || "",
        label: activityLabel(event, type),
        reference: event.submissionReference || null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(left.occurredAt).localeCompare(String(right.occurredAt))
      || left.label.localeCompare(right.label));
}
