"use client";

import { useEffect, useState } from "react";
import type { AuthChallenge, FeedAuth } from "../lib/types";
import AuthFields, { authIsFilled, emptyAuth } from "./AuthFields";

interface Props {
  /** The address that asked; shown so the user knows what they are signing in to. */
  url: string;
  challenge: AuthChallenge;
  busy: boolean;
  onSubmit: (auth: FeedAuth) => void;
  onCancel: () => void;
}

const SCHEME_NAME = {
  none: "no sign-in",
  basic: "a username and password",
  bearer: "a bearer token",
  apikey: "an API key",
} as const;

/** Host and path, without the scheme — the part worth reading back. */
function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * The sign-in the feed asked for, put in front of the user so the fetch can be
 * run again.
 *
 * It opens on the answer to a real request, not on a guess, so it can say
 * which address is asking and — when the host named a realm — which login of
 * theirs it wants. Everything else about the fetch is held by the caller and
 * replayed unchanged; all this collects is the pair.
 */
export default function SignInPrompt({ url, challenge, busy, onSubmit, onCancel }: Props) {
  /* Start on what the host named, and on Basic when it named nothing — the
     common shape, and the one the user can correct in a click if it is wrong. */
  const [auth, setAuth] = useState<FeedAuth>(() =>
    emptyAuth(challenge.suggested ?? challenge.attempted ?? "basic"),
  );

  /* Escape closes it. Nothing here is worth trapping the user in. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const ready = authIsFilled(auth);
  const submit = () => {
    if (busy || !ready) return;
    onSubmit(auth);
  };

  return (
    <div className="signin-scrim" role="presentation" onMouseDown={() => !busy && onCancel()}>
      <div
        className="signin"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="eyebrow">Sign in required</p>
        <h2 id="signin-title" className="signin-title">
          {challenge.rejected ? "That sign-in was refused" : "This feed asks for a sign-in"}
        </h2>

        <p className="signin-target">{describeTarget(url)}</p>
        {challenge.realm && (
          <p className="signin-realm">
            The host calls this area <b>{challenge.realm}</b>.
          </p>
        )}
        <p className="signin-realm">
          {challenge.suggested ? (
            <>
              The host asked for <b>{SCHEME_NAME[challenge.suggested]}</b>.
            </>
          ) : (
            <>The host did not say which kind it wants — pick the one you were given.</>
          )}
        </p>

        <div className="signin-fields">
          <AuthFields
            value={auth}
            onChange={setAuth}
            onSubmit={submit}
            disabled={busy}
            autoFocus
          />
        </div>

        <p className="auth-note">
          {challenge.rejected
            ? "The address itself was reached, so only the sign-in is in question — correct it, or try a different kind."
            : "Used for this one fetch. Not saved, not put in the address bar, and gone when the tab closes."}
        </p>

        <div className="signin-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy || !ready}>
            {busy ? "Signing in…" : "Sign in and fetch"}
          </button>
        </div>
      </div>
    </div>
  );
}
