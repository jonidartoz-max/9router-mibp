"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Badge } from "@/shared/components";

/**
 * "Login with browser" for webCookie (chat2api) providers.
 *
 * Flow: open a real browser on the site's login page → the user signs in
 * normally (password / Google / 2FA, all on the site itself) → we poll until the
 * session cookie appears → capture it and hand the ready-to-use credential back
 * to the caller. No cookie hunting, no DevTools.
 */
export default function WebLoginModal({ isOpen, provider, providerName, onCapture, onClose }) {
  const [step, setStep] = useState("idle"); // idle | starting | waiting | capturing | done | error
  const [session, setSession] = useState(null);
  const [loginUrl, setLoginUrl] = useState(null);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [onOauth, setOnOauth] = useState(false);
  const sessionRef = useRef(null);
  const pollRef = useRef(null);
  const capturedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const closeSession = useCallback(async () => {
    const id = sessionRef.current;
    sessionRef.current = null;
    if (!id) return;
    try {
      await fetch("/api/providers/weblogin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close", session: id }),
      });
    } catch {
      /* ignore */
    }
  }, []);

  const doCapture = useCallback(async () => {
    const id = sessionRef.current;
    if (!id || capturedRef.current) return;
    setStep("capturing");
    setError(null);
    try {
      const res = await fetch("/api/providers/weblogin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "capture", session: id }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Capture failed");
        setStep("waiting");
        return;
      }
      capturedRef.current = true;
      setDetail(data.detail || null);
      setStep("done");
      stopPolling();
      await closeSession();
      onCapture?.(data.credential || "", data.name || providerName || provider, data.anonymous);
    } catch (e) {
      setError(e?.message || "Capture failed");
      setStep("waiting");
    }
  }, [provider, providerName, onCapture, closeSession, stopPolling]);

  // Start a browser session when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    capturedRef.current = false;
    setStep("starting");
    setError(null);
    setDetail(null);
    setLoggedIn(false);
    setSession(null);

    (async () => {
      try {
        const res = await fetch("/api/providers/weblogin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start", provider }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || data.error) {
          setError(data.error || "Could not open the browser");
          setStep("error");
          return;
        }
        sessionRef.current = data.session;
        setSession(data.session);
        setLoginUrl(data.loginUrl);
        setStep("waiting");
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || "Could not open the browser");
          setStep("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      stopPolling();
      closeSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, provider]);

  // Poll the session until the site reports a signed-in session.
  useEffect(() => {
    if (step !== "waiting" || !session) return;
    const tick = async () => {
      try {
        const res = await fetch(`/api/providers/weblogin?session=${encodeURIComponent(session)}`);
        const data = await res.json();
        setOnOauth(!!data?.needsHuman);
        if (data?.loggedIn) {
          setLoggedIn(true);
          stopPolling();
          doCapture();
        }
      } catch {
        /* keep polling */
      }
    };
    pollRef.current = setInterval(tick, 2000);
    tick();
    return () => stopPolling();
  }, [step, session, doCapture, stopPolling]);

  const handleClose = () => {
    stopPolling();
    closeSession();
    onClose?.();
  };

  const title = `Login to ${providerName || provider}`;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title}>
      <div className="flex flex-col gap-4">
        {step === "starting" && (
          <div className="flex items-center gap-3 py-6">
            <span className="material-symbols-outlined animate-spin text-primary">progress_activity</span>
            <span className="text-sm text-text-muted">Opening your browser…</span>
          </div>
        )}

        {step === "error" && (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{error}</div>
            <p className="text-xs text-text-muted">
              You can still add the connection by pasting the cookie manually.
            </p>
            <div className="flex gap-2">
              <Button onClick={handleClose} variant="ghost" fullWidth>
                Close
              </Button>
            </div>
          </div>
        )}

        {(step === "waiting" || step === "capturing") && (
          <>
            <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <span className="material-symbols-outlined text-primary">open_in_new</span>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">A browser window just opened.</p>
                <p className="text-xs text-text-muted">
                  Sign in there like you normally would (password, Google, 2FA — all on the site).{" "}
                  This window detects it automatically and grabs the session for you.
                </p>
                {loginUrl && (
                  <a
                    href={loginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Reopen {loginUrl.replace(/^https?:\/\//, "")}
                    <span className="material-symbols-outlined text-[14px]">launch</span>
                  </a>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm">
              {step === "capturing" ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-primary">progress_activity</span>
                  <span className="text-text-muted">Session found — capturing…</span>
                </>
              ) : (
                <>
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex size-2 rounded-full bg-primary" />
                  </span>
                  <span className="text-text-muted">
                    {onOauth
                      ? "Finish signing in (Google/Apple window)…"
                      : loggedIn
                        ? "Sign-in detected…"
                        : "Waiting for you to sign in…"}
                  </span>
                </>
              )}
            </div>

            {error && <p className="text-xs text-red-500 break-words">{error}</p>}

            <div className="flex gap-2">
              <Button onClick={doCapture} variant="secondary" fullWidth disabled={step === "capturing"}>
                {step === "capturing" ? "Capturing…" : "I'm signed in — Capture now"}
              </Button>
              <Button onClick={handleClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}

        {step === "done" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <span className="material-symbols-outlined text-5xl text-green-500">check_circle</span>
            <p className="text-base font-medium">Session captured</p>
            {detail && <Badge variant="success">{detail}</Badge>}
            <p className="text-xs text-text-muted">
              The credential was filled into the form. Review it and press Save.
            </p>
            <Button onClick={handleClose} fullWidth>
              Done
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

WebLoginModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string,
  providerName: PropTypes.string,
  onCapture: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
