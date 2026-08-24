"use client";

import { useId } from "react";
import type { Condition, DocSummary, Query, QueryOp } from "../lib/types";
import { OP_LABELS } from "../lib/types";
import { formatCount, formatMs } from "../lib/engine";
import { isUsable } from "../lib/xml/match";

interface Props {
  query: Query;
  onChange: (q: Query) => void;
  onApply: () => void;
  onClear: () => void;
  onDownloadResult: () => void;
  fields: DocSummary["fields"];
  result: DocSummary | null;
  busy: boolean;
  recordName: string | null;
}

let seq = 0;
export function newCondition(): Condition {
  return { id: `c${++seq}`, tag: "", op: "contains", value: "" };
}

export default function QueryBar({
  query,
  onChange,
  onApply,
  onClear,
  onDownloadResult,
  fields,
  result,
  busy,
  recordName,
}: Props) {
  const listId = useId();
  const usable = query.conditions.some(isUsable);

  const update = (id: string, patch: Partial<Condition>) =>
    onChange({
      ...query,
      conditions: query.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });

  const remove = (id: string) =>
    onChange({ ...query, conditions: query.conditions.filter((c) => c.id !== id) });

  return (
    <div className="query">
      <datalist id={listId}>
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {formatCount(f.count)}×
          </option>
        ))}
      </datalist>

      <div className="query-rows">
        {query.conditions.map((c, i) => (
          <div className="cond" key={c.id}>
            <span className="cond-join">
              {i === 0 ? (
                recordName ? `<${recordName}>` : "record"
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    onChange({ ...query, combinator: query.combinator === "AND" ? "OR" : "AND" })
                  }
                  title="Switch how the conditions combine"
                  style={{ font: "inherit", color: "var(--signal)" }}
                >
                  {query.combinator === "AND" ? "AND" : "OR"}
                </button>
              )}
            </span>

            <input
              className="tag"
              type="text"
              list={listId}
              placeholder="tag name"
              value={c.tag}
              spellCheck={false}
              onChange={(e) => update(c.id, { tag: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && usable && !busy && onApply()}
              aria-label="Tag name"
            />

            <select
              className="op"
              value={c.op}
              onChange={(e) => update(c.id, { op: e.target.value as QueryOp })}
              aria-label="Comparison"
            >
              {(Object.keys(OP_LABELS) as QueryOp[]).map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>

            <input
              className="val"
              type="text"
              placeholder="value"
              value={c.value}
              spellCheck={false}
              onChange={(e) => update(c.id, { value: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && usable && !busy && onApply()}
              aria-label="Value"
            />

            <button
              type="button"
              className="x"
              onClick={() => remove(c.id)}
              disabled={query.conditions.length === 1}
              aria-label="Remove condition"
              title="Remove condition"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="query-actions">
        <button
          type="button"
          className="btn ghost"
          onClick={() =>
            onChange({ ...query, conditions: [...query.conditions, newCondition()] })
          }
        >
          + condition
        </button>

        <label
          className="toggle"
          title="When off, case and accented characters are matched loosely"
        >
          <input
            type="checkbox"
            checked={query.caseSensitive}
            onChange={(e) => onChange({ ...query, caseSensitive: e.target.checked })}
          />
          Aa case sensitive
        </label>

        <button type="button" className="btn primary" onClick={onApply} disabled={!usable || busy}>
          {busy ? "Running…" : "Apply"}
        </button>

        {result && (
          <>
            <button type="button" className="btn ghost" onClick={onClear}>
              Clear
            </button>
            <span className="query-hint">
              <b>{formatCount(result.recordCount)}</b> of{" "}
              {formatCount(result.scannedRecords ?? 0)} records matched ·{" "}
              {formatMs(result.elapsedMs)}
            </span>
            <span className="spacer" />
            <button type="button" className="btn" onClick={onDownloadResult}>
              ↓ Download result
            </button>
          </>
        )}
      </div>
    </div>
  );
}
