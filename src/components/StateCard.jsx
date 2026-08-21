export function StateCard({ tone = "empty", title, message, action }) {
  const symbols = {
    empty: "⌕",
    error: "!",
    permission: "!",
  };

  return (
    <section className={`state-card state-card-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <div className="state-mark" aria-hidden="true">{symbols[tone] || "·"}</div>
      <h2>{title}</h2>
      <p>{message}</p>
      {action}
    </section>
  );
}

