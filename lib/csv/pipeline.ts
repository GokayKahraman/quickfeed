import { CsvTokenizer, encodeRow, flattenCell, sanitizeHeaders } from "./tokenizer";
import { addField, compileQuery, type RecordValues } from "../xml/match";
import { DensityHistogram, DocWriter } from "../store/document";
import type { BackingStore } from "../store/backing";
import type { ColumnInfo, FieldInfo, LoadProgress, Query } from "../types";
import { pumpStore, pumpStream } from "../format/read";

/** Widest a column is allowed to draw; wider cells ellipsize. */
const MAX_COL_WIDTH = 48;
const MIN_COL_WIDTH = 6;

/** The record tag for a table is always the row; there is nothing else it could be. */
export const ROW_RECORD = "row";

export interface CsvShape {
  headers: string[];
  columns: ColumnInfo[];
  recordCount: number;
  raggedRows: number;
  fields: FieldInfo[];
  recordCandidates: FieldInfo[];
}

export interface CsvFormatResult {
  shape: CsvShape;
  histogram: DensityHistogram;
  bytesRead: number;
}

function measure(widths: number[], index: number, cell: string): void {
  const len = cell.length;
  if (index >= widths.length) widths.length = index + 1;
  const seen = widths[index] ?? 0;
  if (len > seen) widths[index] = len;
}

function toColumns(headers: string[], widths: number[]): ColumnInfo[] {
  return headers.map((name, i) => ({
    name,
    width: Math.max(
      MIN_COL_WIDTH,
      Math.min(MAX_COL_WIDTH, Math.max(name.length, widths[i] ?? 0) + 1),
    ),
  }));
}

/**
 * Reads a delimited feed and rewrites it as one canonical record per line.
 *
 * The rewrite is what makes the rest of the app work on a table: the viewer,
 * the line index, the find bar and the tape all address the document by line,
 * and the table view draws line N as row N. A quoted cell containing a
 * newline would break that correspondence, so cells are flattened on the way
 * through — the one content change this pass makes, and the reason it is not
 * optional.
 */
export async function formatCsvStream(opts: {
  stream: ReadableStream<Uint8Array>;
  totalBytes: number | null;
  out: DocWriter;
  delimiter: string;
  onProgress: (p: LoadProgress) => void;
  shouldCancel: () => boolean;
}): Promise<CsvFormatResult> {
  const { stream, totalBytes, out, delimiter, onProgress, shouldCancel } = opts;
  const tokenizer = new CsvTokenizer(delimiter);
  const histogram = new DensityHistogram();
  const widths: number[] = [];

  let headers: string[] | null = null;
  let records = 0;
  let ragged = 0;

  const emit = (fields: string[]) => {
    const row = fields.map(flattenCell);

    if (!headers) {
      headers = sanitizeHeaders(row);
      for (let i = 0; i < headers.length; i++) measure(widths, i, headers[i]);
      out.write(encodeRow(headers, delimiter) + "\n");
      return;
    }

    if (row.length !== headers.length) ragged++;
    // Short rows are padded so every line has the same cell count; long ones
    // keep their extra cells rather than losing data to a tidier table.
    while (row.length < headers.length) row.push("");
    for (let i = 0; i < row.length; i++) measure(widths, i, row[i]);

    histogram.add(out.line() + 1);
    records++;
    out.write(encodeRow(row, delimiter) + "\n");
  };

  const bytesRead = await pumpStream(stream, {
    onText: (text) => tokenizer.push(text, emit),
    onTick: (read) =>
      onProgress({
        bytesRead: read,
        totalBytes,
        linesWritten: out.line(),
        records,
        phase: "format",
      }),
    shouldCancel,
  });
  tokenizer.end(emit);

  const cols = headers ?? [];
  const fields: FieldInfo[] = cols.map((name) => ({
    name,
    count: records,
    depth: 1,
    container: false,
  }));

  return {
    shape: {
      headers: cols,
      columns: toColumns(cols, widths),
      recordCount: records,
      raggedRows: ragged,
      fields,
      recordCandidates: [
        { name: ROW_RECORD, count: records, depth: 1, container: true },
      ],
    },
    histogram,
    bytesRead,
  };
}

/** Column values plus a whole-row entry, so `row contains X` searches the lot. */
function rowValues(headers: string[], row: string[]): RecordValues {
  const values: RecordValues = new Map();
  const parts: string[] = [];
  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    if (!cell) continue;
    addField(values, headers[i] ?? `column_${i + 1}`, cell);
    parts.push(cell);
  }
  if (parts.length) addField(values, ROW_RECORD, parts.join(" "));
  return values;
}

export interface CsvQueryResult {
  matched: number;
  scanned: number;
  resultHistogram: DensityHistogram;
  matchHistogram: DensityHistogram;
}

/**
 * Second pass: re-reads the canonical table and keeps the rows that match.
 * The header is copied through first, so the result is a table in the same
 * dialect that opens straight back into a spreadsheet.
 */
export async function runCsvQuery(opts: {
  source: BackingStore;
  delimiter: string;
  query: Query;
  out: DocWriter;
  onProgress: (p: LoadProgress) => void;
  shouldCancel: () => boolean;
}): Promise<CsvQueryResult> {
  const { source, delimiter, query, out, onProgress, shouldCancel } = opts;
  const predicate = compileQuery(query);
  if (!predicate) throw new Error("Empty query: fill in the field and value boxes.");

  const tokenizer = new CsvTokenizer(delimiter);
  const resultHistogram = new DensityHistogram();
  const matchHistogram = new DensityHistogram();
  let headers: string[] | null = null;
  let matched = 0;
  let scanned = 0;

  const emit = (row: string[], startLine: number) => {
    if (!headers) {
      // Idempotent on a document this app wrote, but it keeps the names a
      // condition resolves against identical to the ones the field list
      // offers, even if the header line reaching here was never normalised.
      headers = sanitizeHeaders(row);
      out.write(encodeRow(headers, delimiter) + "\n");
      return;
    }
    scanned++;
    if (!predicate(rowValues(headers, row))) return;
    matched++;
    resultHistogram.add(out.line() + 1);
    matchHistogram.add(startLine);
    out.write(encodeRow(row, delimiter) + "\n");
  };

  const total = source.size;
  await pumpStore(source, {
    onText: (text) => tokenizer.push(text, emit),
    onTick: (read) =>
      onProgress({
        bytesRead: read,
        totalBytes: total,
        linesWritten: out.line(),
        records: matched,
        phase: "query",
      }),
    shouldCancel,
  });
  tokenizer.end(emit);

  return { matched, scanned, resultHistogram, matchHistogram };
}

