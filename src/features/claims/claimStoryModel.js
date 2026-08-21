function dateOnly(value) {
  const candidate = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function titleText(event) {
  return String(event?.title || "").toLowerCase();
}

function eventText(event) {
  return [event?.title, event?.description, event?.commentText].filter(Boolean).join(" ").toLowerCase();
}

function isCommentCategory(event, categories) {
  return event?.eventType === "salesforce-comment" && categories.includes(event.category);
}

function flagsFor(events) {
  const titles = events.map(titleText);
  const countedAmount = events.reduce((total, event) => total + numberValue(event.countedPayment), 0);
  const displayedAmount = events.reduce((total, event) => {
    if (!/payment received|payment reversed/.test(titleText(event))) return total;
    return total + numberValue(event.amount);
  }, 0);
  const amount = Math.abs(countedAmount) >= 0.005 ? countedAmount : displayedAmount;

  return {
    amount: Number(amount.toFixed(2)),
    hasService: titles.some((title) => /date of service|service provided/.test(title)),
    hasPayment: amount > 0 || titles.some((title) => /payment received/.test(title)),
    hasReversal: amount < 0 || titles.some((title) => /payment reversed|reversal/.test(title)),
    hasPayerResponse: titles.some((title) => /adjudicat|denial|denied|pending/.test(title))
      || events.some((event) => isCommentCategory(event, ["denial_or_pending"])),
    hasIssue: events.some((event) => isCommentCategory(event, ["denial_or_pending"]))
      || events.some((event) => /not on file|no claim on file|could not locate|unable to locate/.test(eventText(event))),
    hasAppeal: events.some((event) => isCommentCategory(event, [
      "appeal_submitted",
      "appeal_planned_or_prepared",
      "appeal_follow_up_or_status",
    ])),
    hasSubmission: titles.some((title) => /submission|correction|corrected|rebill|re-bill|claim created|\bbilled\b/.test(title))
      || events.some((event) => isCommentCategory(event, ["corrected_claim_or_rebill"])),
    hasCorrection: titles.some((title) => /correction|corrected|rebill|re-bill/.test(title))
      || events.some((event) => isCommentCategory(event, ["corrected_claim_or_rebill"])),
    hasCloseout: titles.some((title) => /adjusted charges|settled|write.?off/.test(title))
      || events.some((event) => isCommentCategory(event, ["write_off_or_adjustment"])),
    hasPosting: titles.some((title) => /applied payment|payment applied/.test(title)),
    hasComment: events.some((event) => event.eventType === "salesforce-comment"),
  };
}

function groupKind(flags) {
  if (flags.hasReversal) return "reversal";
  if (flags.hasPayment) return "payment";
  if (flags.hasIssue) return "issue";
  if (flags.hasAppeal) return "appeal";
  if (flags.hasPayerResponse) return "payer-response";
  if (flags.hasCloseout) return "closeout";
  if (flags.hasSubmission) return "submission";
  if (flags.hasService) return "service";
  return "activity";
}

function combineFlags(events) {
  const flags = flagsFor(events);
  return { ...flags, kind: groupKind(flags) };
}

function daysBetween(left, right) {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.POSITIVE_INFINITY;
  return Math.round((rightTime - leftTime) / 86_400_000);
}

function referencesFor(events) {
  return unique(events.map((event) => event.submissionReference));
}

function sharesReference(left, right) {
  const leftReferences = new Set(referencesFor(left.events));
  return referencesFor(right.events).some((reference) => leftReferences.has(reference));
}

function shouldMerge(episode, group) {
  if (!episode.endDate || !group.startDate) return false;
  const gap = daysBetween(episode.endDate, group.startDate);
  const span = daysBetween(episode.startDate, group.endDate);
  const left = episode.flags;
  const right = group.flags;

  if (left.kind === "submission" && right.kind === "submission") {
    return gap <= 45 && span <= 60;
  }
  if (left.hasSubmission && right.hasPayerResponse && !right.hasIssue) {
    return gap <= 14 && (sharesReference(episode, group) || left.kind === "submission");
  }
  if (left.hasSubmission && right.hasPayment) {
    return gap <= 14;
  }
  if ((left.hasSubmission || left.hasCloseout) && right.hasCloseout) {
    return gap <= 14;
  }
  if (left.hasCloseout && right.hasPayerResponse && !right.hasIssue) {
    return gap <= 2;
  }
  if (left.hasSubmission && right.hasPayerResponse && right.hasCloseout && !right.hasIssue) {
    return gap <= 14;
  }
  return false;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(numberValue(value));
}

function plainCommentSummary(event) {
  const rawText = String(event?.commentText || "");
  const description = String(event?.description || "");
  const text = `${rawText} ${description}`.toLowerCase();

  if (/not on file|no claim on file|could not locate|unable to locate/.test(text)) {
    return "The payer reported that it could not locate the claim, so follow-up is required.";
  }
  if (/appeal/.test(text) && /submitted|sent|filed/.test(text)) {
    return "An appeal was sent to the payer for review.";
  }

  const summary = description.split(" · ").find((part) => !/^(comment |action |follow-up |evidence |paid |allowed |amount |check\/eft |issue date |cleared date |payment posting issue)/i.test(part));
  return summary || null;
}

function storyCopy(episode) {
  const { flags, events } = episode;
  const remittanceCount = events.filter((event) => {
    const title = titleText(event);
    return /payment received|payment reversed/.test(title) && numberValue(event.amount) !== 0;
  }).length;
  const comment = events.find((event) => event.eventType === "salesforce-comment");

  if (flags.hasReversal) {
    return {
      title: "Payment reversed",
      summary: `${formatMoney(Math.abs(flags.amount))} was removed from the claim payment total.`,
      status: "danger",
    };
  }
  if (flags.hasPayment) {
    const sourceCount = remittanceCount || 1;
    return {
      title: "Payment received",
      summary: `${formatMoney(flags.amount)} was received across ${sourceCount} remittance${sourceCount === 1 ? "" : "s"}.`,
      status: "success",
    };
  }
  if (flags.hasIssue) {
    return {
      title: /not on file|no claim on file|could not locate|unable to locate/.test(events.map(eventText).join(" "))
        ? "Payer could not locate claim"
        : "Payer issue needs attention",
      summary: plainCommentSummary(comment) || "The payer response requires review or follow-up.",
      status: "danger",
    };
  }
  if (flags.hasAppeal) {
    return {
      title: comment?.categoryLabel || "Appeal activity",
      summary: plainCommentSummary(comment) || "Appeal activity was recorded for this claim.",
      status: "warning",
    };
  }
  if (flags.hasSubmission && flags.hasCloseout) {
    return {
      title: "Additional claim processing",
      summary: "The claim and billing records were updated. No additional payment was recorded.",
      status: "neutral",
    };
  }
  if (flags.hasPayerResponse) {
    return {
      title: "Payer response: no payment",
      summary: "The payer processed this submission without issuing payment.",
      status: "warning",
    };
  }
  if (flags.hasSubmission) {
    return {
      title: flags.hasCorrection ? "Claim corrected and rebilled" : "Claim submitted",
      summary: flags.hasCorrection
        ? "The claim was corrected and sent to the payer again."
        : "The claim was prepared and sent for payer processing.",
      status: flags.hasCorrection ? "warning" : "neutral",
    };
  }
  if (flags.hasCloseout || flags.hasPosting) {
    return {
      title: "Billing system updated",
      summary: "Internal billing records were updated. This entry does not represent a new payment.",
      status: "neutral",
    };
  }
  if (flags.hasService) {
    return {
      title: "Service provided",
      summary: "Care was delivered for the services included in this claim.",
      status: "neutral",
    };
  }
  return {
    title: events[0]?.title || "Claim activity",
    summary: "Supporting activity was recorded for this claim.",
    status: events.some((event) => event.status === "warning") ? "warning" : "neutral",
  };
}

function finishEpisode(episode, index) {
  const flags = combineFlags(episode.events);
  const copy = storyCopy({ ...episode, flags });
  return {
    ...episode,
    ...copy,
    flags,
    kind: flags.kind,
    amount: flags.hasPayment || flags.hasReversal ? flags.amount : null,
    sources: unique(episode.events.map((event) => event.source)),
    references: referencesFor(episode.events),
    recordCount: episode.events.length,
    key: `claim-story-${episode.startDate || "undated"}-${episode.endDate || "undated"}-${index}`,
  };
}

export function buildClaimStory(data) {
  const byDate = new Map();
  for (const event of data?.timeline || []) {
    const date = dateOnly(event.date);
    const key = date || "undated";
    if (!byDate.has(key)) byDate.set(key, { startDate: date, endDate: date, dates: [], events: [] });
    const group = byDate.get(key);
    if (date && !group.dates.includes(date)) group.dates.push(date);
    group.events.push(event);
  }

  const groups = [...byDate.values()]
    .sort((left, right) => (left.startDate || "9999-12-31").localeCompare(right.startDate || "9999-12-31"))
    .map((group) => ({ ...group, flags: combineFlags(group.events) }));

  const episodes = [];
  for (const group of groups) {
    const current = episodes.at(-1);
    if (current && shouldMerge(current, group)) {
      current.endDate = group.endDate || current.endDate;
      current.dates.push(...group.dates);
      current.events.push(...group.events);
      current.flags = combineFlags(current.events);
      continue;
    }
    episodes.push({ ...group, dates: [...group.dates], events: [...group.events] });
  }

  return episodes.map(finishEpisode);
}

export function plainSourceLabel(source) {
  const value = String(source || "").toLowerCase();
  if (value.includes("salesforce")) return "Team note";
  if (value.includes("edi 835") || value.includes("claimstatus")) return "Payer remittance";
  if (value.includes("flatten")) return "Billing system";
  if (value.includes("combined")) return "Reconciled records";
  return source || "Claim record";
}
