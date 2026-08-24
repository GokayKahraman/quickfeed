"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Intake from "../components/Intake";
import QueryBar, { newCondition } from "../components/QueryBar";
import Tape from "../components/Tape";
import XmlViewer, { type ViewerApi } from "../components/XmlViewer";
import { FeedEngine, formatBytes, formatCount, formatMs, triggerDownload } from "../lib/engine";
import type { DocSummary, LoadProgress, Query } from "../lib/types";

type Phase = "intake" | "ready" | "viewing";

export default function Page() {
  const engineRef = useRef<FeedEngine | null>(null);
  const viewerApi = useRef<ViewerApi | null>(null);

  const [phase, setPhase] = useState<Phase>("intake");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [source, setSource] = useState<DocSummary | null>(null);
  const [result, setResult] = useState<DocSummary | null>(null);
  const [activeKind, setActiveKind] = useState<"source" | "result">("source");

  const [indent, setIndent] = useState("    ");
  const [collapseText, setCollapseText] = useState(false);
  const [query, setQuery] = useState<Query>(() => ({
    conditions: [newCondition()],
    combinator: "AND",
    caseSensitive: false,
  }));
  const [viewport, setViewport] = useState({ first: 0, visible: 0 });

  useEffect(() => {
    const engine = new FeedEngine();
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const active = activeKind === "result" && result ? result : source;

  const onViewport = useCallback((first: number, visible: number) => {
    setViewport((prev) =>
      prev.first === first && prev.visible === visible ? prev : { first, visible },
    );
  }, []);

  const runLoad = useCallback(
    async (source_: Parameters<FeedEngine["load"]>[0]) => {
      const engine = engineRef.current;
      if (!engine) return;
      setBusy(true);
      setError(null);
      setProgress(null);
      setResult(null);
      setActiveKind("source");
      try {
        const doc = await engine.load(source_, { indent, collapseText }, setProgress);
        setSource(doc);
        setPhase("ready");
      } catch (err) {
        setError((err as Error).message);
        setPhase("intake");
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [indent, collapseText],
  );

  const applyQuery = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !source) return;
    setBusy(true);
    setError(null);
    try {
      const doc = await engine.query(source.id, query, setProgress);
      setResult(doc);
      setActiveKind("result");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [source, query]);

  const clearQuery = useCallback(() => {
    const engine = engineRef.current;
    if (engine && result) void engine.release(result.id);
    setResult(null);
    setActiveKind("source");
  }, [result]);

  const download = useCallback(async (doc: DocSummary | null) => {
    const engine = engineRef.current;
    if (!engine || !doc) return;
    try {
      const { blob, fileName } = await engine.snapshot(doc.id);
      triggerDownload(blob, fileName);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const reset = useCallback(() => {
    setSource(null);
    setResult(null);
    setPhase("intake");
    setError(null);
    setQuery({ conditions: [newCondition()], combinator: "AND", caseSensitive: false });
  }, []);

  const queryProgress = busy && progress?.phase === "query" ? progress : null;

  const tapeMatches = useMemo(() => {
    if (!result) return undefined;
    return activeKind === "source" ? result.matchHistogram : undefined;
  }, [result, activeKind]);

  /* ---------------------------------------------------------------- intake */

  if (phase === "intake" || !source) {
    return (
      <div className="shell">
        <header className="rail">
          <span className="wordmark">
            QUICK<em>FEED</em>
          </span>
          <span className="rail-note">runs in your browser · nothing is uploaded</span>
        </header>
        <Intake
          busy={busy}
          progress={progress}
          error={error}
          indent={indent}
          collapseText={collapseText}
          onIndentChange={setIndent}
          onCollapseChange={setCollapseText}
          onFile={(file) => runLoad({ kind: "file", file })}
          onUrl={(url, viaProxy) => runLoad({ kind: "url", url, viaProxy })}
          onCancel={() => engineRef.current?.cancel()}
        />
      </div>
    );
  }

  /* ----------------------------------------------------------------- ready */

  if (phase === "ready") {
    const grew =
      source.sourceBytes && source.sourceBytes > 0
        ? (source.byteLength / source.sourceBytes - 1) * 100
        : null;
    return (
      <div className="shell">
        <header className="rail">
          <span className="wordmark">
            QUICK<em>FEED</em>
          </span>
          <span className="rail-note">formatting complete</span>
        </header>

        <div className="ready-wrap">
          <div className="card ready">
            <p className="eyebrow">Ready</p>
            <h2 className="ready-name">{source.label}</h2>

            <dl className="ready-grid">
              <div>
                <dt>source</dt>
                <dd>{formatBytes(source.sourceBytes ?? 0)}</dd>
              </div>
              <div>
                <dt>formatted</dt>
                <dd>
                  {formatBytes(source.byteLength)}
                  {grew !== null && <em> {grew >= 0 ? "+" : ""}{grew.toFixed(0)}%</em>}
                </dd>
              </div>
              <div>
                <dt>lines</dt>
                <dd>{formatCount(source.lineCount)}</dd>
              </div>
              <div>
                <dt>records</dt>
                <dd className="accent">
                  {formatCount(source.recordCount)}
                  {source.recordName && <em> &lt;{source.recordName}&gt;</em>}
                </dd>
              </div>
              <div>
                <dt>root tag</dt>
                <dd>{source.rootName ? `<${source.rootName}>` : "—"}</dd>
              </div>
              <div>
                <dt>time</dt>
                <dd>{formatMs(source.elapsedMs)}</dd>
              </div>
            </dl>

            <div className="ready-actions">
              <button type="button" className="btn primary lg" onClick={() => setPhase("viewing")}>
                View in browser
              </button>
              <button type="button" className="btn lg" onClick={() => download(source)}>
                ↓ Download formatted file
              </button>
            </div>

            <p className="ready-foot">
              {source.persistent
                ? "The file is kept in the browser’s own disk storage and is deleted when you close the tab."
                : "This browser has no disk storage available, so the document is held in memory — very large files may strain the tab."}
            </p>
            <button type="button" className="btn ghost" onClick={reset}>
              Choose another file
            </button>
            {error && <p className="alert">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  /* --------------------------------------------------------------- viewing */

  const doc = active!;

  return (
    <div className="shell">
      <header className="rail">
        <span className="wordmark">
          QUICK<em>FEED</em>
        </span>

        {result && (
          <div className="seg">
            <button
              type="button"
              aria-pressed={activeKind === "source"}
              onClick={() => setActiveKind("source")}
            >
              Source
            </button>
            <button
              type="button"
              aria-pressed={activeKind === "result"}
              onClick={() => setActiveKind("result")}
            >
              Result · {formatCount(result.recordCount)}
            </button>
          </div>
        )}

        <div className="facts">
          <span className="fact">
            <span className="fact-k">document</span>
            <span className="fact-v" title={doc.label}>
              {doc.label}
            </span>
          </span>
          <span className="fact">
            <span className="fact-k">size</span>
            <span className="fact-v">{formatBytes(doc.byteLength)}</span>
          </span>
          <span className="fact">
            <span className="fact-k">lines</span>
            <span className="fact-v">{formatCount(doc.lineCount)}</span>
          </span>
          <span className="fact">
            <span className="fact-k">{doc.recordName ? `<${doc.recordName}>` : "records"}</span>
            <span className="fact-v accent">{formatCount(doc.recordCount)}</span>
          </span>
        </div>

        <span className="rail-spacer" />
        <button type="button" className="btn" onClick={() => download(doc)}>
          ↓ {activeKind === "result" ? "Download result" : "Download this file"}
        </button>
        <button type="button" className="btn ghost" onClick={reset}>
          New file
        </button>
      </header>

      <QueryBar
        query={query}
        onChange={setQuery}
        onApply={applyQuery}
        onClear={clearQuery}
        onDownloadResult={() => download(result)}
        fields={source.fields}
        result={result}
        busy={busy}
        recordName={source.recordName}
      />

      {queryProgress && (
        <div className="bar indeterminate" style={{ flex: "0 0 3px" }}>
          <i />
        </div>
      )}

      <Tape
        histogram={doc.histogram}
        matchHistogram={tapeMatches}
        lineCount={doc.lineCount}
        firstLine={viewport.first}
        visibleLines={viewport.visible}
        recordName={doc.recordName}
        onSeek={(line) => viewerApi.current?.scrollToLine(line)}
      />

      <XmlViewer
        engine={engineRef.current!}
        docId={doc.id}
        lineCount={doc.lineCount}
        apiRef={viewerApi}
        onViewport={onViewport}
        emptyMessage={{
          title: "No matching records",
          detail: "Loosen the condition, or check the tag name.",
        }}
      />

      <footer className="status">
        <span>
          lines {formatCount(viewport.first + 1)}–
          {formatCount(Math.min(doc.lineCount, viewport.first + viewport.visible))}
        </span>
        <span>{formatCount(doc.recordCount)} records</span>
        {result && activeKind === "source" && (
          <span className="live">◆ {formatCount(result.recordCount)} matches marked</span>
        )}
        <span className="spacer" />
        {error && <span className="warnish">{error}</span>}
        <span className={doc.persistent ? "" : "warnish"}>
          {doc.persistent ? "browser disk" : "memory mode"}
        </span>
        <span>{formatMs(doc.elapsedMs)}</span>
      </footer>
    </div>
  );
}
