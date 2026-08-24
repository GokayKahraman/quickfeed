/// <reference lib="webworker" />

/**
 * Every expensive operation lives here: downloading, decoding, formatting,
 * indexing, querying and slicing lines. The main thread only ever receives
 * summaries and the handful of lines currently on screen.
 */

import { createBackingStore, purgeTempFiles, type BackingStore } from "../store/backing";
import { DocReader, DocWriter, type LineIndex } from "../store/document";
import { formatStream, maybeDecompress, runQuery, Cancelled } from "../xml/pipeline";
import { describeQuery } from "../xml/match";
import type { DocSummary, LoadProgress, WorkerRequest, WorkerResponse } from "../types";

interface OpenDoc {
  summary: DocSummary;
  store: BackingStore;
  index: LineIndex;
  reader: DocReader;
}

const docs = new Map<string, OpenDoc>();
let cancelled = false;
let docSeq = 0;
/** Set while a download snapshot has the file handle closed. */
let snapshotting: Promise<void> | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer ?? []);
}

function baseName(name: string): string {
  const cleaned = name.split(/[\\/]/).pop() ?? "feed";
  return cleaned.replace(/\.(xml|rss|atom|txt)?(\.gz)?$/i, "") || "feed";
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

  let name = "feed.xml";
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

async function handleLoad(req: Extract<WorkerRequest, { type: "load" }>): Promise<void> {
  await releaseAll();
  const started = performance.now();
  const onProgress = (p: LoadProgress) => post({ id: req.id, type: "progress", progress: p });

  const { stream, totalBytes, name } = await openSource(req.source, onProgress);
  const id = `doc${++docSeq}`;
  const store = await createBackingStore(id);
  const writer = new DocWriter(store);
  const format = { indent: req.indent, collapseText: req.collapseText };

  let result;
  try {
    result = await formatStream({
      stream,
      totalBytes,
      out: writer,
      format,
      onProgress,
      shouldCancel: () => cancelled,
    });
  } catch (err) {
    await store.dispose();
    throw err;
  }

  const index = writer.close();
  const { shape, depthHistograms } = result;
  const recordName = shape.recordName();
  const stat = recordName ? shape.names.get(recordName) : null;
  const depth = stat ? stat.minDepth : 1;
  const histogram = (
    depth >= 1 && depth <= 4 ? depthHistograms[depth - 1] : depthHistograms[0]
  ).finalize(index.lineCount);

  const summary: DocSummary = {
    id,
    kind: "source",
    label: name,
    fileName: `${baseName(name)}.formatted.xml`,
    byteLength: index.byteLength,
    lineCount: index.lineCount,
    rootName: shape.rootName,
    recordName,
    recordCount: stat ? stat.count : 0,
    fields: shape.fieldNames(),
    histogram,
    persistent: store.persistent,
    elapsedMs: Math.round(performance.now() - started),
    sourceBytes: result.bytesRead,
  };

  docs.set(id, { summary, store, index, reader: new DocReader(store, index) });
  post({ id: req.id, type: "doc", doc: summary });
}

async function handleQuery(req: Extract<WorkerRequest, { type: "query" }>): Promise<void> {
  const src = docs.get(req.docId);
  if (!src) throw new Error("Source document not found.");
  if (!src.summary.recordName) {
    throw new Error("No repeating record tag was found in this document, so it cannot be filtered.");
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

  let result;
  try {
    result = await runQuery({
      source: src.store,
      recordName: src.summary.recordName,
      query: req.query,
      format: { indent: "    ", collapseText: false },
      out: writer,
      onProgress: (p) => post({ id: req.id, type: "progress", progress: p }),
      shouldCancel: () => cancelled,
    });
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
    fileName: `${baseName(src.summary.label)}.${slugify(description)}.xml`,
    byteLength: index.byteLength,
    lineCount: index.lineCount,
    rootName: src.summary.rootName,
    recordName: src.summary.recordName,
    recordCount: result.matched,
    fields: src.summary.fields,
    histogram: result.resultHistogram.finalize(index.lineCount),
    persistent: store.persistent,
    elapsedMs: Math.round(performance.now() - started),
    query: req.query,
    matchHistogram: result.matchHistogram.finalize(src.summary.lineCount),
    scannedRecords: result.scanned,
  };

  docs.set(id, { summary, store, index, reader: new DocReader(store, index) });
  post({ id: req.id, type: "doc", doc: summary });
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
    case "snapshot": {
      const doc = docs.get(req.docId);
      if (!doc) throw new Error("Document not found.");
      const pending = doc.store.snapshot(doc.summary.fileName);
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
