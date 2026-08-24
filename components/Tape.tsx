"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatCount } from "../lib/engine";

interface TapeProps {
  /** Record density across the document, 512 buckets. */
  histogram: number[];
  /** Where a query's hits fall, in the same line space. */
  matchHistogram?: number[];
  lineCount: number;
  firstLine: number;
  visibleLines: number;
  recordName: string | null;
  onSeek: (line: number) => void;
}

const CSS_H = 42;

/**
 * The whole document as one strip.
 *
 * Bars are record density; the bright block is the part you are looking at.
 * With a query applied while reading the source, the hits are drawn over the
 * top, which is the only way to see at a glance whether matches are spread
 * through the feed or clustered in one corner of it.
 */
export default function Tape({
  histogram,
  matchHistogram,
  lineCount,
  firstLine,
  visibleLines,
  recordName,
  onSeek,
}: TapeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(CSS_H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, CSS_H);

    const buckets = histogram.length || 1;
    const barW = width / buckets;
    const peak = Math.max(1, ...histogram);

    // Baseline rule keeps the strip readable when the feed is sparse.
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(0, CSS_H - 1, width, 1);

    ctx.fillStyle = "rgba(127,214,236,0.30)";
    for (let i = 0; i < buckets; i++) {
      const v = histogram[i];
      if (!v) continue;
      // Gentle curve: a bucket with a tenth of the peak still has to be visible.
      const h = Math.max(1.5, Math.pow(v / peak, 0.55) * (CSS_H - 4));
      ctx.fillRect(i * barW, CSS_H - 1 - h, Math.max(1, barW - 0.4), h);
    }

    if (matchHistogram) {
      const mPeak = Math.max(1, ...matchHistogram);
      ctx.fillStyle = "#ff4a4a";
      for (let i = 0; i < matchHistogram.length; i++) {
        const v = matchHistogram[i];
        if (!v) continue;
        const h = Math.max(2, Math.pow(v / mPeak, 0.55) * (CSS_H - 4));
        ctx.fillRect(i * barW, CSS_H - 1 - h, Math.max(1.2, barW - 0.4), h);
      }
    }

    if (lineCount > 0) {
      const x0 = (firstLine / lineCount) * width;
      const w = Math.max(3, (visibleLines / lineCount) * width);
      ctx.fillStyle = "rgba(228,236,245,0.13)";
      ctx.fillRect(x0, 0, w, CSS_H);
      ctx.fillStyle = "#e4ecf5";
      ctx.fillRect(x0, 0, 1, CSS_H);
      ctx.fillRect(Math.min(width - 1, x0 + w - 1), 0, 1, CSS_H);
    }
  }, [histogram, matchHistogram, lineCount, firstLine, visibleLines, width]);

  const lineAt = useCallback(
    (clientX: number) => {
      const el = canvasRef.current;
      if (!el || lineCount === 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return Math.floor(ratio * lineCount);
    },
    [lineCount],
  );

  return (
    <div className="tape-wrap">
      <canvas
        ref={canvasRef}
        className="tape"
        style={{ height: CSS_H }}
        aria-label="Document map"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(lineAt(e.clientX));
        }}
        onPointerMove={(e) => {
          setHoverLine(lineAt(e.clientX));
          if (dragging.current) onSeek(lineAt(e.clientX));
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerLeave={() => {
          dragging.current = false;
          setHoverLine(null);
        }}
      />
      <div className="tape-legend">
        <span className="key">
          <i className="swatch" style={{ background: "rgba(127,214,236,0.55)" }} />
          {recordName ? `<${recordName}> density` : "record density"}
        </span>
        {matchHistogram && (
          <span className="key">
            <i className="swatch" style={{ background: "#ff4a4a" }} />
            matches
          </span>
        )}
        <span className="key">
          <i className="swatch" style={{ background: "rgba(228,236,245,0.5)" }} />
          viewport
        </span>
        <span className="tape-readout">
          {hoverLine !== null
            ? `line ${formatCount(hoverLine + 1)}`
            : `${formatCount(lineCount)} lines`}
        </span>
      </div>
    </div>
  );
}
