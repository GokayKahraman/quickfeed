/**
 * Streaming RFC 4180 parser for delimited text.
 *
 * The delimiter is any single character — comma, tab, semicolon or pipe.
 * Quoted fields may contain the delimiter, doubled quotes and newlines, and a
 * record may straddle any number of chunk boundaries: everything the parser
 * has not yet resolved lives in a few fields on the instance, never in a
 * buffer of the whole input.
 */

export type RowHandler = (fields: string[], startLine: number) => void;

export class CsvTokenizer {
  private field = "";
  private row: string[] = [];
  private quoted = false;
  /** Saw a `"` inside a quoted field; the next character decides what it was. */
  private pendingQuote = false;
  /** A CR ended the last row, so a following LF is part of the same break. */
  private swallowLf = false;
  private rowStart = 0;
  /** Physical lines consumed from the input so far. */
  line = 0;

  constructor(private readonly delimiter: string) {}

  push(chunk: string, emit: RowHandler): void {
    const d = this.delimiter.charCodeAt(0);

    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);

      // A quote seen inside a quoted field is ambiguous until the next
      // character arrives — which may be in the next chunk entirely.
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (c === 34) {
          this.field += '"';
          continue;
        }
        this.quoted = false;
        i--; // re-read this character in unquoted mode
        continue;
      }

      if (this.quoted) {
        if (c === 34) {
          this.pendingQuote = true;
          continue;
        }
        if (c === 10) this.line++;
        this.field += chunk[i];
        continue;
      }

      if (c === 10) {
        this.line++;
        if (this.swallowLf) {
          this.swallowLf = false;
          continue;
        }
        this.endRow(emit);
        continue;
      }
      this.swallowLf = false;

      if (c === 13) {
        // Bare CR ends a row too; the LF of a CRLF pair is swallowed next.
        this.line++;
        this.swallowLf = true;
        this.endRow(emit);
        continue;
      }
      if (c === d) {
        this.row.push(this.field);
        this.field = "";
        continue;
      }
      if (c === 34 && this.field.length === 0) {
        this.quoted = true;
        continue;
      }
      this.field += chunk[i];
    }
  }

  end(emit: RowHandler): void {
    this.pendingQuote = false;
    this.quoted = false;
    if (this.field.length > 0 || this.row.length > 0) this.endRow(emit);
  }

  private endRow(emit: RowHandler): void {
    this.row.push(this.field);
    this.field = "";
    const row = this.row;
    this.row = [];
    const start = this.rowStart;
    this.rowStart = this.line;
    // A blank line is structure, not a record; a row of genuinely empty cells
    // still is one, so only a single empty field is dropped.
    if (row.length === 1 && row[0] === "") return;
    emit(row, start);
  }
}

/** Wraps a cell in quotes only when the dialect requires it. */
export function quoteField(field: string, delimiter: string): string {
  if (
    field.includes('"') ||
    field.includes(delimiter) ||
    field.includes("\n") ||
    field.includes("\r")
  ) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function encodeRow(fields: string[], delimiter: string): string {
  let out = "";
  for (let i = 0; i < fields.length; i++) {
    if (i) out += delimiter;
    out += quoteField(fields[i], delimiter);
  }
  return out;
}

/**
 * Flattens a cell onto one physical line.
 *
 * This is not cosmetic. The viewer, the line index, the find bar and the table
 * all address the document by line, and the table draws one row per line — so
 * a description with an embedded newline would otherwise split its record
 * across two rows and put every later row's line number out of step.
 */
export function flattenCell(s: string): string {
  return s.indexOf("\n") === -1 && s.indexOf("\r") === -1
    ? s
    : s.replace(/\r\n|[\r\n]/g, " ");
}

/** Gives every column a usable, unique name for the query bar. */
export function sanitizeHeaders(raw: string[]): string[] {
  const used = new Set<string>();
  return raw.map((cell, i) => {
    let name = cell.trim().replace(/^\uFEFF/, "") || `column_${i + 1}`;
    if (used.has(name)) {
      let k = 2;
      while (used.has(`${name}_${k}`)) k++;
      name = `${name}_${k}`;
    }
    used.add(name);
    return name;
  });
}

/**
 * One cell of a formatted line, carrying enough to map back to raw offsets.
 *
 * The table draws `text` — the cell without its quoting — but the find bar
 * reports hits as offsets into the raw line, so a highlight can only land in
 * the right place if the two coordinate spaces can be converted. `textStart`
 * is where the text begins in raw space, and `skipped` lists the raw offsets
 * of characters the unquoting dropped, which is everything needed to shift a
 * raw offset into the drawn string exactly rather than approximately.
 */
export interface Cell {
  text: string;
  /** Raw offset of the cell, quoting included. */
  start: number;
  end: number;
  /** Raw offset the drawn text starts at. */
  textStart: number;
  /** Raw offsets dropped while unquoting; almost always empty. */
  skipped: number[];
  quoted: boolean;
}

/** Converts a raw-line offset into an offset within `cell.text`. */
export function toCellOffset(cell: Cell, rawOffset: number): number {
  // Anything dropped before the text began is already covered by `textStart`;
  // counting it again would push every offset one place to the left.
  let shift = 0;
  for (const s of cell.skipped) if (s >= cell.textStart && s < rawOffset) shift++;
  return rawOffset - cell.textStart - shift;
}

/** Splits one already-formatted line back into cells. */
export function splitLine(line: string, delimiter: string): Cell[] {
  const cells: Cell[] = [];
  const d = delimiter.charCodeAt(0);
  let i = 0;
  let start = 0;
  let textStart = 0;
  let text = "";
  let quoted = false;
  let wasQuoted = false;
  let skipped: number[] = [];

  const flush = (end: number) => {
    cells.push({ text, start, end, textStart, skipped, quoted: wasQuoted });
    text = "";
    skipped = [];
    wasQuoted = false;
  };

  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (quoted) {
      if (c === 34) {
        if (line.charCodeAt(i + 1) === 34) {
          text += '"';
          skipped.push(i);
          i += 2;
          continue;
        }
        skipped.push(i);
        quoted = false;
        i++;
        continue;
      }
      text += line[i];
      i++;
      continue;
    }
    if (c === d) {
      flush(i);
      i++;
      start = i;
      textStart = i;
      continue;
    }
    if (c === 34 && text.length === 0) {
      quoted = true;
      wasQuoted = true;
      skipped.push(i);
      i++;
      textStart = i;
      continue;
    }
    text += line[i];
    i++;
  }
  flush(line.length);
  return cells;
}
