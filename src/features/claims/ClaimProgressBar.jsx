function currentStep(progress) {
  return progress.find((step) => step.state === "current" || step.state === "alert");
}

export function ClaimProgressBar({ progress = [] }) {
  if (!progress.length) return null;
  const current = currentStep(progress);

  return (
    <section className="claim-progress-bar" aria-label="Claim status milestones">
      <header>
        <span>Claim status</span>
        <strong>{current?.label || "Status available"}</strong>
      </header>
      <ol>
        {progress.map((step) => (
          <li
            className={`claim-progress-step claim-progress-${step.state}`}
            key={step.key}
            title={step.detail || step.label}
            aria-current={step.state === "current" || step.state === "alert" ? "step" : undefined}
          >
            <span className="claim-progress-mark" aria-hidden="true">
              {step.state === "alert" ? "!" : step.state === "current" ? "•" : step.state === "complete" ? "✓" : ""}
            </span>
            <span className="claim-progress-label">{step.label}</span>
            <span className="sr-only">
              {step.state === "complete" ? "Complete" : step.state === "current" ? "Current" : step.state === "alert" ? "Recorded" : "Not recorded"}
              {step.detail ? `. ${step.detail}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
