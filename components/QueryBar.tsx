"use client";

import { useId } from "react";
import type {
  Condition,
  DocSummary,
  FeedFormat,
  FieldInfo,
  Query,
  QueryOp,
} from "../lib/types";
import { OP_LABELS } from "../lib/types";
import { fieldWord, formatCount, formatMs } from "../lib/engine";
import { isUsable } from "../lib/xml/match";

interface Props {
  query: Query;
  onChange: (q: Query) => void;
  onApply: () => void;
  onClear: () => void;
  onDownloadResult: () => void;
  fields: FieldInfo[];
  result: DocSummary | null;
  busy: boolean;
  /** Record tag actually in use — the detected one unless overridden. */
  recordName: string | null;
  /** What detection guessed, for the "not this one?" hint. */
  recordAuto: string | null;
  recordCandidates: FieldInfo[];
  recordCount: number;
  onRecordChange: (name: string) => void;
  format: FeedFormat;
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
  recordAuto,
  recordCandidates,
  recordCount,
  onRecordChange,
  format,
}: Props) {
  const listId = useId();
  const noun = fieldWord(format);
  // A table has exactly one thing a record could be — the row — so there is
  // nothing to choose and the picker would only be noise.
  const showRecordPicker = format !== "csv";
  const usable = query.conditions.some(isUsable);
  const overridden = !!recordName && !!recordAuto && recordName !== recordAuto;

  // Detection can be wrong, so the chosen tag is always offered even when it
  // did not make the candidate list.
  const options =
    recordName && !recordCandidates.some((c) => c.name === recordName)
      ? [{ name: recordName, count: recordCount, depth: 0, container: true }, ...recordCandidates]
      : recordCandidates;

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

      {showRecordPicker && (
      <div className="record-row">
        <span className="opt-label">Record</span>
        <select
          className="record-select"
          value={recordName ?? ""}
          onChange={(e) => onRecordChange(e.target.value)}
          aria-label="Record tag"
          title="The tag that wraps one record. Change it if the wrong one was detected."
        >
          {options.length === 0 && <option value="">no repeating tag found</option>}
          {options.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} — {formatCount(c.count)}
            </option>
          ))}
        </select>
        <span className="record-note">
          {overridden ? (
            <>
              you picked this · detected{" "}
              <code>{format === "xml" ? `<${recordAuto}>` : recordAuto}</code>{" "}
              <button type="button" onClick={() => onRecordChange(recordAuto!)}>
                undo
              </button>
            </>
          ) : (
            "detected automatically — switch it if queries return nothing"
          )}
        </span>
      </div>
      )}

      <div className="query-rows">
        {query.conditions.map((c, i) => (
          <div className="cond" key={c.id}>
            <span className="cond-join">
              {i === 0 ? (
                "where"
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
              placeholder={`${noun} name`}
              value={c.tag}
              spellCheck={false}
              onChange={(e) => update(c.id, { tag: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && usable && !busy && onApply()}
              aria-label={`${noun} name`}
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
