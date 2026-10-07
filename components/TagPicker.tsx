"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { FieldInfo } from "../lib/types";
import { formatCount } from "../lib/engine";
import { fold } from "../lib/xml/match";

interface Props {
  options: FieldInfo[];
  selected: string[];
  onChange: (tags: string[]) => void;
  /** "tag", "key" or "column" — whatever a field is called in this format. */
  noun: string;
  /** Shown in the list when there is nothing to pick from at all. */
  emptyNote: string;
}

/**
 * Searchable multi-select over the record's fields.
 *
 * The list stays open while picking, so choosing six fields is six clicks
 * rather than six trips back to the box. Picks are kept in document order, not
 * click order: that is the order they come out in, so the chips read like the
 * record they describe.
 */
export default function TagPicker({ options, selected, onChange, noun, emptyNote }: Props) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);

  const picked = useMemo(() => new Set(selected), [selected]);
  const order = useMemo(() => new Map(options.map((o, i) => [o.name, i])), [options]);

  const shown = useMemo(() => {
    const needle = fold(text.trim());
    return needle ? options.filter((o) => fold(o.name).includes(needle)) : options;
  }, [options, text]);

  const sorted = (tags: string[]) =>
    [...tags].sort(
      (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
    );

  const toggle = (name: string) =>
    onChange(picked.has(name) ? selected.filter((t) => t !== name) : sorted([...selected, name]));

  const pickAllShown = () => onChange(sorted([...new Set([...selected, ...shown.map((o) => o.name)])]));

  const openList = () => {
    setOpen(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setOpen(true);
        setActive((i) => Math.min(i + 1, shown.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        if (open && shown[active]) {
          e.preventDefault();
          toggle(shown[active].name);
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      case "Backspace":
        if (!text && selected.length > 0) onChange(selected.slice(0, -1));
        break;
    }
  };

  return (
    <div
      className={`tagpick${open ? " open" : ""}`}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setText("");
        }
      }}
    >
      <div className="tagpick-box" onMouseDown={(e) => {
        // Clicks on the box itself (not a chip's ×) land in the input.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          openList();
        }
      }}>
        {selected.map((tag) => (
          <span className="tagpick-chip" key={tag}>
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              title={`Remove ${tag}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(tag)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={`Fields to show`}
          placeholder={selected.length ? "" : `pick ${noun}s to keep…`}
          value={text}
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {open && (
        <div className="tagpick-pop">
          {options.length > 0 && (
            <div className="tagpick-head">
              <span>
                {selected.length} of {options.length} kept
              </span>
              <span className="spacer" />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={pickAllShown}
                disabled={shown.every((o) => picked.has(o.name))}
              >
                {text.trim() ? "select shown" : "select all"}
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange([])}
                disabled={selected.length === 0}
              >
                clear
              </button>
            </div>
          )}
          <ul id={listId} role="listbox" aria-multiselectable="true" className="tagpick-list">
            {shown.length === 0 && (
              <li className="tagpick-empty">
                {options.length === 0 ? emptyNote : `no ${noun} matches “${text.trim()}”`}
              </li>
            )}
            {shown.map((o, i) => (
              <li
                key={o.name}
                role="option"
                aria-selected={picked.has(o.name)}
                className={`tagpick-opt${i === active ? " active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => toggle(o.name)}
              >
                <span className="tagpick-check" aria-hidden="true">
                  {picked.has(o.name) ? "✓" : ""}
                </span>
                <span className="tagpick-name">{o.name}</span>
                {o.container && (
                  <span className="tagpick-kind" title="Holds other fields; kept whole">
                    group
                  </span>
                )}
                <span className="tagpick-count">{formatCount(o.count)}×</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
