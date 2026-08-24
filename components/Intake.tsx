"use client";

import { useRef, useState } from "react";
import type { LoadProgress } from "../lib/types";
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
  onUrl: (url: string, viaProxy: boolean) => void;
  onCancel: () => void;
}

const PHASE_LABEL: Record<LoadProgress["phase"], string> = {
  download: "Downloading",
  format: "Formatting",
  query: "Querying",
};

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
  const [mode, setMode] = useState<"file" | "url">("file");
  const [url, setUrl] = useState("");
  const [viaProxy, setViaProxy] = useState(false);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const pct =
    progress && progress.totalBytes
      ? Math.min(100, (progress.bytesRead / progress.totalBytes) * 100)
      : null;

  return (
    <div className="intake">
      <div>
        <p className="eyebrow">XML feed · runs locally</p>
        <h1 className="headline">
          Make the feed readable,
          <br />
          <span>then search inside it.</span>
        </h1>
        <p className="lede">
          Turns a product feed squeezed onto a single line into indented XML, opens it in the
          browser, and filters it with tag-based queries. The file stays on your computer —
          nothing is uploaded.
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
              Encoding is read from the <code>.xml</code> declaration, so ISO-8859-9 and
              windows-1254 feeds keep their accented characters. <code>.gz</code> files are
              unwrapped automatically.
            </span>
          </p>
          <p className="note">
            <b>03</b>
            <span>
              If the target site blocks direct reads, the proxy option streams the bytes through
              without parsing or storing them.
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
                  accept=".xml,.rss,.atom,.txt,.gz,application/xml,text/xml"
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
                  <small>.xml · .rss · .atom · .xml.gz — no size limit</small>
                </div>
              </>
            ) : (
              <div className="url-row">
                <input
                  type="url"
                  placeholder="https://example.com/feed.xml"
                  value={url}
                  spellCheck={false}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && url.trim()) onUrl(url.trim(), viaProxy);
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
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn primary lg"
                  disabled={!url.trim()}
                  onClick={() => onUrl(url.trim(), viaProxy)}
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
