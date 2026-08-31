import type { Token } from "./tokenizer";
import type { FieldInfo } from "../types";

export interface FormatOptions {
  /** Indent unit: 2 spaces, 4 spaces, or a tab. */
  indent: string;
  /** Collapse newlines inside text/CDATA so every field stays on one line. */
  collapseText: boolean;
}

export const DEFAULT_FORMAT: FormatOptions = { indent: "    ", collapseText: false };

/** Cap on inline buffering before a text node is spilled to its own lines. */
const MAX_INLINE = 512 * 1024;

const NEWLINE_IN_TAG = /[\r\n]+[ \t]*/g;
const ANY_NEWLINE = /[\r\n]+[ \t]*/g;
const XML_DECL = /^<\?xml\b/i;
const DECL_ENCODING = /(\bencoding\s*=\s*)(["'])[^"']*\2/i;

/**
 * Output is always UTF-8, so a declaration inherited from an ISO-8859-9 feed
 * has to be corrected — otherwise the downloaded file announces an encoding
 * it is not written in.
 */
function retargetDeclaration(raw: string): string {
  if (!XML_DECL.test(raw)) return raw;
  return raw.replace(DECL_ENCODING, '$1"UTF-8"');
}

/**
 * Turns a token stream into indented XML.
 *
 * An element whose only content is text stays on one line (`<id>3213</id>`);
 * an element that contains other elements is broken across lines. Output goes
 * out through `sink`, which the caller can swap mid-stream — the query pass
 * uses that to divert one record into a buffer while it decides whether to
 * keep it.
 */
export class PrettyPrinter {
  sink: (s: string) => void;
  private opts: FormatOptions;
  private depth = 0;
  private started = false;
  private inlineOpen = false;
  private textBuf = "";
  private pads: string[] = [];

  constructor(sink: (s: string) => void, opts: FormatOptions = DEFAULT_FORMAT) {
    this.sink = sink;
    this.opts = opts;
    for (let i = 0; i < 64; i++) this.pads.push(opts.indent.repeat(i));
  }

  get currentDepth(): number {
    return this.depth;
  }

  feed(tok: Token): void {
    switch (tok.t) {
      case "open": {
        this.spillInline();
        this.newline();
        this.sink(tok.raw.replace(NEWLINE_IN_TAG, " "));
        if (!tok.selfClose) {
          this.depth++;
          this.inlineOpen = true;
          this.textBuf = "";
        }
        break;
      }
      case "close": {
        if (this.depth > 0) this.depth--;
        if (this.inlineOpen) {
          this.sink(this.normalize(this.textBuf).trim() + tok.raw);
          this.inlineOpen = false;
          this.textBuf = "";
        } else {
          this.newline();
          this.sink(tok.raw);
        }
        break;
      }
      case "text":
      case "cdata": {
        if (this.inlineOpen) {
          this.textBuf += tok.raw;
          if (this.textBuf.length > MAX_INLINE) this.spillInline();
        } else {
          const t = this.normalize(tok.raw).trim();
          if (t) {
            this.newline();
            this.sink(t);
          }
        }
        break;
      }
      case "pi": {
        this.spillInline();
        this.newline();
        this.sink(retargetDeclaration(tok.raw.replace(NEWLINE_IN_TAG, " ")));
        break;
      }
      case "comment":
      case "doctype": {
        this.spillInline();
        this.newline();
        this.sink(tok.raw);
        break;
      }
    }
  }

  finish(): void {
    this.spillInline();
  }

  private normalize(s: string): string {
    return this.opts.collapseText ? s.replace(ANY_NEWLINE, " ") : s;
  }

  /** Give up on keeping the open element inline; write any buffered text now. */
  private spillInline(): void {
    if (!this.inlineOpen) return;
    const t = this.normalize(this.textBuf).trim();
    if (t) this.sink(t);
    this.inlineOpen = false;
    this.textBuf = "";
  }

  private newline(): void {
    if (!this.started) {
      this.started = true;
      return;
    }
    this.sink("\n");
    if (this.depth > 0) {
      this.sink(this.depth < 64 ? this.pads[this.depth] : this.opts.indent.repeat(this.depth));
    }
  }
}

export interface NameStat {
  count: number;
  hasChildren: boolean;
  minDepth: number;
  /** First parent this name was seen under; feeds are regular enough for one. */
  parent: string | null;
}

const MAX_TRACKED_NAMES = 5000;

/**
 * Walks the same token stream as the printer and works out the document's
 * shape: which element is the root, which repeating element is the record
 * (`<product>`, `<item>`, ...), and every field name a query could target.
 */
export class ShapeCollector {
  readonly names = new Map<string, NameStat>();
  rootName: string | null = null;
  elementCount = 0;
  maxDepth = 0;
  private stack: string[] = [];

  /** Nesting depth of the element that would open next; the root sits at 0. */
  get depth(): number {
    return this.stack.length;
  }

  feed(tok: Token): void {
    if (tok.t === "open") {
      const depth = this.stack.length;
      if (depth === 0 && this.rootName === null) this.rootName = tok.name;
      if (depth > 0) {
        const parent = this.names.get(this.stack[depth - 1]);
        if (parent) parent.hasChildren = true;
      }
      const stat = this.names.get(tok.name);
      if (stat) {
        stat.count++;
        if (depth < stat.minDepth) stat.minDepth = depth;
      } else if (this.names.size < MAX_TRACKED_NAMES) {
        this.names.set(tok.name, {
          count: 1,
          hasChildren: false,
          minDepth: depth,
          parent: depth > 0 ? this.stack[depth - 1] : null,
        });
      }
      this.elementCount++;
      if (!tok.selfClose) {
        this.stack.push(tok.name);
        if (this.stack.length > this.maxDepth) this.maxDepth = this.stack.length;
      }
    } else if (tok.t === "close") {
      if (this.stack.length > 0) this.stack.pop();
    }
  }

  /**
   * How record-like an element is: how many times it repeats inside a single
   * instance of its parent.
   *
   * Raw frequency is the wrong signal. In a Ticimax feed `<TeknikDetay>`
   * appears 27,217 times to `<Urun>`'s 1,063, because every product carries
   * about 26 of them — so counting alone picks the detail row over the
   * product. Dividing by the parent's own count separates the two cleanly:
   * `<Urun>` repeats 1,063 times inside the single `<Urunler>`, while
   * `<TeknikDetay>` repeats only ~26 times inside each `<TeknikDetaylar>`.
   */
  private fanOut(s: NameStat): number {
    const parentCount = s.parent ? (this.names.get(s.parent)?.count ?? 1) : 1;
    return s.count / Math.max(1, parentCount);
  }

  /**
   * Best guess at the record element: the container with the highest fan-out.
   * Only ever a guess — the caller can override it.
   */
  recordName(): string | null {
    const ranked = this.recordCandidates(1);
    if (ranked.length > 0) return ranked[0].name;
    let best: string | null = null;
    let bestCount = 0;
    for (const [name, s] of this.names) {
      if (name === this.rootName) continue;
      if (s.count > bestCount) {
        best = name;
        bestCount = s.count;
      }
    }
    return best;
  }

  /**
   * Plausible record elements, best first. Containers rank above leaves,
   * then by fan-out, then by shallowness.
   */
  recordCandidates(limit = 60): FieldInfo[] {
    const out: (FieldInfo & { score: number })[] = [];
    for (const [name, s] of this.names) {
      if (name === this.rootName || s.count < 2) continue;
      out.push({
        name,
        count: s.count,
        depth: s.minDepth,
        container: s.hasChildren,
        score: this.fanOut(s),
      });
    }
    out.sort(
      (a, b) =>
        Number(b.container) - Number(a.container) ||
        b.score - a.score ||
        a.depth - b.depth ||
        a.name.localeCompare(b.name),
    );
    return out.slice(0, limit).map(({ name, count, depth, container }) => ({
      name,
      count,
      depth,
      container,
    }));
  }

  /** Field names for the query bar, most frequent first. */
  fieldNames(limit = 400): FieldInfo[] {
    const out: FieldInfo[] = [];
    for (const [name, s] of this.names) {
      if (name === this.rootName) continue;
      out.push({ name, count: s.count, depth: s.minDepth, container: s.hasChildren });
    }
    out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return out.slice(0, limit);
  }
}
