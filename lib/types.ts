export type QueryOp = "contains" | "not_contains" | "exact";

export interface Condition {
  id: string;
  tag: string;
  op: QueryOp;
  value: string;
}

export interface Query {
  conditions: Condition[];
  combinator: "AND" | "OR";
  caseSensitive: boolean;
}

export interface FieldInfo {
  name: string;
  count: number;
  /** Shallowest nesting level the tag was seen at; the root sits at 0. */
  depth: number;
  /** True when the tag holds other elements rather than plain text. */
  container: boolean;
}

export interface DocSummary {
  id: string;
  kind: "source" | "result";
  /** Human label for the tab strip. */
  label: string;
  fileName: string;
  byteLength: number;
  lineCount: number;
  rootName: string | null;
  recordName: string | null;
  recordCount: number;
  /** Detected record tag; the user can override it per query. */
  recordAuto: string | null;
  /** Tags that could plausibly be the record, best guess first. */
  recordCandidates: FieldInfo[];
  fields: FieldInfo[];
  /** 512-bucket record density across the document, for the tape. */
  histogram: number[];
  /** Density per nesting level 1..4, so an overridden record tag still maps. */
  depthHistograms: number[][];
  /** True when bytes live in OPFS rather than RAM. */
  persistent: boolean;
  elapsedMs: number;
  query?: Query;
  /** Where the matches sit inside the source document. */
  matchHistogram?: number[];
  scannedRecords?: number;
  sourceBytes?: number;
  truncated?: boolean;
}

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One hit, addressed the way the viewer draws text: line, column, length. */
export interface FindMatch {
  line: number;
  col: number;
  len: number;
}

export interface FindResult {
  matches: FindMatch[];
  /** Hits found in the whole document, even past the collection cap. */
  total: number;
  truncated: boolean;
  /** True when a newer search replaced this one before it finished. */
  superseded: boolean;
}

export interface LoadProgress {
  bytesRead: number;
  totalBytes: number | null;
  linesWritten: number;
  records: number;
  phase: "download" | "format" | "query";
}

export type WorkerRequest =
  | {
      id: number;
      type: "load";
      source:
        | { kind: "file"; file: File }
        | { kind: "url"; url: string; viaProxy: boolean };
      indent: string;
      collapseText: boolean;
    }
  | { id: number; type: "lines"; docId: string; from: number; count: number }
  | { id: number; type: "query"; docId: string; query: Query; recordName?: string }
  | {
      id: number;
      type: "search";
      docId: string;
      query: string;
      options: FindOptions;
    }
  | { id: number; type: "snapshot"; docId: string }
  | { id: number; type: "release"; docId: string }
  | { id: number; type: "cancel" };

export type WorkerResponse =
  | { id: number; type: "progress"; progress: LoadProgress }
  | { id: number; type: "doc"; doc: DocSummary }
  | { id: number; type: "lines"; from: number; lines: string[] }
  | ({ id: number; type: "search" } & FindResult)
  | { id: number; type: "snapshot"; blob: Blob; fileName: string }
  | { id: number; type: "done" }
  | { id: number; type: "error"; message: string };

export const OP_LABELS: Record<QueryOp, string> = {
  contains: "contains",
  not_contains: "does not contain",
  exact: "matches exactly",
};
