import { useEffect, useState } from "react";
import { AppShell } from "./components/AppShell.jsx";
import { ClaimSearchPage } from "./features/claims/ClaimSearchPage.jsx";
import { HighLevelPage } from "./features/highLevel/HighLevelPage.jsx";

function viewFromLocation() {
  return window.location.hash === "#high-level" ? "high-level" : "claims";
}

export default function App() {
  const [activeView, setActiveView] = useState(viewFromLocation);
  const [session, setSession] = useState({ status: "loading", user: null, message: "" });

  useEffect(() => {
    const controller = new AbortController();

    async function loadSession() {
      try {
        const response = await fetch("/api/auth/session", {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          const loginUrl = new URL("/auth/login", window.location.origin);
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

  useEffect(() => {
    const syncView = () => setActiveView(viewFromLocation());
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  function navigate(view) {
    window.location.hash = view === "high-level" ? "high-level" : "";
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
            <a className="primary-button session-gate-action" href="/auth/login">Try sign-in again</a>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <AppShell activeView={activeView} onNavigate={navigate} user={session.user}>
      {activeView === "high-level" ? <HighLevelPage /> : <ClaimSearchPage />}
    </AppShell>
  );
}
