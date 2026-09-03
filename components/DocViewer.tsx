"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { FeedEngine } from "../lib/engine";
import { formatCount } from "../lib/engine";
import { applyHits, highlightLine, type Span } from "./highlight";
import { splitLine, toCellOffset, type Cell } from "../lib/csv/tokenizer";
import type { ColumnInfo, FeedFormat, FindMatch } from "../lib/types";

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
  format?: FeedFormat;
  /** Field separator, when the document is a table. */
  delimiter?: string;
  /** Column names and widths, when the document is a table. */
  columns?: ColumnInfo[];
}

const LINE_H = 20;
/** Lines fetched per request; also the cache granularity. */
const WINDOW = 256;
const CACHE_MAX = 64;
/** Width used for a cell the header never named. */
const ORPHAN_COL_WIDTH = 14;
/** Line-number gutter plus the row's left padding. */
const GUTTER_PX = 92;
/** Breathing room after the last column, matching `.row .cells`. */
const ROW_END_PAD = 32;
/**
 * Browsers stop tracking scroll offsets somewhere past 33 M pixels. Beyond
 * this, the scrollbar becomes a proportional control rather than a 1:1 one —
 * which is all it can be for a document of tens of millions of lines anyway.
 */
const MAX_SCROLL_PX = 8_000_000;

type LineHit = { col: number; len: number; current: boolean };

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
 * Narrows the line's hits to one cell and rebases them onto the text the cell
 * actually draws.
 *
 * The cell is drawn without its quoting, so a hit at raw column 40 may sit at
 * character 33 of what the reader sees. `toCellOffset` performs that shift; the
 * clamping either side is for a hit that starts in the quoting itself.
 */
function hitsForCell(cell: Cell, lineHits: LineHit[]): LineHit[] {
  const out: LineHit[] = [];
  for (const hit of lineHits) {
    const from = Math.max(hit.col, cell.textStart);
    const to = Math.min(hit.col + hit.len, cell.end);
    if (to <= from) continue;
    const col = Math.max(0, Math.min(cell.text.length, toCellOffset(cell, from)));
    const endCol = Math.max(0, Math.min(cell.text.length, toCellOffset(cell, to)));
    if (endCol > col) out.push({ col, len: endCol - col, current: hit.current });
  }
  return out;
}

/**
 * Windowed document reader.
 *
 * Only the visible rows exist in the DOM, and only the visible rows are ever
 * pulled out of the worker — so scrolling a 40-million-line document costs the
 * same as scrolling a 40-line one. A delimited document is drawn as a table
 * over the very same machinery: one stored line is one table row, which is
 * exactly why the format pass flattens cells onto single lines.
 */
export default function DocViewer({
  engine,
  docId,
  lineCount,
  apiRef,
  onViewport,
  emptyMessage,
  hits,
  currentHit = -1,
  format = "xml",
  delimiter,
  columns,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);
  /**
   * Width of the viewer's vertical scrollbar.
   *
   * The ruler has no scrollbar of its own, so without reserving the same space
   * it runs out of scroll a scrollbar's width before the rows do and the last
   * column slips out of line at the far right.
   */
  const [gutterRight, setGutterRight] = useState(0);

  const table = format === "csv" && !!delimiter && !!columns?.length;

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      setHeight(el.clientHeight);
      setGutterRight(el.offsetWidth - el.clientWidth);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    if (headRef.current) headRef.current.scrollLeft = 0;
    setScrollTop(0);
    setGutterRight(el.offsetWidth - el.clientWidth);
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

  const lineHitsAt = (i: number): LineHit[] => {
    if (!hits) return [];
    const out: LineHit[] = [];
    for (let h = hitStart; h < hits.length && hits[h].line <= i; h++) {
      if (hits[h].line === i) {
        out.push({ col: hits[h].col, len: hits[h].len, current: h === currentHit });
      }
    }
    return out;
  };

  const visible: React.ReactNode[] = [];
  for (let i = first; i < Math.min(lineCount, first + rows); i++) {
    const text = getLine(i);
    const pending = text === null;
    const lineHits = pending ? [] : lineHitsAt(i);

    let body: React.ReactNode;
    if (pending) {
      body = <span className="code">···</span>;
    } else if (table) {
      const cells = splitLine(text, delimiter!);
      body = (
        <span className="cells">
          {cells.map((cell, ci) => {
            const width = columns![ci]?.width ?? ORPHAN_COL_WIDTH;
            const spans = applyHits(
              [{ c: "t-cell", t: cell.text }],
              hitsForCell(cell, lineHits),
            );
            return (
              <span
                className="cell"
                key={ci}
                style={{ width: `${width}ch` }}
                title={cell.text.length > width ? cell.text : undefined}
              >
                {spans.map((s, k) => (
                  <span className={s.c} key={k}>
                    {s.t}
                  </span>
                ))}
              </span>
            );
          })}
        </span>
      );
    } else {
      let spans: Span[] = highlightLine(text, format);
      if (lineHits.length > 0) spans = applyHits(spans, lineHits);
      body = (
        <span className="code">
          {spans.map((s, k) => (
            <span className={s.c} key={k}>
              {s.t}
            </span>
          ))}
        </span>
      );
    }

    const cls = [
      "row",
      pending ? "pending" : "",
      table && i === 0 ? "head" : "",
    ]
      .filter(Boolean)
      .join(" ");

    visible.push(
      <div className={cls} key={i}>
        <span className="no">{formatCount(i + 1)}</span>
        {body}
      </div>,
    );
  }

  /** Total drawn width of the table, so the scroller knows its range. */
  const tableWidth = table
    ? columns!.reduce((sum, c) => sum + c.width, 0)
    : 0;

  return (
    <div className={table ? "viewer-stack table-mode" : "viewer-stack"}>
      {table && (
        <div
          className={first === 0 ? "table-head idle" : "table-head"}
          ref={headRef}
          aria-hidden="true"
          style={{ paddingRight: gutterRight }}
        >
          <span className="no" />
          <span className="cells">
            {columns!.map((c) => (
              <span className="cell" key={c.name} style={{ width: `${c.width}ch` }}>
                {c.name}
              </span>
            ))}
          </span>
        </div>
      )}
      <div
        className="viewer"
        ref={scrollerRef}
        tabIndex={0}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          // The column ruler sits outside the scroller so it cannot be covered
          // by the absolutely positioned rows; it is kept in step by hand.
          if (headRef.current) headRef.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
      >
        <div
          className="viewer-canvas"
          style={{
            height: totalPx,
            // Must come out to exactly the width a row draws — gutter, the
            // columns themselves, and the trailing padding — or the ruler and
            // the rows run out of scroll at different points.
            width: table
              ? `calc(${GUTTER_PX}px + ${tableWidth}ch + ${ROW_END_PAD}px)`
              : undefined,
          }}
        />
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
    </div>
  );
}
