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
/** How narrow and how wide a column may be dragged, in characters. */
const MIN_COL_WIDTH = 3;
const MAX_COL_WIDTH = 400;
/** `.cell`'s right padding. Boxes are border-box, so it comes off the text. */
const CELL_PAD_PX = 12;
/** Characters the probe is set to, for a measurement that averages rounding. */
const PROBE_CH = 20;
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

/** A cell opened for reading in full, with where on screen it was. */
type InspectedCell = {
  column: string;
  text: string;
  /** Viewport coordinates of the cell that was clicked. */
  left: number;
  top: number;
  bottom: number;
};

/** Drag in progress on a column edge. */
type ColDrag = { index: number; startX: number; startWidth: number; pxPerCh: number };

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

  /**
   * Widths the user has dragged, by column index, over the measured ones.
   *
   * Kept here rather than pushed back into `columns` because it is a view
   * preference: it must not follow the document into a query result or a
   * download, and it is thrown away when a different document is opened.
   */
  const [widths, setWidths] = useState<Record<number, number>>({});
  /** The cell whose full value is on screen, when one was clicked open. */
  const [inspect, setInspect] = useState<InspectedCell | null>(null);

  const table = format === "csv" && !!delimiter && !!columns?.length;
  const widthOf = (ci: number) => widths[ci] ?? columns?.[ci]?.width ?? ORPHAN_COL_WIDTH;

  /**
   * Width of one character, in pixels.
   *
   * Column widths are written in `ch` so the ruler and the rows stay in step
   * whatever the font resolves to, but two things need the number in pixels: a
   * drag arrives in pixels, and whether a cell is cut off depends on the
   * padding, which is in pixels too. Measured from a probe rather than assumed,
   * so it stays right if the type ever changes.
   */
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [chPx, setChPx] = useState(0);

  useLayoutEffect(() => {
    const el = probeRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width / PROBE_CH;
      if (w > 0) setChPx((prev) => (Math.abs(prev - w) < 0.01 ? prev : w));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [table]);

  /*
   * Characters the padding eats. A cell exactly as long as its column still
   * shows an ellipsis, because the padding comes out of the text box — so the
   * test for "cut off" has to account for it, or the last character-wide sliver
   * of cells would show `…` and refuse to open.
   */
  const padCh = chPx > 0 ? CELL_PAD_PX / chPx : 0;

  const drag = useRef<ColDrag | null>(null);

  /*
   * Column widths are set in `ch` so the ruler and the rows stay in step
   * whatever the font size resolves to, but a drag arrives in pixels. The
   * conversion is measured off the header cell being dragged rather than
   * assumed, so it stays right if the type ever changes.
   */
  const startColDrag = (e: React.PointerEvent<HTMLElement>, index: number) => {
    if (!(chPx > 0)) return;
    drag.current = {
      index,
      startX: e.clientX,
      startWidth: widthOf(index),
      pxPerCh: chPx,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const moveColDrag = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = d.startWidth + (e.clientX - d.startX) / d.pxPerCh;
    const clamped = Math.round(Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, next)));
    setWidths((w) => (w[d.index] === clamped ? w : { ...w, [d.index]: clamped }));
  };

  const endColDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  /** Double-click on the edge puts the column back to its measured width. */
  const resetCol = (index: number) =>
    setWidths((w) => {
      if (!(index in w)) return w;
      const next = { ...w };
      delete next[index];
      return next;
    });

  /*
   * A cell is opened by clicking it, but only when it is actually cut off —
   * an untruncated cell has nothing more to show, and making every cell a
   * button would swallow ordinary text selection. A drag that selected text
   * is not a click either, so a live selection cancels it.
   */
  const openCell = (e: React.MouseEvent<HTMLElement>, index: number, text: string) => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const r = e.currentTarget.getBoundingClientRect();
    setInspect({
      column: columns?.[index]?.name ?? `column ${index + 1}`,
      text,
      left: r.left,
      top: r.top,
      bottom: r.bottom,
    });
  };

  /* The popover is anchored to a place on screen, so anything that moves the
     rows underneath it — scrolling, resizing — takes it away rather than
     leaving it pointing at the wrong cell. */
  useEffect(() => {
    if (!inspect) return;
    const close = () => setInspect(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [inspect]);

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
    setWidths({});
    setInspect(null);
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
            const width = widthOf(ci);
            const spans = applyHits(
              [{ c: "t-cell", t: cell.text }],
              hitsForCell(cell, lineHits),
            );
            /* Monospaced type, so one character is one column of width, and
               the count is the truncation test — no per-cell measuring, which
               at thirty rows by twenty columns would cost a frame. */
            const clipped = cell.text.length > width - padCh;
            return (
              <span
                className={clipped ? "cell clipped" : "cell"}
                key={ci}
                style={{ width: `${width}ch` }}
                /* The value itself, not an instruction: the tooltip is the
                   path for anyone not clicking, and the cursor and the hover
                   already say the cell opens. */
                title={clipped ? cell.text : undefined}
                onClick={clipped ? (e) => openCell(e, ci, cell.text) : undefined}
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
    ? columns!.reduce((sum, _c, ci) => sum + widthOf(ci), 0)
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
          {/* Sized in `ch` and measured in pixels; that is the whole job. */}
          <span className="ch-probe" ref={probeRef} aria-hidden="true" />
          <span className="cells">
            {columns!.map((c, ci) => (
              <span className="cell" key={c.name} style={{ width: `${widthOf(ci)}ch` }}>
                <span className="col-name">{c.name}</span>
                {/* The grip stays visible even while the ruler gives up its
                    text to the feed's own header row — the column is still
                    there to be resized. */}
                <span
                  className="col-grip"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${c.name}`}
                  title="Drag to resize · double-click to reset"
                  onPointerDown={(e) => startColDrag(e, ci)}
                  onPointerMove={moveColDrag}
                  onPointerUp={endColDrag}
                  onPointerCancel={endColDrag}
                  onDoubleClick={() => resetCol(ci)}
                />
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
          if (inspect) setInspect(null);
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
      {inspect && <CellPopover cell={inspect} onClose={() => setInspect(null)} />}
    </div>
  );
}

/**
 * The whole value of one cell, for the times the column is too narrow to hold
 * it.
 *
 * A panel rather than an expanded row: every row here is exactly one line tall
 * and positioned by its index, which is what lets a forty-million-line table
 * scroll at all. A value that wraps to six lines cannot live inside that.
 */
function CellPopover({ cell, onClose }: { cell: InspectedCell; onClose: () => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  /* Measured, then placed: the panel is sized by its own text, so where it
     fits can only be known once it exists. It opens below the cell, flips
     above when that would run off the bottom, and is pulled back inside the
     right edge rather than being allowed to cause a page scroll. */
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(cell.left, window.innerWidth - r.width - margin));
    const below = cell.bottom + 4;
    const top = below + r.height + margin > window.innerHeight
      ? Math.max(margin, cell.top - r.height - 4)
      : below;
    setPlaced({ left, top });
  }, [cell]);

  const copy = () => {
    void navigator.clipboard?.writeText(cell.text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => setCopied(false),
    );
  };

  return (
    <>
      {/* Anything outside the panel closes it, including a click on another
          cell — which then opens that one, since the scrim sits underneath. */}
      <div className="cell-scrim" onMouseDown={onClose} />
      <div
        className="cell-pop"
        ref={box}
        role="dialog"
        aria-label={`Full value of ${cell.column}`}
        style={{
          left: placed?.left ?? cell.left,
          top: placed?.top ?? cell.bottom + 4,
          visibility: placed ? "visible" : "hidden",
        }}
      >
        <div className="cell-pop-head">
          <span className="cell-pop-col">{cell.column}</span>
          <span className="cell-pop-len">{formatCount(cell.text.length)} chars</span>
          <button type="button" onClick={copy}>
            {copied ? "copied" : "copy"}
          </button>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="cell-pop-body">{cell.text}</div>
      </div>
    </>
  );
}
