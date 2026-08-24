"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { FeedEngine } from "../lib/engine";
import { formatCount } from "../lib/engine";
import { highlightLine } from "./highlight";

export interface ViewerApi {
  scrollToLine: (line: number) => void;
}

interface Props {
  engine: FeedEngine;
  docId: string;
  lineCount: number;
  apiRef: React.RefObject<ViewerApi | null>;
  onViewport: (first: number, visible: number) => void;
  emptyMessage?: { title: string; detail: string };
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
      scrollToLine: (line: number) => {
        const el = scrollerRef.current;
        if (!el) return;
        const target = maxFirst > 0 ? (Math.min(line, maxFirst) / maxFirst) * maxScroll : 0;
        el.scrollTop = target;
        setScrollTop(target);
      },
    };
  }, [apiRef, maxFirst, maxScroll]);

  useEffect(() => {
    onViewport(first, Math.min(rows, lineCount));
  }, [first, rows, lineCount, onViewport]);

  const visible: React.ReactNode[] = [];
  for (let i = first; i < Math.min(lineCount, first + rows); i++) {
    const text = getLine(i);
    visible.push(
      <div className={text === null ? "row pending" : "row"} key={i}>
        <span className="no">{formatCount(i + 1)}</span>
        <span className="code">
          {text === null
            ? "···"
            : highlightLine(text).map((s, k) => (
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
