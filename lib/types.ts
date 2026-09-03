export type QueryOp = "contains" | "not_contains" | "exact";

/**
 * Feed shapes the app can open.
 *
 * `csv` covers every delimited table — comma, tab, semicolon or pipe — because
 * the separator is a property of the file, not of its extension. A Google
 * Merchant `.txt` feed is tab-separated; a `.csv` from a German shop is often
 * semicolon-separated. The delimiter travels alongside on `DocSummary`.
 */
export type FeedFormat = "xml" | "json" | "csv";

export interface ColumnInfo {
  name: string;
  /** Widest cell seen while formatting, in characters, capped for display. */
  width: number;
}

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

/**
 * How the user signs in to a protected feed.
 *
 * Held in memory for the length of one fetch and never persisted: not in
 * localStorage, not in the URL, not in the shareable `feedlink` link. A feed
 * password in a query string ends up in browser history and in every access
 * log between here and the host.
 *
 * The four here are the ones that are decided before the request leaves —
 * a header, or a query parameter. See `lib/auth.ts` for why the handshake and
 * signing schemes are named back to the user instead.
 */
export type FeedAuth =
  | { type: "none" }
  | { type: "basic"; username: string; password: string }
  | { type: "bearer"; token: string }
  /** `in` is the difference between `X-API-Key: …` and `?api_key=…`. */
  | { type: "apikey"; key: string; value: string; in: "header" | "query" };

export type AuthType = FeedAuth["type"];

/**
 * A feed answering "not without a sign-in".
 *
 * Carried out of the worker as data rather than as wording in an error
 * message, because the app has to *act* on it — put the sign-in in front of
 * the user and retry — and matching on prose to decide that would break the
 * first time the copy was reworded.
 */
export interface AuthChallenge {
  /** Scheme named in `WWW-Authenticate`, when the host named one. */
  scheme: string | null;
  /** Realm the host labelled the area with; shown to help identify the login. */
  realm: string | null;
  /** True when a sign-in was sent and refused, false when none was offered. */
  rejected: boolean;
  /**
   * The scheme read off the header, when it is one the app can perform.
   *
   * Null when the host named nothing — which is the common case for feed APIs
   * — and the user has to say which kind of sign-in they were given.
   */
  suggested: AuthType | null;
  /** The type that was tried, so a refusal can say what it refused. */
  attempted: AuthType | null;
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
  /** How the bytes were parsed; drives display, querying and the extension. */
  format: FeedFormat;
  /** Field separator, when `format` is csv. */
  delimiter?: string;
  /** Column order and measured widths, for the table view. */
  columns?: ColumnInfo[];
  /** Rows whose field count did not match the header. */
  raggedRows?: number;
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
        | { kind: "url"; url: string; viaProxy: boolean; auth?: FeedAuth };
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
  | {
      id: number;
      type: "error";
      message: string;
      /** Set when the failure was a feed asking to be signed in to. */
      authChallenge?: AuthChallenge;
    };

export const OP_LABELS: Record<QueryOp, string> = {
  contains: "contains",
  not_contains: "does not contain",
  exact: "matches exactly",
};
