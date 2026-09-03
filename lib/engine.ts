import type {
  AuthChallenge,
  DocSummary,
  FeedFormat,
  FindOptions,
  FindResult,
  LoadProgress,
  Query,
  WorkerRequest,
  WorkerResponse,
} from "./types";

/**
 * The rejection a caller can answer, rather than only report.
 *
 * `load` rejects with this when the feed asked to be signed in to, so the page
 * can put the sign-in in front of the user and run the same load again.
 */
export class FeedAuthError extends Error {
  constructor(
    message: string,
    readonly challenge: AuthChallenge,
  ) {
    super(message);
    this.name = "FeedAuthError";
  }
}

/** Omit that distributes over the request union instead of collapsing it. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Pending = {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
  onProgress?: (p: LoadProgress) => void;
};

/**
 * Typed request/response channel to the feed worker.
 *
 * Requests are matched to responses by id so several line fetches can be in
 * flight while a query is still running.
 */
export class FeedEngine {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL("./worker/feed.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.receive(ev.data);
    this.worker.onerror = (ev) => {
      const error = new Error(ev.message || "The worker stopped unexpectedly.");
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
  }

  private receive(msg: WorkerResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.type === "progress") {
      entry.onProgress?.(msg.progress);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === "error") {
      entry.reject(
        msg.authChallenge
          ? new FeedAuthError(msg.message, msg.authChallenge)
          : new Error(msg.message),
      );
    }
    else entry.resolve(msg as never);
  }

  private send<T extends WorkerResponse>(
    req: DistributiveOmit<WorkerRequest, "id">,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: never) => void,
        reject,
        onProgress,
      });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  load(
    source: Extract<WorkerRequest, { type: "load" }>["source"],
    opts: { indent: string; collapseText: boolean },
    onProgress: (p: LoadProgress) => void,
  ): Promise<DocSummary> {
    return this.send<Extract<WorkerResponse, { type: "doc" }>>(
      { type: "load", source, ...opts },
      onProgress,
    ).then((m) => m.doc);
  }

  query(
    docId: string,
    query: Query,
    recordName: string | null,
    onProgress: (p: LoadProgress) => void,
  ): Promise<DocSummary> {
    return this.send<Extract<WorkerResponse, { type: "doc" }>>(
      { type: "query", docId, query, recordName: recordName ?? undefined },
      onProgress,
    ).then((m) => m.doc);
  }

  lines(docId: string, from: number, count: number): Promise<string[]> {
    return this.send<Extract<WorkerResponse, { type: "lines" }>>({
      type: "lines",
      docId,
      from,
      count,
    }).then((m) => m.lines);
  }

  search(docId: string, query: string, options: FindOptions): Promise<FindResult> {
    return this.send<Extract<WorkerResponse, { type: "search" }>>({
      type: "search",
      docId,
      query,
      options,
    });
  }

  snapshot(docId: string): Promise<{ blob: Blob; fileName: string }> {
    return this.send<Extract<WorkerResponse, { type: "snapshot" }>>({
      type: "snapshot",
      docId,
    }).then((m) => ({ blob: m.blob, fileName: m.fileName }));
  }

  release(docId: string): Promise<unknown> {
    return this.send({ type: "release", docId });
  }

  cancel(): void {
    this.worker.postMessage({ id: ++this.seq, type: "cancel" } as WorkerRequest);
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}

/**
 * How to name the thing a record is, in the vocabulary of its own format.
 *
 * An XML feed has `<product>` tags, a JSON feed has `products` keys, and a
 * table just has rows — writing angle brackets around all three would be
 * wrong twice over.
 */
export function recordLabel(format: FeedFormat, name: string | null): string {
  if (!name) return "records";
  if (format === "xml") return `<${name}>`;
  if (format === "csv") return "rows";
  return name;
}

/** The word for one field of a record, for placeholders and prompts. */
export function fieldWord(format: FeedFormat): string {
  if (format === "xml") return "tag";
  if (format === "csv") return "column";
  return "key";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Hands a blob to the browser's downloader without copying it in memory. */
export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
