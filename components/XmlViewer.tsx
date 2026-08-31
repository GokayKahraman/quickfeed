"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { FeedEngine } from "../lib/engine";
import { formatCount } from "../lib/engine";
import { applyHits, highlightLine } from "./highlight";
import type { FindMatch } from "../lib/types";

export interface ViewerApi {
  scrollToLine: (line: number, opts?: { center?: boolean }) => void;
}

interface Props {
  engine: FeedEngine;
  docId: string;
  lineCount: number;
  apiRef: React.RefObject<ViewerApi | null>;
  onViewport: (first: number, visible: number) => void;
  emptyMessage?: { title: string; detail: string };
  /** Find hits for this document, ordered by line then column. */
  hits?: FindMatch[];
  /** Index into `hits` of the one currently stepped to. */
  currentHit?: number;
}

const LINE_H = 20;
/** Lines fetched per request; also the cache granularity. */
const WINDOW = 256;
const CACHE_MAX = 64;
/**
 * Browsers stop tracking scroll offsets somewhere past 33 M pixels. Beyond
 * this, the scrollbar becomes a proportional control rather than a 1:1 one —
 * which is all it can be for a document of tens of millions of lines anyway.
 */
const MAX_SCROLL_PX = 8_000_000;

/** First index whose line is >= `line`. */
function lowerBound(hits: FindMatch[], line: number): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].line < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function useLineCache(engine: FeedEngine, docId: string, first: number, rows: number) {
  const cache = useRef(new Map<number, string[]>());
  const inflight = useRef(new Set<number>());
  const [, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    cache.current.clear();
    inflight.current.clear();
    bump();
  }, [docId]);

  const firstWin = Math.floor(first / WINDOW);
  const lastWin = Math.floor((first + rows) / WINDOW);

  useEffect(() => {
    let live = true;
    for (let w = firstWin; w <= lastWin; w++) {
      if (cache.current.has(w) || inflight.current.has(w)) continue;
      inflight.current.add(w);
      engine
        .lines(docId, w * WINDOW, WINDOW)
        .then((lines) => {
          if (!live) return;
          inflight.current.delete(w);
          cache.current.set(w, lines);
          if (cache.current.size > CACHE_MAX) {
            for (const key of cache.current.keys()) {
              if (key < firstWin - 2 || key > lastWin + 2) {
                cache.current.delete(key);
                break;
              }
            }
          }
          bump();
        })
        .catch(() => {
          inflight.current.delete(w);
        });
    }
    return () => {
      live = false;
    };
  }, [engine, docId, firstWin, lastWin]);

  return (index: number): string | null => {
    const win = cache.current.get(Math.floor(index / WINDOW));
    if (!win) return null;
    return win[index % WINDOW] ?? "";
  };
}

/**
 * Windowed XML reader.
 *
 * Only the visible rows exist in the DOM, and only the visible rows are ever
 * pulled out of the worker — so scrolling a 40-million-line document costs the
 * same as scrolling a 40-line one.
 */
export default function XmlViewer({
  engine,
  docId,
  lineCount,
  apiRef,
  onViewport,
  emptyMessage,
  hits,
  currentHit = -1,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [docId]);

  const rows = Math.max(1, Math.ceil(height / LINE_H) + 1);
  const totalPx = Math.max(height, Math.min(lineCount * LINE_H, MAX_SCROLL_PX));
  const maxScroll = Math.max(0, totalPx - height);
  const maxFirst = Math.max(0, lineCount - rows + 1);
  const first =
    maxScroll > 0 ? Math.min(maxFirst, Math.round((scrollTop / maxScroll) * maxFirst)) : 0;

  const getLine = useLineCache(engine, docId, first, rows);

  useEffect(() => {
    apiRef.current = {
      scrollToLine: (line: number, opts) => {
        const el = scrollerRef.current;
        if (!el) return;
        // Stepping through find hits reads better with the hit in the middle
        // than pinned to the top edge.
        const wanted = opts?.center ? line - Math.floor(rows / 2) : line;
        const clamped = Math.max(0, Math.min(wanted, maxFirst));
        const target = maxFirst > 0 ? (clamped / maxFirst) * maxScroll : 0;
        el.scrollTop = target;
        setScrollTop(target);
      },
    };
  }, [apiRef, maxFirst, maxScroll, rows]);

  useEffect(() => {
    onViewport(first, Math.min(rows, lineCount));
  }, [first, rows, lineCount, onViewport]);

  // Hits arrive sorted, so the window's slice is one binary search away
  // rather than a scan of what may be twenty thousand entries.
  const hitStart = hits && hits.length > 0 ? lowerBound(hits, first) : 0;

  const visible: React.ReactNode[] = [];
  for (let i = first; i < Math.min(lineCount, first + rows); i++) {
    const text = getLine(i);
    let spans = text === null ? null : highlightLine(text);
    if (spans && hits) {
      const lineHits: { col: number; len: number; current: boolean }[] = [];
      for (let h = hitStart; h < hits.length && hits[h].line <= i; h++) {
        if (hits[h].line === i) {
          lineHits.push({ col: hits[h].col, len: hits[h].len, current: h === currentHit });
        }
      }
      if (lineHits.length > 0) spans = applyHits(spans, lineHits);
    }
    visible.push(
      <div className={text === null ? "row pending" : "row"} key={i}>
        <span className="no">{formatCount(i + 1)}</span>
        <span className="code">
          {spans === null
            ? "···"
            : spans.map((s, k) => (
                <span className={s.c} key={k}>
                  {s.t}
                </span>
              ))}
        </span>
      </div>,
    );
  }

  return (
    <div
      className="viewer"
      ref={scrollerRef}
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className="viewer-canvas" style={{ height: totalPx }} />
      {lineCount === 0 ? (
        <div className="empty-view">
          <strong>{emptyMessage?.title ?? "This document is empty"}</strong>
          <span>{emptyMessage?.detail ?? ""}</span>
        </div>
      ) : (
        <div className="viewer-window" style={{ top: scrollTop }}>
          {visible}
        </div>
      )}
    </div>
  );
}
