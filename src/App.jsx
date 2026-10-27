import { useEffect, useState } from "react";
import { AppShell } from "./components/AppShell.jsx";
import { ClaimSearchPage } from "./features/claims/ClaimSearchPage.jsx";
import { HighLevelPage } from "./features/highLevel/HighLevelPage.jsx";
import { pathWithinApp } from "./lib/appPath.js";
import { appViewFromLocation } from "./lib/appView.js";

export default function App() {
  const [activeView, setActiveView] = useState(appViewFromLocation);
  const [session, setSession] = useState({ status: "loading", user: null, message: "" });

  useEffect(() => {
    const controller = new AbortController();

    async function loadSession() {
      try {
        const response = await fetch(pathWithinApp("/api/auth/session"), {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          const loginUrl = new URL(pathWithinApp("/auth/login"), window.location.origin);
          loginUrl.searchParams.set(
            "returnTo",
            `${window.location.pathname}${window.location.search}${window.location.hash}`,
          );
          window.location.replace(loginUrl);
          return;
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          setSession({
            status: "error",
            user: null,
            message: body.message || "Single sign-on could not be completed.",
          });
          return;
        }
        setSession({ status: "authenticated", user: body.user, message: "" });
      } catch (error) {
        if (error.name !== "AbortError") {
          setSession({
            status: "error",
            user: null,
            message: "The authentication service could not be reached.",
          });
        }
      }
    }

    loadSession();
    return () => controller.abort();
  }, []);

  const permissions = session.user?.permissions || {};
  const canViewClaims = Boolean(
    permissions.claimOverview
    || permissions.paymentsAndEra
    || permissions.supportingRecords,
  );
  const canViewHighLevel = Boolean(permissions.highLevelOperations);

  useEffect(() => {
    if (session.status !== "authenticated") return;
    if (activeView === "high-level" && !canViewHighLevel && canViewClaims) {
      window.location.hash = "claims";
      setActiveView("claims");
    } else if (activeView === "claims" && !canViewClaims && canViewHighLevel) {
      window.location.hash = "high-level";
      setActiveView("high-level");
    }
  }, [activeView, canViewClaims, canViewHighLevel, session.status]);

  useEffect(() => {
    const syncView = () => setActiveView(appViewFromLocation());
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  function navigate(view) {
    window.location.hash = view === "high-level" ? "high-level" : "claims";
    setActiveView(view);
  }

  if (session.status !== "authenticated") {
    return (
      <main className="session-gate" aria-live="polite">
        <div className="session-gate-card">
          <span className="wordmark-mark" aria-hidden="true">UT</span>
          <p className="eyebrow">United Theranostics</p>
          <h1>{session.status === "loading" ? "Connecting to single sign-on" : "Unable to sign in"}</h1>
          <p>
            {session.status === "loading"
              ? "Checking your secure session…"
              : session.message}
          </p>
          {session.status === "error" ? (
            <a className="primary-button session-gate-action" href={pathWithinApp("/auth/login")}>Try sign-in again</a>
          ) : null}
        </div>
      </main>
    );
  }

  if (!canViewClaims && !canViewHighLevel) {
    return (
      <main className="session-gate" aria-live="polite">
        <div className="session-gate-card">
          <span className="wordmark-mark" aria-hidden="true">UT</span>
          <p className="eyebrow">United Theranostics</p>
          <h1>Access unavailable</h1>
          <p>Your account is signed in but has no Claim Lifecycle permissions.</p>
          <a className="primary-button session-gate-action" href={pathWithinApp("/auth/logout")}>Sign out</a>
        </div>
      </main>
    );
  }

  return (
    <AppShell
      activeView={activeView}
      onNavigate={navigate}
      permissions={permissions}
      user={session.user}
    >
      {activeView === "high-level"
        ? <HighLevelPage />
        : <ClaimSearchPage permissions={permissions} />}
    </AppShell>
  );
}
