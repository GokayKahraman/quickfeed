"use client";

import { useEffect, useRef } from "react";
import type { FindOptions } from "../lib/types";
import { formatCount } from "../lib/engine";

interface Props {
  query: string;
  onQueryChange: (q: string) => void;
  options: FindOptions;
  onOptionsChange: (o: FindOptions) => void;
  total: number;
  truncated: boolean;
  current: number;
  searching: boolean;
  error: string | null;
  onStep: (delta: number) => void;
  onClose: () => void;
}

const TOGGLES: { key: keyof FindOptions; glyph: string; title: string }[] = [
  { key: "caseSensitive", glyph: "Aa", title: "Match case" },
  { key: "wholeWord", glyph: "ab", title: "Whole word" },
  { key: "regex", glyph: ".*", title: "Regular expression" },
];

/**
 * In-document find.
 *
 * The viewer keeps only the visible lines in the DOM, so the browser's own
 * Ctrl+F has almost nothing to search. This drives a worker-side scan over
 * every line instead and reports where the hits are.
 */
export default function FindBar({
  query,
  onQueryChange,
  options,
  onOptionsChange,
  total,
  truncated,
  current,
  searching,
  error,
  onStep,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const status = error
    ? "bad pattern"
    : searching
      ? "searching…"
      : !query
        ? ""
        : total === 0
          ? "No results"
          : `${formatCount(current + 1)} of ${formatCount(total)}${truncated ? "+" : ""}`;

  return (
    <div className="find" role="search">
      <input
        ref={inputRef}
        type="text"
        className={error ? "find-input bad" : "find-input"}
        placeholder="Find in document"
        value={query}
        spellCheck={false}
        aria-label="Find in document"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />

      <div className="find-toggles">
        {TOGGLES.map((t) => (
          <button
            key={t.key}
            type="button"
            title={t.title}
            aria-label={t.title}
            aria-pressed={options[t.key]}
            onClick={() => onOptionsChange({ ...options, [t.key]: !options[t.key] })}
          >
            {t.glyph}
          </button>
        ))}
      </div>

      <span className={error || (query && total === 0) ? "find-status none" : "find-status"}>
        {status}
      </span>

      <button
        type="button"
        className="find-step"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={total === 0}
        onClick={() => onStep(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="find-step"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={total === 0}
        onClick={() => onStep(1)}
      >
        ↓
      </button>
      <button
        type="button"
        className="find-step"
        title="Close (Esc)"
        aria-label="Close find"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );
}
