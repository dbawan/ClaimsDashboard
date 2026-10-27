import { pathWithinApp } from "../lib/appPath.js";

function userInitials(user) {
  const source = user?.name || user?.email || "UT";
  const words = source.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words.at(-1)[0]}`.toUpperCase();
}

export function AppShell({ children, activeView, onNavigate, permissions = {}, user }) {
  const canViewClaims = permissions.claimOverview
    || permissions.paymentsAndEra
    || permissions.supportingRecords;
  const canViewHighLevel = permissions.highLevelOperations;
  return (
    <div className="app-frame">
      <header className="app-header">
        <div className={`header-inner${activeView === "claims" ? " header-inner-claims" : ""}`}>
          <div className="header-left">
            <a className="wordmark" href={pathWithinApp("/")} aria-label="United Theranostics home">
              <span className="wordmark-mark" aria-hidden="true">UT</span>
              <span className="wordmark-copy">
                <span className="wordmark-united">United</span>
                <span className="wordmark-theranostics">Theranostics</span>
              </span>
            </a>
            <span className="product-name">Claim Lifecycle</span>
            <nav className="desktop-nav" aria-label="Primary navigation">
              {canViewClaims ? (
                <button
                  className={`nav-tab ${activeView === "claims" ? "nav-tab-active" : ""}`}
                  type="button"
                  aria-current={activeView === "claims" ? "page" : undefined}
                  onClick={() => onNavigate("claims")}
                >
                  Claims
                </button>
              ) : null}
              {canViewHighLevel ? (
                <button
                  className={`nav-tab ${activeView === "high-level" ? "nav-tab-active" : ""}`}
                  type="button"
                  aria-current={activeView === "high-level" ? "page" : undefined}
                  onClick={() => onNavigate("high-level")}
                >
                  High Level
                </button>
              ) : null}
            </nav>
          </div>

          {activeView === "claims" && canViewClaims ? (
            <div className="header-claim-search-host" id="claim-header-search-host" aria-label="Claim lookup" />
          ) : null}

          <div className="header-user" aria-label="Current session">
            <div className="avatar" aria-hidden="true">{userInitials(user)}</div>
            <span className="user-name">{user?.name || user?.email || "SSO user"}</span>
            <a className="logout-button" href={pathWithinApp("/auth/logout")}>Sign out</a>
          </div>
        </div>
      </header>

      <main id="main-content">{children}</main>
    </div>
  );
}
