import { JsonTokenizer, type JsonToken } from "./tokenizer";
import { JsonCursor, JsonPrinter, JsonShape } from "./formatter";
import { addField, compileQuery, type RecordValues } from "../xml/match";
import { DensityHistogram, DocWriter } from "../store/document";
import type { BackingStore } from "../store/backing";
import type { LoadProgress, Query } from "../types";
import { MAX_VALUE_CHARS, pumpStore, pumpStream } from "../format/read";

export interface JsonFormatResult {
  shape: JsonShape;
  /** Element density per nesting depth 1..4; the right one is picked afterwards. */
  depthHistograms: DensityHistogram[];
  bytesRead: number;
}

/**
 * Reads a JSON feed, writes it back indented, and learns its shape in the
 * same pass — the JSON counterpart of `formatStream`.
 *
 * Newline-delimited JSON needs no special handling: several top-level values
 * in a row are simply printed one after another.
 */
export async function formatJsonStream(opts: {
  stream: ReadableStream<Uint8Array>;
  totalBytes: number | null;
  out: DocWriter;
  indent: string;
  onProgress: (p: LoadProgress) => void;
  shouldCancel: () => boolean;
}): Promise<JsonFormatResult> {
  const { stream, totalBytes, out, indent, onProgress, shouldCancel } = opts;
  const tokenizer = new JsonTokenizer();
  const shape = new JsonShape();
  const printer = new JsonPrinter((s) => out.write(s), indent);
  const depthHistograms = [
    new DensityHistogram(),
    new DensityHistogram(),
    new DensityHistogram(),
    new DensityHistogram(),
  ];
  const depthCounts = [0, 0, 0, 0];

  const emit = (tok: JsonToken) => {
    if (JsonShape.opensElement(tok)) {
      const d = shape.depth;
      if (d >= 1 && d <= 4) {
        depthHistograms[d - 1].add(out.line() + 1);
        depthCounts[d - 1]++;
      }
    }
    shape.feed(tok);
    printer.feed(tok);
  };

  const bytesRead = await pumpStream(stream, {
    onText: (text) => tokenizer.push(text, emit),
    onTick: (read) =>
      onProgress({
        bytesRead: read,
        totalBytes,
        linesWritten: out.line(),
        records: Math.max(depthCounts[0], depthCounts[1]),
        phase: "format",
      }),
    shouldCancel,
  });
  tokenizer.end(emit);
  printer.finish();
  shape.finish();

  return { shape, depthHistograms, bytesRead };
}

/**
 * Gathers one record's queryable values.
 *
 * Mirrors what the XML pass does with element text: a scalar is filed under
 * its key, and its text also bubbles up through every enclosing object so a
 * condition on a container matches anything inside it. That is what makes
 * `categories contains Wkładki` find a record whose `categories.pol` holds it,
 * and what makes the record's own name a full-text search over the record.
 */
class JsonValues {
  values: RecordValues = new Map();
  private cursor = new JsonCursor();
  private names: string[] = [];
  private texts: string[] = [];

  reset(): void {
    this.values = new Map();
    this.cursor = new JsonCursor();
    this.names = [];
    this.texts = [];
  }

  private absorb(text: string): void {
    const top = this.texts.length - 1;
    if (top < 0) return;
    if (this.texts[top].length >= MAX_VALUE_CHARS) return;
    this.texts[top] = this.texts[top] ? `${this.texts[top]} ${text}` : text;
  }

  feed(tok: JsonToken): void {
    switch (tok.t) {
      case "{":
      case "[":
        // Arrays carry their key's name, so both are worth a text frame.
        this.names.push(this.cursor.nameFor());
        this.texts.push("");
        break;
      case "}":
      case "]": {
        const name = this.names.pop();
        const text = this.texts.pop() ?? "";
        if (name && text) addField(this.values, name, text);
        if (text) this.absorb(text);
        break;
      }
      case ",":
      case ":":
        break;
      default: {
        if (this.cursor.isKey(tok)) break;
        const text = tok.t === "string" ? tok.value : tok.raw;
        // `null` carries no value a user could usefully match on.
        if (!(tok.t === "literal" && tok.value === "null")) {
          addField(this.values, this.cursor.nameFor(), text);
          this.absorb(text);
        }
        break;
      }
    }
    this.cursor.feed(tok);
  }
}

export interface JsonQueryResult {
  matched: number;
  scanned: number;
  resultHistogram: DensityHistogram;
  matchHistogram: DensityHistogram;
}

/**
 * Second pass: streams the formatted document, evaluates every record, and
 * writes the survivors out as a JSON array.
 *
 * The result is a fresh array rather than the original document with holes in
 * it. Splicing records out of a nested wrapper means tracking which commas
 * are still needed after a drop, and a single mistake yields a file no parser
 * will read; rebuilding the array cannot produce invalid JSON at all. What it
 * costs is the wrapper — a feed shaped `{"meta":…,"products":[…]}` filters
 * down to just the products.
 */
export async function runJsonQuery(opts: {
  source: BackingStore;
  recordName: string;
  query: Query;
  indent: string;
  out: DocWriter;
  onProgress: (p: LoadProgress) => void;
  shouldCancel: () => boolean;
}): Promise<JsonQueryResult> {
  const { source, recordName, query, indent, out, onProgress, shouldCancel } = opts;
  const predicate = compileQuery(query);
  if (!predicate) throw new Error("Empty query: fill in the field and value boxes.");

  const tokenizer = new JsonTokenizer();
  const cursor = new JsonCursor();
  const collector = new JsonValues();
  const resultHistogram = new DensityHistogram();
  const matchHistogram = new DensityHistogram();

  /** Tokens of the record being read, replayed through a printer if it matches. */
  const capture: JsonToken[] = [];
  let capturing = false;
  let captureDepth = 0;
  let recordLine = 0;
  let matched = 0;
  let scanned = 0;

  const closeRecord = () => {
    scanned++;
    capturing = false;
    if (predicate(collector.values)) {
      const pieces: string[] = [];
      const printer = new JsonPrinter((s) => pieces.push(s), indent);
      for (const tok of capture) printer.feed(tok);
      printer.finish();

      out.write(matched === 0 ? "[\n" : ",\n");
      matched++;
      resultHistogram.add(out.line() + 1);
      matchHistogram.add(recordLine);
      // One level of indent, so the record sits inside the array it joins.
      out.write(
        pieces
          .join("")
          .split("\n")
          .map((line) => (line ? indent + line : line))
          .join("\n"),
      );
    }
    capture.length = 0;
  };

  const emit = (tok: JsonToken) => {
    const opens = tok.t === "{" || tok.t === "[";
    if (!capturing && opens && cursor.opensRecord(recordName)) {
      capturing = true;
      captureDepth = 0;
      capture.length = 0;
      collector.reset();
      recordLine = tokenizer.line;
    }
    cursor.feed(tok);

    if (!capturing) return;
    capture.push(tok);
    collector.feed(tok);

    if (opens) captureDepth++;
    else if (tok.t === "}" || tok.t === "]") {
      captureDepth--;
      if (captureDepth === 0) closeRecord();
    }
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

  out.write(matched === 0 ? "[]\n" : "\n]\n");

  return { matched, scanned, resultHistogram, matchHistogram };
}
