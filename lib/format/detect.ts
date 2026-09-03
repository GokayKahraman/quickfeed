import { detectEncoding } from "./read";
import type { FeedFormat } from "../types";

export interface FormatGuess {
  format: FeedFormat;
  /** Field separator; only meaningful for delimited text. */
  delimiter: string;
}

/** Separators worth testing. */
const SEPARATORS = [",", "\t", ";", "|"] as const;

/** How much of the head is decoded for sniffing. */
const SNIFF_CHARS = 64 * 1024;

/** Quote-aware field count for one physical line. */
function fieldCount(line: string, sep: string): number {
  let n = 1;
  let quoted = false;
  const d = sep.charCodeAt(0);
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (quoted) {
      if (c === 34) {
        if (line.charCodeAt(i + 1) === 34) i++;
        else quoted = false;
      }
    } else if (c === 34) {
      quoted = true;
    } else if (c === d) {
      n++;
    }
  }
  return n;
}

/**
 * Picks the separator that carves the sample into the most *consistent* number
 * of columns.
 *
 * Counting occurrences would be wrong. The Google Merchant `.txt` feed this was
 * tested against is tab-separated, but its description column is full of prose
 * — so commas outnumber tabs across the file by a wide margin. What separates
 * them is regularity: every line has exactly 20 tabs, while the comma count
 * swings from 0 to 30. Scoring consistency first and column count second picks
 * the tab, which is the real separator.
 */
export function detectDelimiter(sample: string): string {
  const lines = sample
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    // The last line of a truncated sample is usually cut mid-row.
    .slice(0, 25);
  if (lines.length === 0) return ",";
  const usable = lines.length > 1 ? lines.slice(0, -1) : lines;

  let best = ",";
  let bestScore = -1;
  for (const sep of SEPARATORS) {
    // Every sampled line counts, including the ones this separator fails to
    // split. Scoring only the lines where a separator happens to appear would
    // hand a perfect record to a comma that shows up in one prose cell and
    // nowhere else.
    const counts = usable.map((l) => fieldCount(l, sep));

    const freq = new Map<number, number>();
    for (const n of counts) freq.set(n, (freq.get(n) ?? 0) + 1);
    let mode = 0;
    let modeCount = 0;
    for (const [n, c] of freq) {
      if (c > modeCount || (c === modeCount && n > mode)) {
        mode = n;
        modeCount = c;
      }
    }
    // A separator that usually yields one field is not a separator at all.
    if (mode < 2) continue;

    // Consistency dominates; column count only breaks ties between separators
    // that are equally regular.
    const score = (modeCount / counts.length) * 1000 + Math.min(mode, 999) / 1000;
    if (score > bestScore) {
      bestScore = score;
      best = sep;
    }
  }
  return best;
}

/**
 * Works out what kind of feed this is from its opening bytes.
 *
 * Content decides, never the extension or the content-type. The `.txt` feeds
 * Google Merchant expects are tab-separated tables; one of the feeds this was
 * tested against announces itself as `text/x-comma-separated-values` while
 * being tab-separated. The file name is only consulted when the bytes are
 * genuinely ambiguous.
 */
export function sniffFeed(head: Uint8Array, fileName: string): FormatGuess {
  const { label, skip } = detectEncoding(head);
  let text: string;
  try {
    text = new TextDecoder(label, { fatal: false }).decode(
      head.subarray(skip, Math.min(head.length, skip + SNIFF_CHARS)),
    );
  } catch {
    text = new TextDecoder("utf-8").decode(head.subarray(0, SNIFF_CHARS));
  }
  const body = text.replace(/^\uFEFF/, "").replace(/^\s+/, "");

  // A tag, a declaration, a comment or a doctype all start an XML document.
  if (/^<[?!a-zA-Z]/.test(body)) return { format: "xml", delimiter: "," };
  // An array, an object, or newline-delimited JSON records.
  if (body[0] === "[" || body[0] === "{") return { format: "json", delimiter: "," };

  if (!body) {
    const ext = /\.(\w+)(?:\.gz)?$/i.exec(fileName)?.[1]?.toLowerCase();
    if (ext === "json" || ext === "ndjson" || ext === "jsonl") {
      return { format: "json", delimiter: "," };
    }
    if (ext === "tsv") return { format: "csv", delimiter: "\t" };
    if (ext === "csv") return { format: "csv", delimiter: "," };
    return { format: "xml", delimiter: "," };
  }

  return { format: "csv", delimiter: detectDelimiter(body) };
}

/** Extension the formatted document is offered for download under. */
export function extensionFor(format: FeedFormat, delimiter = ","): string {
  if (format === "json") return "json";
  if (format === "csv") return delimiter === "\t" ? "tsv" : "csv";
  return "xml";
}

export function mimeFor(format: FeedFormat, delimiter = ","): string {
  if (format === "json") return "application/json";
  if (format === "csv") {
    return delimiter === "\t" ? "text/tab-separated-values" : "text/csv";
  }
  return "application/xml";
}

export function formatLabel(format: FeedFormat, delimiter = ","): string {
  if (format === "json") return "JSON";
  if (format === "csv") return delimiter === "\t" ? "tab-separated" : "delimited text";
  return "XML";
}

const SEPARATOR_NAMES: Record<string, string> = {
  ",": "comma",
  "\t": "tab",
  ";": "semicolon",
  "|": "pipe",
};

export function delimiterName(delimiter: string): string {
  return SEPARATOR_NAMES[delimiter] ?? delimiter;
}
