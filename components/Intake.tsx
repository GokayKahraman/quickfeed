"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Credentials, LoadProgress } from "../lib/types";
import { formatBytes, formatCount } from "../lib/engine";
import TransformDemo from "./TransformDemo";

interface Props {
  busy: boolean;
  progress: LoadProgress | null;
  error: string | null;
  indent: string;
  collapseText: boolean;
  onIndentChange: (v: string) => void;
  onCollapseChange: (v: boolean) => void;
  onFile: (file: File) => void;
  onUrl: (url: string, viaProxy: boolean, credentials?: Credentials) => void;
  onCancel: () => void;
}

const PHASE_LABEL: Record<LoadProgress["phase"], string> = {
  download: "Downloading",
  format: "Formatting",
  query: "Querying",
};

/** App-owned query keys that may follow an unencoded feed URL. */
const APP_QUERY_KEYS = ["fetch"];

/**
 * Read `feedlink` even when the nested feed URL was not encoded.
 * `URLSearchParams` stops at the first `&`, so
 * `?feedlink=https://host/path?a=1&type=xml` would otherwise yield only
 * `https://host/path?a=1`.
 */
function readFeedlinkParam(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const marker = raw.startsWith("feedlink=")
    ? "feedlink="
    : raw.includes("&feedlink=")
      ? "&feedlink="
      : null;
  if (!marker) return "";

  const after = raw.slice(raw.indexOf(marker) + marker.length);
  const reserved = APP_QUERY_KEYS.join("|");
  const cut = after.search(new RegExp(`&(?:${reserved})=`, "i"));
  const value = cut === -1 ? after : after.slice(0, cut);

  try {
    return decodeURIComponent(value.replace(/\+/g, " ")).trim();
  } catch {
    return value.trim();
  }
}

/**
 * Credentials a feed host handed out inside the address, as
 * `https://user:pass@host/feed.xml`.
 *
 * Pasted whole, that address would sit in a text field in plain sight and go
 * back out in any link the user copies. Lifting the pair into the sign-in
 * fields keeps the password out of the box that gets shared, and saves the
 * user from picking the URL apart by hand.
 */
function splitUserInfo(value: string): { url: string; credentials: Credentials | null } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { url: value, credentials: null };
  }
  if (!parsed.username && !parsed.password) return { url: value, credentials: null };

  const credentials = {
    username: safeDecode(parsed.username),
    password: safeDecode(parsed.password),
  };
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.toString(), credentials };
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Does this failure mean the feed wants a sign-in?
 *
 * Matched against the wording in `lib/worker/feed.worker.ts`; the two move
 * together. Worth the coupling — landing on a 401 with the fields still
 * collapsed leaves the user with nothing to act on.
 */
const AUTH_FAILURE = /password protected|username and password|sign-in|refused access/i;

export default function Intake({
  busy,
  progress,
  error,
  indent,
  collapseText,
  onIndentChange,
  onCollapseChange,
  onFile,
  onUrl,
  onCancel,
}: Props) {
  const [mode, setMode] = useState<"file" | "url">("url");
  const [url, setUrl] = useState("");
  const [viaProxy, setViaProxy] = useState(true);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const fetchBtn = useRef<HTMLButtonElement | null>(null);

  /** Takes an address from anywhere, keeping any credentials buried in it. */
  const acceptUrl = useCallback((value: string) => {
    const { url: clean, credentials } = splitUserInfo(value);
    setUrl(clean);
    if (!credentials) return;
    setNeedsAuth(true);
    setUsername(credentials.username);
    setPassword(credentials.password);
  }, []);

  useEffect(() => {
    const feedlink = readFeedlinkParam(window.location.search);
    if (feedlink) {
      setMode("url");
      acceptUrl(feedlink);
    }
  }, [acceptUrl]);

  /* A 401 arrives with the fields collapsed on the first try. Opening them is
     the only useful thing to do with that answer. */
  useEffect(() => {
    if (error && AUTH_FAILURE.test(error)) setNeedsAuth(true);
  }, [error]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const feedlink = readFeedlinkParam(window.location.search);
    if (!feedlink || params.get("fetch") !== "true") return;
    // Compared against the scrubbed form: a `user:pass@` link has already had
    // its credentials lifted out of the field by the time this runs.
    if (url.trim() !== splitUserInfo(feedlink).url) return;

    const timer = window.setTimeout(() => {
      fetchBtn.current?.click();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [url]);

  /* Credentials are read straight off the fields and handed to the fetch. They
     are never written to storage, to the address bar or to a shareable link —
     when the tab closes, they are gone. */
  const submit = () => {
    const address = url.trim();
    if (!address) return;
    const credentials =
      needsAuth && (username || password) ? { username, password } : undefined;
    onUrl(address, viaProxy, credentials);
  };

  const pct =
    progress && progress.totalBytes
      ? Math.min(100, (progress.bytesRead / progress.totalBytes) * 100)
      : null;

  return (
    <div className="intake">
      <div>
        <p className="eyebrow">Product feed · runs locally</p>
        <h1 className="headline">
          Make the feed readable,
          <br />
          <span>then search inside it.</span>
        </h1>
        <p className="lede">
          Opens XML, JSON and delimited feeds — <code>.csv</code>, <code>.tsv</code> and the
          tab-separated <code>.txt</code> the shopping channels want. Indents the document or
          lays the table out in columns, then filters it by field. The file stays on your
          computer — nothing is uploaded.
        </p>
        <TransformDemo />

        <div className="notes">
          <p className="note">
            <b>01</b>
            <span>
              The file is processed in chunks and written to the browser&apos;s own disk storage,
              so gigabyte feeds open with flat memory use.
            </span>
          </p>
          <p className="note">
            <b>02</b>
            <span>
              The format is read from the bytes, not the file name, so a{" "}
              <code>.txt</code> that is really tab-separated opens as a table. Encoding
              follows the BOM or the XML declaration, and <code>.gz</code> files are
              unwrapped automatically.
            </span>
          </p>
          <p className="note">
            <b>03</b>
            <span>
              If the target site blocks direct reads, the proxy option streams the bytes through
              without parsing or storing them. A feed behind a username and password opens the
              same way — the sign-in is used for that one fetch and never stored.
            </span>
          </p>
        </div>
      </div>

      <div className="card">
        {busy ? (
          <div className="progress">
            <div className="progress-head">
              <b>{progress ? PHASE_LABEL[progress.phase] : "Preparing"}…</b>
              <span>{pct !== null ? `${pct.toFixed(0)}%` : "size unknown"}</span>
            </div>
            <div className={pct === null ? "bar indeterminate" : "bar"}>
              <i style={pct !== null ? { width: `${pct}%` } : undefined} />
            </div>
            <div className="progress-facts">
              <span className="fact">
                <span className="fact-k">read</span>
                <span className="fact-v">{formatBytes(progress?.bytesRead ?? 0)}</span>
              </span>
              <span className="fact">
                <span className="fact-k">lines</span>
                <span className="fact-v">{formatCount(progress?.linesWritten ?? 0)}</span>
              </span>
              <span className="fact">
                <span className="fact-k">records</span>
                <span className="fact-v accent">{formatCount(progress?.records ?? 0)}</span>
              </span>
            </div>
            <button type="button" className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <div className="card-tabs">
              <button
                type="button"
                aria-pressed={mode === "file"}
                onClick={() => setMode("file")}
              >
                From my computer
              </button>
              <button type="button" aria-pressed={mode === "url"} onClick={() => setMode("url")}>
                From a URL
              </button>
            </div>

            {mode === "file" ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".xml,.rss,.atom,.json,.jsonl,.ndjson,.csv,.tsv,.txt,.gz,application/xml,text/xml,application/json,text/csv,text/plain"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onFile(f);
                    e.target.value = "";
                  }}
                />
                <div
                  className={over ? "drop over" : "drop"}
                  role="button"
                  tabIndex={0}
                  onClick={() => fileInput.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(true);
                  }}
                  onDragLeave={() => setOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) onFile(f);
                  }}
                >
                  <strong>Drop the file here</strong>
                  <span>or click to choose one</span>
                  <small>.xml · .json · .csv · .tsv · .txt · .gz — no size limit</small>
                </div>
              </>
            ) : (
              <div className="url-row">
                <input
                  type="url"
                  placeholder="https://example.com/feed.xml"
                  value={url}
                  spellCheck={false}
                  onChange={(e) => acceptUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                  }}
                  aria-label="Feed address"
                />
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={viaProxy}
                    onChange={(e) => setViaProxy(e.target.checked)}
                  />
                  Fetch through proxy (when CORS blocks)
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={needsAuth}
                    onChange={(e) => {
                      setNeedsAuth(e.target.checked);
                      /* A password sent straight from the browser needs the
                         feed host to allow the header in CORS, which almost
                         none do. The proxy is the path that works, so it comes
                         on with the fields — still a switch, still overridable. */
                      if (e.target.checked) setViaProxy(true);
                    }}
                  />
                  This feed needs a sign-in
                </label>

                {needsAuth && (
                  <div className="auth-row">
                    <input
                      type="text"
                      placeholder="username"
                      value={username}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setUsername(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submit();
                      }}
                      aria-label="Feed username"
                    />
                    <span className="auth-reveal">
                      <input
                        type={showPassword ? "text" : "password"}
                        placeholder="password"
                        value={password}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submit();
                        }}
                        aria-label="Feed password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-pressed={showPassword}
                        title={showPassword ? "Hide the password" : "Show the password"}
                      >
                        {showPassword ? "hide" : "show"}
                      </button>
                    </span>
                  </div>
                )}

                {needsAuth && (
                  <p className="auth-note">
                    Sent to the feed host for this one fetch, over the proxy. Not saved,
                    not put in the address bar, and gone when the tab closes.
                  </p>
                )}

                <span style={{ flex: 1 }} />
                <button
                  ref={fetchBtn}
                  type="button"
                  className="btn primary lg"
                  disabled={!url.trim()}
                  onClick={submit}
                >
                  Fetch feed
                </button>
              </div>
            )}

            <div className="opts">
              <span className="opt-label">Indent</span>
              <div className="seg">
                {[
                  { v: "  ", l: "2 spaces" },
                  { v: "    ", l: "4 spaces" },
                  { v: "\t", l: "tab" },
                ].map((o) => (
                  <button
                    key={o.l}
                    type="button"
                    aria-pressed={indent === o.v}
                    onClick={() => onIndentChange(o.v)}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
              <label
                className="toggle"
                title="Keeps long descriptions on a single line. Off by default because it alters the content."
              >
                <input
                  type="checkbox"
                  checked={collapseText}
                  onChange={(e) => onCollapseChange(e.target.checked)}
                />
                Collapse text to one line
              </label>
            </div>

            {error && <p className="alert">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
