import { XmlTokenizer, decodeValue, type Token } from "./tokenizer";
import { PrettyPrinter, ShapeCollector, type FormatOptions } from "./formatter";
import { DensityHistogram, DocWriter } from "../store/document";
import type { BackingStore } from "../store/backing";
import type { LoadProgress, Query } from "../types";
import { compileQuery, type RecordValues } from "./match";

const PROGRESS_MS = 120;
const READ_CHUNK = 2 * 1024 * 1024;
/** Per-record guards so one malformed giant record cannot exhaust memory. */
const MAX_FIELDS_PER_RECORD = 512;
const MAX_VALUE_CHARS = 64 * 1024;

export class Cancelled extends Error {
  constructor() {
    super("Operation cancelled.");
  }
}

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

function countNewlines(s: string): number {
  let n = 0;
  let i = s.indexOf("\n");
  while (i !== -1) {
    n++;
    i = s.indexOf("\n", i + 1);
  }
  return n;
}

/**
 * Picks a decoder from the BOM or the XML declaration.
 *
 * Turkish marketplace feeds are still routinely served as ISO-8859-9 or
 * windows-1254; decoding those as UTF-8 turns every ş and ğ into replacement
 * characters, so the declaration is honoured before anything else happens.
 */
export function detectEncoding(head: Uint8Array): { label: string; skip: number } {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { label: "utf-8", skip: 3 };
  }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    return { label: "utf-16le", skip: 2 };
  }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    return { label: "utf-16be", skip: 2 };
  }
  let ascii = "";
  const n = Math.min(head.length, 1024);
  for (let i = 0; i < n; i++) ascii += String.fromCharCode(head[i]);
  const m = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(ascii);
  if (m) {
    const label = m[1].toLowerCase();
    try {
      new TextDecoder(label);
      return { label, skip: 0 };
    } catch {
      /* unknown label, fall back */
    }
  }
  return { label: "utf-8", skip: 0 };
}

/**
 * Transparently unwraps gzip-compressed feeds (`.xml.gz` is common).
 *
 * The caller is told whether decompression happened, because a compressed
 * source makes the announced byte total meaningless as a progress denominator.
 */
export async function maybeDecompress(
  stream: ReadableStream<Uint8Array>,
): Promise<{ stream: ReadableStream<Uint8Array>; gzipped: boolean }> {
  const reader = stream.getReader();
  const first = await reader.read();
  const head = first.value ?? new Uint8Array(0);
  const gzipped = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

  const rebuilt = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length) controller.enqueue(head);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else if (value) controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  if (!gzipped || typeof DecompressionStream === "undefined") {
    return { stream: rebuilt, gzipped: false };
  }
  // DecompressionStream is typed as accepting BufferSource, which does not line
  // up with ReadableStream<Uint8Array> in lib.dom; the runtime contract is fine.
  const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return { stream: rebuilt.pipeThrough(gunzip), gzipped: true };
}

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
  const reader = stream.getReader();
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

  let decoder: TextDecoder | null = null;
  let bytesRead = 0;
  let lastReport = 0;

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

  try {
    for (;;) {
      if (shouldCancel()) throw new Cancelled();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      let bytes = value;
      if (!decoder) {
        const detected = detectEncoding(bytes);
        decoder = new TextDecoder(detected.label, { fatal: false });
        if (detected.skip) bytes = bytes.subarray(detected.skip);
      }
      bytesRead += value.length;
      tokenizer.push(decoder.decode(bytes, { stream: true }), emit);

      const now = performance.now();
      if (now - lastReport > PROGRESS_MS) {
        lastReport = now;
        onProgress({
          bytesRead,
          totalBytes,
          linesWritten: out.line(),
          records: Math.max(depthCounts[0], depthCounts[1]),
          phase: "format",
        });
        await yieldToLoop();
      }
    }
    if (decoder) tokenizer.push(decoder.decode(), emit);
    tokenizer.end(emit);
    printer.finish();
  } finally {
    reader.releaseLock();
  }

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
  const decoder = new TextDecoder("utf-8");
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
  let lastReport = 0;
  let bytesRead = 0;

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
  for (let offset = 0; offset < total; offset += READ_CHUNK) {
    if (shouldCancel()) throw new Cancelled();
    const bytes = source.read(offset, Math.min(offset + READ_CHUNK, total));
    bytesRead += bytes.length;
    tokenizer.push(decoder.decode(bytes, { stream: true }), emit);

    const now = performance.now();
    if (now - lastReport > PROGRESS_MS) {
      lastReport = now;
      onProgress({
        bytesRead,
        totalBytes: total,
        linesWritten: out.line(),
        records: matched,
        phase: "query",
      });
    }
    await yieldToLoop();
  }
  tokenizer.push(decoder.decode(), emit);
  tokenizer.end(emit);
  printer.finish();

  return { matched, scanned, resultHistogram, matchHistogram };
}
