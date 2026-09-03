/// <reference lib="webworker" />

/**
 * Every expensive operation lives here: downloading, decoding, formatting,
 * indexing, querying and slicing lines. The main thread only ever receives
 * summaries and the handful of lines currently on screen.
 *
 * Three feed shapes share this one machine. Each has its own tokenizer and
 * printer, but from `DocWriter` outwards — the line index, the density tape,
 * the viewer, the find bar and the download — everything downstream is
 * format-blind, because all three write plain lines into the same store.
 */

import { createBackingStore, purgeTempFiles, type BackingStore } from "../store/backing";
import { DensityHistogram, DocReader, DocWriter, type LineIndex } from "../store/document";
import { formatStream, runQuery } from "../xml/pipeline";
import { formatJsonStream, runJsonQuery } from "../json/pipeline";
import { ROOT_ITEM } from "../json/formatter";
import { formatCsvStream, runCsvQuery, ROW_RECORD } from "../csv/pipeline";
import { Cancelled, maybeDecompress, peekStream } from "../format/read";
import { extensionFor, mimeFor, sniffFeed } from "../format/detect";
import { buildSearchRegex, describeQuery, foldForSearch } from "../xml/match";
import type {
  ColumnInfo,
  DocSummary,
  FeedFormat,
  FieldInfo,
  FindMatch,
  LoadProgress,
  WorkerRequest,
  WorkerResponse,
} from "../types";

interface OpenDoc {
  summary: DocSummary;
  store: BackingStore;
  index: LineIndex;
  reader: DocReader;
  /** Indent the document was written with, so a query pass matches it. */
  indent: string;
}

const docs = new Map<string, OpenDoc>();
/** Lines pulled per search batch; big enough to amortise, small enough to yield. */
const SEARCH_BATCH = 4096;
/** Hits kept for navigation. Beyond this the bar reports the total as "+". */
const MAX_MATCHES = 20000;
/** Bytes read before the format is decided. One header row is plenty. */
const SNIFF_BYTES = 64 * 1024;
const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

let cancelled = false;
let docSeq = 0;
/** Set while a download snapshot has the file handle closed. */
let snapshotting: Promise<void> | null = null;
/** Newest find request; an older scan sees the mismatch and bails out. */
let searchSeq = 0;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer ?? []);
}

function baseName(name: string): string {
  const cleaned = name.split(/[\\/]/).pop() ?? "feed";
  return (
    cleaned.replace(/\.(xml|rss|atom|txt|json|jsonl|ndjson|csv|tsv)?(\.gz)?$/i, "") || "feed"
  );
}

function slugify(s: string): string {
  return (
    s
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .toLowerCase() || "query"
  );
}

async function releaseAll(): Promise<void> {
  for (const doc of docs.values()) await doc.store.dispose();
  docs.clear();
}

/** Opens the feed as a byte stream, whichever way the user pointed at it. */
async function openSource(
  source: Extract<WorkerRequest, { type: "load" }>["source"],
  onProgress: (p: LoadProgress) => void,
): Promise<{ stream: ReadableStream<Uint8Array>; totalBytes: number | null; name: string }> {
  if (source.kind === "file") {
    const { stream, gzipped } = await maybeDecompress(source.file.stream());
    return {
      stream,
      totalBytes: gzipped ? null : source.file.size,
      name: source.file.name,
    };
  }

  onProgress({
    bytesRead: 0,
    totalBytes: null,
    linesWritten: 0,
    records: 0,
    phase: "download",
  });

  const target = source.viaProxy
    ? `/api/proxy?url=${encodeURIComponent(source.url)}`
    : source.url;

  let res: Response;
  try {
    res = await fetch(target, { redirect: "follow" });
  } catch (err) {
    throw new Error(
      source.viaProxy
        ? `Could not reach the address: ${(err as Error).message}`
        : 'The browser could not read this address directly (CORS). Turn on "Fetch through proxy" and try again.',
    );
  }
  if (!res.ok) throw new Error(`The server returned ${res.status} ${res.statusText}.`);
  if (!res.body) throw new Error("The response body is empty.");

  const encoded = res.headers.get("content-encoding");
  const declared = res.headers.get("content-length");
  const { stream, gzipped } = await maybeDecompress(res.body);

  let name = "feed";
  try {
    const path = new URL(source.url).pathname;
    const last = path.split("/").filter(Boolean).pop();
    if (last) name = decodeURIComponent(last);
  } catch {
    /* keep default */
  }

  return {
    stream,
    totalBytes: encoded || gzipped || !declared ? null : Number(declared),
    name,
  };
}

/** What every format's first pass has to report, whatever it parsed. */
interface Formatted {
  rootName: string | null;
  recordName: string | null;
  recordCount: number;
  /** Nesting level of the record, for picking the right density curve. */
  recordDepth: number;
  recordCandidates: FieldInfo[];
  fields: FieldInfo[];
  depthHistograms: DensityHistogram[];
  bytesRead: number;
  columns?: ColumnInfo[];
  raggedRows?: number;
}

async function formatByKind(
  format: FeedFormat,
  delimiter: string,
  stream: ReadableStream<Uint8Array>,
  totalBytes: number | null,
  writer: DocWriter,
  req: Extract<WorkerRequest, { type: "load" }>,
  onProgress: (p: LoadProgress) => void,
): Promise<Formatted> {
  const shouldCancel = () => cancelled;

  if (format === "csv") {
    const { shape, histogram, bytesRead } = await formatCsvStream({
      stream,
      totalBytes,
      out: writer,
      delimiter,
      onProgress,
      shouldCancel,
    });
    return {
      rootName: null,
      recordName: ROW_RECORD,
      recordCount: shape.recordCount,
      recordDepth: 1,
      recordCandidates: shape.recordCandidates,
      fields: shape.fields,
      depthHistograms: [histogram],
      bytesRead,
      columns: shape.columns,
      raggedRows: shape.raggedRows,
    };
  }

  if (format === "json") {
    const { shape, depthHistograms, bytesRead } = await formatJsonStream({
      stream,
      totalBytes,
      out: writer,
      indent: req.indent,
      onProgress,
      shouldCancel,
    });
    const recordName = shape.recordName() ?? ROOT_ITEM;
    const stat = shape.names.get(recordName);
    return {
      rootName: shape.rootName,
      recordName,
      recordCount: stat?.count ?? 0,
      recordDepth: stat?.minDepth ?? 1,
      recordCandidates: shape.recordCandidates(),
      fields: shape.fieldNames(),
      depthHistograms,
      bytesRead,
    };
  }

  const { shape, depthHistograms, bytesRead } = await formatStream({
    stream,
    totalBytes,
    out: writer,
    format: { indent: req.indent, collapseText: req.collapseText },
    onProgress,
    shouldCancel,
  });
  const recordName = shape.recordName();
  const stat = recordName ? shape.names.get(recordName) : null;
  return {
    rootName: shape.rootName,
    recordName,
    recordCount: stat?.count ?? 0,
    recordDepth: stat?.minDepth ?? 1,
    recordCandidates: shape.recordCandidates(),
    fields: shape.fieldNames(),
    depthHistograms,
    bytesRead,
  };
}

async function handleLoad(req: Extract<WorkerRequest, { type: "load" }>): Promise<void> {
  await releaseAll();
  const started = performance.now();
  const onProgress = (p: LoadProgress) => post({ id: req.id, type: "progress", progress: p });

  const opened = await openSource(req.source, onProgress);
  // Decide the format before building any parser, then replay the bytes that
  // the decision was made from so the parser still sees the feed from the top.
  const { stream, head } = await peekStream(opened.stream, SNIFF_BYTES);
  const { format, delimiter } = sniffFeed(head, opened.name);

  const id = `doc${++docSeq}`;
  const store = await createBackingStore(id);
  const writer = new DocWriter(store);

  let result: Formatted;
  try {
    result = await formatByKind(
      format,
      delimiter,
      stream,
      opened.totalBytes,
      writer,
      req,
      onProgress,
    );
  } catch (err) {
    await store.dispose();
    throw err;
  }

  const index = writer.close();
  const byDepth = result.depthHistograms.map((h) => h.finalize(index.lineCount));
  const depth = result.recordDepth;
  const histogram =
    depth >= 1 && depth <= byDepth.length ? byDepth[depth - 1] : (byDepth[0] ?? []);

  const summary: DocSummary = {
    id,
    kind: "source",
    label: opened.name,
    fileName: `${baseName(opened.name)}.formatted.${extensionFor(format, delimiter)}`,
    byteLength: index.byteLength,
    lineCount: index.lineCount,
    rootName: result.rootName,
    recordName: result.recordName,
    recordCount: result.recordCount,
    format,
    delimiter: format === "csv" ? delimiter : undefined,
    columns: result.columns,
    raggedRows: result.raggedRows,
    recordAuto: result.recordName,
    recordCandidates: result.recordCandidates,
    fields: result.fields,
    histogram,
    depthHistograms: byDepth,
    persistent: store.persistent,
    elapsedMs: Math.round(performance.now() - started),
    sourceBytes: result.bytesRead,
  };

  docs.set(id, {
    summary,
    store,
    index,
    reader: new DocReader(store, index),
    indent: req.indent,
  });
  post({ id: req.id, type: "doc", doc: summary });
}

interface Filtered {
  matched: number;
  scanned: number;
  resultHistogram: DensityHistogram;
  matchHistogram: DensityHistogram;
}

async function handleQuery(req: Extract<WorkerRequest, { type: "query" }>): Promise<void> {
  const src = docs.get(req.docId);
  if (!src) throw new Error("Source document not found.");
  const { format, delimiter } = src.summary;
  // The detected record tag is only a guess; the user can name a different one.
  const recordName = req.recordName?.trim() || src.summary.recordName;
  if (!recordName) {
    throw new Error(
      format === "csv"
        ? "This table has no rows to filter."
        : "No repeating record was found in this document. Pick one in the Record box.",
    );
  }

  // One result at a time; the previous one is dropped before a new one starts.
  for (const [key, doc] of [...docs]) {
    if (doc.summary.kind === "result") {
      await doc.store.dispose();
      docs.delete(key);
    }
  }

  const started = performance.now();
  const id = `doc${++docSeq}`;
  const store = await createBackingStore(id);
  const writer = new DocWriter(store);
  const onProgress = (p: LoadProgress) => post({ id: req.id, type: "progress", progress: p });
  const shouldCancel = () => cancelled;

  let result: Filtered;
  try {
    if (format === "csv") {
      result = await runCsvQuery({
        source: src.store,
        delimiter: delimiter || ",",
        query: req.query,
        out: writer,
        onProgress,
        shouldCancel,
      });
    } else if (format === "json") {
      result = await runJsonQuery({
        source: src.store,
        recordName,
        query: req.query,
        indent: src.indent,
        out: writer,
        onProgress,
        shouldCancel,
      });
    } else {
      result = await runQuery({
        source: src.store,
        recordName,
        query: req.query,
        format: { indent: "    ", collapseText: false },
        out: writer,
        onProgress,
        shouldCancel,
      });
    }
  } catch (err) {
    await store.dispose();
    throw err;
  }

  const index = writer.close();
  const description = describeQuery(req.query);
  const summary: DocSummary = {
    id,
    kind: "result",
    label: description,
    fileName: `${baseName(src.summary.label)}.${slugify(description)}.${extensionFor(
      format,
      delimiter,
    )}`,
    byteLength: index.byteLength,
    lineCount: index.lineCount,
    rootName: src.summary.rootName,
    recordName,
    recordCount: result.matched,
    format,
    delimiter,
    columns: src.summary.columns,
    recordAuto: src.summary.recordAuto,
    recordCandidates: src.summary.recordCandidates,
    fields: src.summary.fields,
    histogram: result.resultHistogram.finalize(index.lineCount),
    depthHistograms: [],
    persistent: store.persistent,
    elapsedMs: Math.round(performance.now() - started),
    query: req.query,
    matchHistogram: result.matchHistogram.finalize(src.summary.lineCount),
    scannedRecords: result.scanned,
  };

  docs.set(id, {
    summary,
    store,
    index,
    reader: new DocReader(store, index),
    indent: src.indent,
  });
  post({ id: req.id, type: "doc", doc: summary });
}

/**
 * Scans the whole document for a find query.
 *
 * The viewer only ever holds ~35 lines, so the browser's own find has nothing
 * to search — this walks every line through the index instead, in batches that
 * yield between them so a newer keystroke can supersede the scan and so the
 * worker stays responsive on a multi-million-line document.
 */
async function handleSearch(req: Extract<WorkerRequest, { type: "search" }>): Promise<void> {
  const token = ++searchSeq;
  const doc = docs.get(req.docId);
  if (!doc) throw new Error("Document not found.");

  const empty = { matches: [] as FindMatch[], total: 0, truncated: false };
  if (!req.query) {
    post({ id: req.id, type: "search", ...empty, superseded: false });
    return;
  }

  const { re, foldHaystack } = buildSearchRegex(req.query, req.options);
  const matches: FindMatch[] = [];
  let total = 0;
  const lineCount = doc.index.lineCount;

  for (let from = 0; from < lineCount; from += SEARCH_BATCH) {
    if (token !== searchSeq) {
      post({ id: req.id, type: "search", ...empty, superseded: true });
      return;
    }
    if (snapshotting) await snapshotting;

    const lines = doc.reader.lines(from, SEARCH_BATCH);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const hay = foldHaystack ? foldForSearch(raw) : raw;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(hay)) !== null) {
        // A pattern able to match nothing would spin forever otherwise.
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        total++;
        if (matches.length < MAX_MATCHES) {
          matches.push({ line: from + i, col: m.index, len: m[0].length });
        }
      }
    }
    await yieldToLoop();
  }

  post({
    id: req.id,
    type: "search",
    matches,
    total,
    truncated: total > matches.length,
    superseded: false,
  });
}

async function handle(req: WorkerRequest): Promise<void> {
  switch (req.type) {
    case "load":
      cancelled = false;
      await handleLoad(req);
      break;
    case "query":
      cancelled = false;
      await handleQuery(req);
      break;
    case "lines": {
      // Taking a download snapshot briefly closes the file handle.
      if (snapshotting) await snapshotting;
      const doc = docs.get(req.docId);
      if (!doc) throw new Error("Document not found.");
      post({
        id: req.id,
        type: "lines",
        from: req.from,
        lines: doc.reader.lines(req.from, req.count),
      });
      return;
    }
    case "search":
      await handleSearch(req);
      return;
    case "snapshot": {
      const doc = docs.get(req.docId);
      if (!doc) throw new Error("Document not found.");
      const pending = doc.store.snapshot(
        mimeFor(doc.summary.format, doc.summary.delimiter),
      );
      snapshotting = pending.then(
        () => undefined,
        () => undefined,
      );
      const blob = await pending;
      snapshotting = null;
      post({ id: req.id, type: "snapshot", blob, fileName: doc.summary.fileName });
      return;
    }
    case "release": {
      const doc = docs.get(req.docId);
      if (doc) {
        await doc.store.dispose();
        docs.delete(req.docId);
      }
      break;
    }
    case "cancel":
      cancelled = true;
      break;
  }
  post({ id: req.id, type: "done" });
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type === "cancel") {
    cancelled = true;
    post({ id: req.id, type: "done" });
    return;
  }
  handle(req).catch((err: unknown) => {
    const message =
      err instanceof Cancelled
        ? "Operation cancelled."
        : err instanceof Error
          ? err.message
          : String(err);
    post({ id: req.id, type: "error", message });
  });
};

void purgeTempFiles();
