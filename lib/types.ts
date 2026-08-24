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
  fields: FieldInfo[];
  /** 512-bucket record density across the document, for the tape. */
  histogram: number[];
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
  | { id: number; type: "query"; docId: string; query: Query }
  | { id: number; type: "snapshot"; docId: string }
  | { id: number; type: "release"; docId: string }
  | { id: number; type: "cancel" };

export type WorkerResponse =
  | { id: number; type: "progress"; progress: LoadProgress }
  | { id: number; type: "doc"; doc: DocSummary }
  | { id: number; type: "lines"; from: number; lines: string[] }
  | { id: number; type: "snapshot"; blob: Blob; fileName: string }
  | { id: number; type: "done" }
  | { id: number; type: "error"; message: string };

export const OP_LABELS: Record<QueryOp, string> = {
  contains: "contains",
  not_contains: "does not contain",
  exact: "matches exactly",
};
