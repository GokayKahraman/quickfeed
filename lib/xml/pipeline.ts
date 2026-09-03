import { XmlTokenizer, decodeValue, type Token } from "./tokenizer";
import { PrettyPrinter, ShapeCollector, type FormatOptions } from "./formatter";
import { DensityHistogram, DocWriter } from "../store/document";
import type { BackingStore } from "../store/backing";
import type { LoadProgress, Query } from "../types";
import { compileQuery, type RecordValues } from "./match";

import {
  MAX_FIELDS_PER_RECORD,
  MAX_VALUE_CHARS,
  countNewlines,
  pumpStore,
  pumpStream,
} from "../format/read";

export interface FormatResult {
  shape: ShapeCollector;
  /** Record density per nesting depth 1..4; the right one is picked afterwards. */
  depthHistograms: DensityHistogram[];
  bytesRead: number;
}

/**
 * Reads the raw feed, writes formatted XML into `out`, and learns the
 * document's shape in the same pass. Nothing but the current chunk and one
 * unterminated token is ever held in memory.
 */
export async function formatStream(opts: {
  stream: ReadableStream<Uint8Array>;
  totalBytes: number | null;
  out: DocWriter;
  format: FormatOptions;
  onProgress: (p: LoadProgress) => void;
  shouldCancel: () => boolean;
}): Promise<FormatResult> {
  const { stream, totalBytes, out, format, onProgress, shouldCancel } = opts;
  const tokenizer = new XmlTokenizer();
  const shape = new ShapeCollector();
  const printer = new PrettyPrinter((s) => out.write(s), format);
  const depthHistograms = [
    new DensityHistogram(),
    new DensityHistogram(),
    new DensityHistogram(),
    new DensityHistogram(),
  ];
  const depthCounts = [0, 0, 0, 0];

  const emit = (tok: Token) => {
    if (tok.t === "open" && !tok.selfClose) {
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

  return { shape, depthHistograms, bytesRead };
}

export interface QueryResult {
  matched: number;
  scanned: number;
  /** Record positions inside the result document. */
  resultHistogram: DensityHistogram;
  /** The same matches projected onto the source document's line space. */
  matchHistogram: DensityHistogram;
}

/**
 * Second pass: streams the already-formatted document, evaluates each record
 * against the query, and writes the survivors into a new document. The header
 * and footer around the records (`<rss><channel>…`) pass straight through, so
 * the result is a valid feed rather than a bag of fragments.
 */
export async function runQuery(opts: {
  source: BackingStore;
  recordName: string;
  query: Query;
  format: FormatOptions;
  out: DocWriter;
  onProgress: (p: LoadProgress) => void;
  shouldCancel: () => boolean;
}): Promise<QueryResult> {
  const { source, recordName, query, format, out, onProgress, shouldCancel } = opts;
  const predicate = compileQuery(query);
  if (!predicate) throw new Error("Empty query: fill in the tag and value fields.");

  const tokenizer = new XmlTokenizer();
  const captureBuf: string[] = [];
  const outSink = (s: string) => out.write(s);
  const capSink = (s: string) => captureBuf.push(s);
  const printer = new PrettyPrinter(outSink, format);

  const resultHistogram = new DensityHistogram();
  const matchHistogram = new DensityHistogram();

  let capturing = false;
  const nameStack: string[] = [];
  const textStack: string[] = [];
  let values: RecordValues = new Map();
  let recordSourceLine = 0;
  let sourceLine = 0;
  let matched = 0;
  let scanned = 0;

  const emit = (tok: Token) => {
    if (!capturing && tok.t === "open" && !tok.selfClose && tok.name === recordName) {
      capturing = true;
      captureBuf.length = 0;
      nameStack.length = 0;
      textStack.length = 0;
      values = new Map();
      recordSourceLine = sourceLine;
      printer.sink = capSink;
    }

    printer.feed(tok);
    sourceLine += countNewlines(tok.raw);

    if (!capturing) return;

    switch (tok.t) {
      case "open":
        if (!tok.selfClose) {
          nameStack.push(tok.name);
          textStack.push("");
        }
        break;
      case "text":
      case "cdata": {
        const top = textStack.length - 1;
        if (top > 0 && textStack[top].length < MAX_VALUE_CHARS) {
          textStack[top] += tok.raw;
        }
        break;
      }
      case "close": {
        const name = nameStack.pop();
        const text = textStack.pop();
        // Stored even at nameStack depth 0, so the record tag itself is
        // queryable as "anywhere in this record".
        if (name !== undefined && text) {
          const trimmed = decodeValue(text).trim();
          if (trimmed) {
            const list = values.get(name);
            if (list) list.push(trimmed);
            else if (values.size < MAX_FIELDS_PER_RECORD) values.set(name, [trimmed]);
          }
        }
        // A container like <category> holds no text of its own, so child text
        // bubbles up. That makes "category contains Shirt" match a record whose
        // <sub> is Shirt, and makes the record tag itself a full-text search.
        const parent = textStack.length - 1;
        if (text && parent >= 0 && textStack[parent].length < MAX_VALUE_CHARS) {
          textStack[parent] += ` ${text}`;
        }
        if (nameStack.length === 0) {
          scanned++;
          capturing = false;
          printer.sink = outSink;
          if (predicate(values)) {
            matched++;
            resultHistogram.add(out.line() + 1);
            matchHistogram.add(recordSourceLine);
            for (const piece of captureBuf) out.write(piece);
          }
          captureBuf.length = 0;
        }
        break;
      }
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
  printer.finish();

  return { matched, scanned, resultHistogram, matchHistogram };
}
