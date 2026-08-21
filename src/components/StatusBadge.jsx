export function StatusBadge({ tone = "neutral", children }) {
  return <span className={`status-badge status-badge-${tone}`}>{children}</span>;
}

