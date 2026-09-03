"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Intake from "../components/Intake";
import FindBar from "../components/FindBar";
import QueryBar, { newCondition } from "../components/QueryBar";
import Tape from "../components/Tape";
import DocViewer, { type ViewerApi } from "../components/DocViewer";
import {
  FeedEngine,
  formatBytes,
  formatCount,
  formatMs,
  recordLabel,
  triggerDownload,
} from "../lib/engine";
import { formatLabel } from "../lib/format/detect";
import type { DocSummary, FindMatch, FindOptions, LoadProgress, Query } from "../lib/types";

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
  /** Set when the user rejects the auto-detected record tag. */
  const [recordOverride, setRecordOverride] = useState<string | null>(null);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findOptions, setFindOptions] = useState<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [hits, setHits] = useState<FindMatch[]>([]);
  const [hitTotal, setHitTotal] = useState(0);
  const [hitTruncated, setHitTruncated] = useState(false);
  const [currentHit, setCurrentHit] = useState(0);
  const [searching, setSearching] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);

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
      setRecordOverride(null);
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

  /* The record tag drives the query, the rail count and the tape, so it is
     resolved once here rather than in each of them. */
  const effectiveRecord = recordOverride ?? source?.recordName ?? null;
  const recordInfo = source?.fields.find((f) => f.name === effectiveRecord) ?? null;

  const changeRecord = useCallback(
    (name: string) => {
      setRecordOverride(name);
      // The old result was filtered on a different tag; it no longer applies.
      const engine = engineRef.current;
      if (engine && result) void engine.release(result.id);
      setResult(null);
      setActiveKind("source");
    },
    [result],
  );

  const applyQuery = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !source) return;
    setBusy(true);
    setError(null);
    try {
      const doc = await engine.query(source.id, query, effectiveRecord, setProgress);
      setResult(doc);
      setActiveKind("result");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [source, query, effectiveRecord]);

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
    setRecordOverride(null);
    setQuery({ conditions: [newCondition()], combinator: "AND", caseSensitive: false });
  }, []);

  const queryProgress = busy && progress?.phase === "query" ? progress : null;

  const tapeMatches = useMemo(() => {
    if (!result) return undefined;
    return activeKind === "source" ? result.matchHistogram : undefined;
  }, [result, activeKind]);

  /* Density is captured per nesting level during the format pass, so switching
     the record tag re-points the tape instead of leaving it showing the wrong
     element. Levels deeper than 4 were not captured; the tape keeps its
     original curve there. */
  const tapeHistogram = useMemo(() => {
    if (!source) return [];
    if (activeKind === "result" && result) return result.histogram;
    const depth = recordInfo?.depth ?? -1;
    if (depth >= 1 && depth <= 4 && source.depthHistograms[depth - 1]) {
      return source.depthHistograms[depth - 1];
    }
    return source.histogram;
  }, [source, result, activeKind, recordInfo]);

  /* ------------------------------------------------------------------ find */

  const activeDocId = active?.id ?? null;

  /* Debounced so a long word does not queue one full-document scan per
     keystroke; the worker drops any scan a newer one supersedes. */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !activeDocId || !findOpen) return;
    if (!findQuery) {
      setHits([]);
      setHitTotal(0);
      setHitTruncated(false);
      setFindError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let live = true;
    const timer = setTimeout(() => {
      engine
        .search(activeDocId, findQuery, findOptions)
        .then((res) => {
          if (!live || res.superseded) return;
          setHits(res.matches);
          setHitTotal(res.total);
          setHitTruncated(res.truncated);
          setCurrentHit(0);
          setFindError(null);
          setSearching(false);
          if (res.matches.length > 0) {
            viewerApi.current?.scrollToLine(res.matches[0].line, { center: true });
          }
        })
        .catch((err: Error) => {
          if (!live) return;
          setHits([]);
          setHitTotal(0);
          setFindError(err.message);
          setSearching(false);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [activeDocId, findOpen, findQuery, findOptions]);

  // Switching documents invalidates hit positions.
  useEffect(() => {
    setHits([]);
    setHitTotal(0);
    setCurrentHit(0);
  }, [activeDocId]);

  const stepHit = useCallback(
    (delta: number) => {
      if (hits.length === 0) return;
      const next = (currentHit + delta + hits.length) % hits.length;
      setCurrentHit(next);
      viewerApi.current?.scrollToLine(hits[next].line, { center: true });
    },
    [hits, currentHit],
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setHits([]);
    setHitTotal(0);
    setFindError(null);
  }, []);

  /* Ctrl/Cmd+F is taken over on purpose: the browser's own find can only see
     the ~35 rows the viewer keeps in the DOM. */
  useEffect(() => {
    if (phase !== "viewing") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      } else if (e.key === "Escape" && findOpen) {
        closeFind();
      } else if (e.key === "F3") {
        e.preventDefault();
        stepHit(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, findOpen, closeFind, stepHit]);

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
          onUrl={(url, viaProxy, credentials) =>
            runLoad({ kind: "url", url, viaProxy, credentials })
          }
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
                  {source.recordName && (
                    <em>
                      {" "}
                      {recordLabel(source.format, source.recordName)}
                      {source.format !== "csv" && " · change it in the query bar"}
                    </em>
                  )}
                </dd>
              </div>
              <div>
                <dt>{source.format === "xml" ? "root tag" : "format"}</dt>
                <dd>
                  {source.format === "xml"
                    ? source.rootName
                      ? `<${source.rootName}>`
                      : "—"
                    : formatLabel(source.format, source.delimiter)}
                  {source.format === "csv" && source.columns && (
                    <em> {source.columns.length} columns</em>
                  )}
                </dd>
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
            <span className="fact-k">{recordLabel(doc.format, effectiveRecord)}</span>
            <span className="fact-v accent">
              {formatCount(
                activeKind === "result" ? doc.recordCount : (recordInfo?.count ?? doc.recordCount),
              )}
            </span>
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
        recordName={effectiveRecord}
        recordAuto={source.recordAuto}
        recordCandidates={source.recordCandidates}
        recordCount={recordInfo?.count ?? 0}
        onRecordChange={changeRecord}
        format={source.format}
      />

      {queryProgress && (
        <div className="bar indeterminate" style={{ flex: "0 0 3px" }}>
          <i />
        </div>
      )}

      <Tape
        histogram={tapeHistogram}
        matchHistogram={tapeMatches}
        lineCount={doc.lineCount}
        firstLine={viewport.first}
        visibleLines={viewport.visible}
        recordName={effectiveRecord}
        format={source.format}
        onSeek={(line) => viewerApi.current?.scrollToLine(line)}
      />

      <div className="viewer-shell">
        {findOpen && (
          <FindBar
            query={findQuery}
            onQueryChange={setFindQuery}
            options={findOptions}
            onOptionsChange={setFindOptions}
            total={hitTotal}
            truncated={hitTruncated}
            current={currentHit}
            searching={searching}
            error={findError}
            onStep={stepHit}
            onClose={closeFind}
          />
        )}
        <DocViewer
          engine={engineRef.current!}
          docId={doc.id}
          lineCount={doc.lineCount}
          apiRef={viewerApi}
          onViewport={onViewport}
          hits={hits}
          currentHit={currentHit}
          format={doc.format}
          delimiter={doc.delimiter}
          columns={doc.columns}
          emptyMessage={{
            title: "No matching records",
            detail: `Loosen the condition, or check the ${
              doc.format === "csv" ? "column" : doc.format === "json" ? "key" : "tag"
            } name.`,
          }}
        />
      </div>

      <footer className="status">
        <span>
          lines {formatCount(viewport.first + 1)}–
          {formatCount(Math.min(doc.lineCount, viewport.first + viewport.visible))}
        </span>
        <span>{formatCount(doc.recordCount)} records</span>
        {result && activeKind === "source" && (
          <span className="live">◆ {formatCount(result.recordCount)} matches marked</span>
        )}
        {findOpen && hitTotal > 0 && (
          <span className="live">
            ⌕ {formatCount(hitTotal)}{hitTruncated ? "+" : ""} hits
          </span>
        )}
        <span className="spacer" />
        {error && <span className="warnish">{error}</span>}
        <span className={doc.persistent ? "" : "warnish"}>
          {doc.persistent ? "browser disk" : "memory mode"}
        </span>
        <span className="narrow-hide">{formatMs(doc.elapsedMs)}</span>
      </footer>
    </div>
  );
}
