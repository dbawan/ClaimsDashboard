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

function normalizeProcedure(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function eventProcedureCodes(event) {
  return unique([
    ...(event?.procedures || []),
    ...(event?.cptActivity || []).map((item) => item.procedure),
    ...(event?.cptPayments || []).map((item) => item.procedure),
    ...(event?.cptReceived || []).map((item) => item.procedure),
  ].map(normalizeProcedure)).sort();
}

function procedureAmount(items, procedure) {
  return (items || []).reduce((total, item) => (
    normalizeProcedure(item.procedure) === procedure ? total + numberValue(item.paid) : total
  ), 0);
}

function procedureActivity(event, procedure) {
  const matching = (event?.cptActivity || []).filter((item) => (
    normalizeProcedure(item.procedure) === procedure
  ));
  if (!matching.length) {
    return {
      procedure,
      lineCount: 0,
      posted: procedureAmount(event?.cptPayments, procedure),
      received: procedureAmount(event?.cptReceived, procedure),
      billed: null,
      allowed: null,
      patientResponsibility: null,
      adjusted: null,
      balance: null,
      adjustments: [],
    };
  }
  const nullableTotal = (field) => matching.some((item) => item[field] != null)
    ? matching.reduce((total, item) => total + numberValue(item[field]), 0)
    : null;
  return {
    procedure,
    lineCount: matching.reduce((total, item) => total + numberValue(item.lineCount), 0),
    posted: matching.reduce((total, item) => total + numberValue(item.posted), 0),
    received: matching.reduce((total, item) => total + numberValue(item.received), 0),
    billed: nullableTotal("billed"),
    allowed: nullableTotal("allowed"),
    patientResponsibility: nullableTotal("patientResponsibility"),
    adjusted: nullableTotal("adjusted"),
    balance: nullableTotal("balance"),
    adjustments: unique(matching.flatMap((item) => item.adjustments || [])),
  };
}

function procedureDescription(event, procedure, activity) {
  const parts = [];
  if (activity.lineCount) parts.push(`${activity.lineCount} ${procedure} service line${activity.lineCount === 1 ? "" : "s"}`);
  if (activity.billed != null) parts.push(`Billed ${formatMoney(activity.billed)}`);
  if (activity.allowed != null) parts.push(`Allowed ${formatMoney(activity.allowed)}`);
  if (event.paymentAuthority === "era") parts.push(`Payer paid ${formatMoney(activity.received)}`);
  if (event.paymentAuthority === "posted") parts.push(`Posted ${formatMoney(activity.posted)} to the billing ledger`);
  if (activity.patientResponsibility != null) parts.push(`Patient responsibility ${formatMoney(activity.patientResponsibility)}`);
  if (activity.adjusted != null) parts.push(`Adjusted ${formatMoney(activity.adjusted)}`);
  if (activity.balance != null) parts.push(`Balance ${formatMoney(activity.balance)}`);
  if (activity.adjustments.length) parts.push(`Codes/details ${activity.adjustments.join("; ")}`);
  if (event.submissionReference) parts.push(`Submission/rebill ref ${event.submissionReference}`);
  if (!parts.length) parts.push(`${procedure} was included in this claim activity`);
  return `${parts.join(" · ")}.`;
}

function isClaimContextEvent(event) {
  return /date of service|service provided/i.test(String(event?.title || ""));
}

export function scopeClaimDataToProcedure(data, procedureValue, { includeContext = true } = {}) {
  const procedure = normalizeProcedure(procedureValue);
  if (!procedure) return data;

  let posted = 0;
  let received = 0;
  let contextCount = 0;
  const timeline = [];
  for (const event of data?.timeline || []) {
    const matches = eventProcedureCodes(event).includes(procedure);
    if (!matches) {
      if (includeContext && isClaimContextEvent(event)) {
        contextCount += 1;
        timeline.push({
          ...event,
          title: "Service date — claim context",
          description: `${procedure} shares this claim-level date of service.`,
          amount: null,
          countedPayment: 0,
          receivedPayment: 0,
          claimContext: true,
        });
      }
      continue;
    }

    const activity = procedureActivity(event, procedure);
    if (event.paymentAuthority === "posted") posted += activity.posted;
    if (event.paymentAuthority === "era") received += activity.received;
    let title = event.title;
    if (event.paymentAuthority === "posted") title = `Payment posted internally — ${procedure}`;
    else if (event.paymentAuthority === "era") {
      title = Math.abs(activity.received) >= 0.005
        ? `Payer payment received — ${procedure}`
        : `Payer response: no payment — ${procedure}`;
    } else if (/submission|correction|rebill|re-bill/i.test(title)) {
      title = `Submission/rebill included ${procedure}`;
    }

    timeline.push({
      ...event,
      title,
      description: procedureDescription(event, procedure, activity),
      amount: event.paymentAuthority === "posted"
        ? activity.posted
        : event.paymentAuthority === "era" ? activity.received : null,
      countedPayment: event.paymentAuthority === "posted" ? activity.posted : 0,
      receivedPayment: event.paymentAuthority === "era" ? activity.received : 0,
      cptPayments: activity.posted ? [{ procedure, paid: activity.posted }] : [],
      cptReceived: activity.received ? [{ procedure, paid: activity.received }] : [],
      procedures: [procedure],
      cptActivity: [activity],
      claimContext: false,
    });
  }

  const financial = (data?.cptFinancials || []).find((item) => (
    normalizeProcedure(item.procedure) === procedure
  ));
  const charged = numberValue(financial?.charged);
  return {
    ...data,
    selectedProcedure: procedure,
    timeline,
    summary: {
      ...data.summary,
      charges: charged,
      totalPaid: Number(posted.toFixed(2)),
      postedPaid: Number(posted.toFixed(2)),
      receivedPaid: Number(received.toFixed(2)),
      eraPaid: Number(received.toFixed(2)),
    },
    procedureScope: {
      procedure,
      charged,
      posted: Number(posted.toFixed(2)),
      received: Number(received.toFixed(2)),
      contextCount,
      relevantRecordCount: timeline.length - contextCount,
      claimRecordCount: data?.timeline?.length || 0,
    },
  };
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
    hasPayerResponse: titles.some((title) => /adjudicat|denial|denied|pending|payer response/.test(title))
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
    hasPosting: events.some((event) => event.paymentAuthority === "posted") || titles.some((title) => /applied payment|payment applied/.test(title)),
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
  if (episode.events.some((event) => event.paymentAuthority === "posted")
    || group.events.some((event) => event.paymentAuthority === "posted")) return false;
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

  if (flags.hasPosting && (flags.hasPayment || flags.hasReversal)) {
    return { title: flags.hasReversal ? "Posted payment reversed" : "Posted payment",
      summary: `${formatMoney(flags.amount)} was posted to the billing ledger.`,
      status: flags.hasReversal ? "danger" : "success" };
  }
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

function procedureStoryCopy(copy, procedure) {
  if (!procedure) return copy;
  const titles = {
    "Posted payment": `Payment posted internally — ${procedure}`,
    "Posted payment reversed": `Posted payment reversed — ${procedure}`,
    "Payment received": `Payer payment received — ${procedure}`,
    "Payment reversed": `Payer payment reversed — ${procedure}`,
    "Payer response: no payment": `Payer response: no payment — ${procedure}`,
    "Claim corrected and rebilled": `${procedure} corrected and rebilled`,
    "Claim submitted": `${procedure} submitted`,
    "Billing system updated": `Billing records updated — ${procedure}`,
    "Additional claim processing": `Additional processing — ${procedure}`,
    "Service provided": `Service date — claim context`,
  };
  return { ...copy, title: titles[copy.title] || copy.title };
}

function finishEpisode(episode, index, procedure) {
  const flags = combineFlags(episode.events);
  const copy = procedureStoryCopy(storyCopy({ ...episode, flags }), procedure);
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

export function buildClaimStory(data, options = {}) {
  const procedure = normalizeProcedure(options.selectedProcedure || data?.selectedProcedure);
  const byDate = new Map();
  for (const event of data?.timeline || []) {
    const date = dateOnly(event.date);
    const key = `${date || "undated"}:${event.paymentAuthority === "posted" ? "posted" : "other"}`;
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

  return episodes.map((episode, index) => finishEpisode(episode, index, procedure));
}

export function plainSourceLabel(source) {
  const value = String(source || "").toLowerCase();
  if (value.includes("salesforce")) return "Team note";
  if (value.includes("edi 835") || value.includes("claimstatus") || value.includes("advancedmd era")) return "Payer remittance";
  if (value.includes("flatten")) return "Billing system";
  if (value.includes("combined")) return "Reconciled records";
  return source || "Claim record";
}
