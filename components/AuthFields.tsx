"use client";

import { useState } from "react";
import type { AuthType, FeedAuth } from "../lib/types";

interface Props {
  value: FeedAuth;
  onChange: (v: FeedAuth) => void;
  /** Enter anywhere in the fields runs the fetch. */
  onSubmit?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

const TYPES: { v: AuthType; l: string }[] = [
  { v: "none", l: "No auth" },
  { v: "basic", l: "Basic auth" },
  { v: "bearer", l: "Bearer token" },
  { v: "apikey", l: "API key" },
];

/** A fresh, empty value of the chosen kind. */
export function emptyAuth(type: AuthType): FeedAuth {
  switch (type) {
    case "basic":
      return { type: "basic", username: "", password: "" };
    case "bearer":
      return { type: "bearer", token: "" };
    case "apikey":
      return { type: "apikey", key: "", value: "", in: "header" };
    default:
      return { type: "none" };
  }
}

/** Is there enough here to be worth sending? */
export function authIsFilled(auth: FeedAuth): boolean {
  switch (auth.type) {
    case "basic":
      return auth.username.trim().length > 0;
    case "bearer":
      return auth.token.trim().length > 0;
    case "apikey":
      return auth.key.trim().length > 0 && auth.value.trim().length > 0;
    default:
      return false;
  }
}

/**
 * The sign-in, in whichever of the four shapes the feed wants.
 *
 * The picker exists because the answer usually cannot be worked out: a host
 * that sends `WWW-Authenticate` names its scheme and the app selects it, but
 * feed APIs routinely send a bare 401 or 403, and a bearer token or an API key
 * announces itself in no response at all. So the app detects what it can and
 * asks for the rest, rather than guessing and failing in a way that reads like
 * a wrong password.
 *
 * Shared by the intake form and the prompt raised on a 401, so a sign-in
 * entered up front and one entered after being asked are the same thing.
 */
export default function AuthFields({ value, onChange, onSubmit, disabled, autoFocus }: Props) {
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onSubmit?.();
  };

  return (
    <div className="auth-block">
      <label className="auth-pick">
        <span className="opt-label">Auth</span>
        <select
          value={value.type}
          disabled={disabled}
          onChange={(e) => onChange(emptyAuth(e.target.value as AuthType))}
          aria-label="Authentication type"
        >
          {TYPES.map((t) => (
            <option key={t.v} value={t.v}>
              {t.l}
            </option>
          ))}
        </select>
      </label>

      {value.type === "basic" && (
        <div className="auth-row">
          <input
            type="text"
            placeholder="username"
            value={value.username}
            spellCheck={false}
            autoComplete="off"
            autoFocus={autoFocus}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, username: e.target.value })}
            onKeyDown={enter}
            aria-label="Feed username"
          />
          <Secret
            label="Feed password"
            placeholder="password"
            value={value.password}
            disabled={disabled}
            onChange={(v) => onChange({ ...value, password: v })}
            onKeyDown={enter}
          />
        </div>
      )}

      {value.type === "bearer" && (
        <Secret
          label="Bearer token"
          placeholder="token"
          value={value.token}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(v) => onChange({ ...value, token: v })}
          onKeyDown={enter}
        />
      )}

      {value.type === "apikey" && (
        <>
          <div className="auth-row">
            <input
              type="text"
              placeholder="key"
              value={value.key}
              spellCheck={false}
              autoComplete="off"
              autoFocus={autoFocus}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, key: e.target.value })}
              onKeyDown={enter}
              aria-label="API key name"
            />
            <Secret
              label="API key value"
              placeholder="value"
              value={value.value}
              disabled={disabled}
              onChange={(v) => onChange({ ...value, value: v })}
              onKeyDown={enter}
            />
          </div>
          <label className="auth-pick">
            <span className="opt-label">Add to</span>
            <select
              value={value.in}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, in: e.target.value as "header" | "query" })}
              aria-label="Where to put the API key"
            >
              <option value="header">Header</option>
              <option value="query">Query params</option>
            </select>
          </label>
        </>
      )}
    </div>
  );
}

/** A field that starts masked, with the reveal the user needs to check a typo. */
function Secret({
  label,
  placeholder,
  value,
  disabled,
  autoFocus,
  onChange,
  onKeyDown,
}: {
  label: string;
  placeholder: string;
  value: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <span className="auth-reveal">
      <input
        type={shown ? "text" : "password"}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label={label}
      />
      <button
        type="button"
        disabled={disabled}
        aria-pressed={shown}
        onClick={() => setShown((v) => !v)}
        title={shown ? `Hide the ${label.toLowerCase()}` : `Show the ${label.toLowerCase()}`}
      >
        {shown ? "hide" : "show"}
      </button>
    </span>
  );
}
