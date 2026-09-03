import type { JsonToken } from "./tokenizer";
import { ShapeCollector } from "../xml/formatter";
import type { FieldInfo } from "../types";

/** An all-scalar array shorter than this prints on one line. */
const INLINE_BUDGET = 96;

/** Name given to the elements of a nameless top-level array. */
export const ROOT_ITEM = "item";
/** Synthetic element wrapping the whole document, so a root has a name. */
export const ROOT_NAME = "root";

interface Frame {
  kind: "object" | "array";
  /** Children written so far, buffered ones included. */
  count: number;
  /** Committed to multi-line layout. */
  expanded: boolean;
  /** Scalar children of an array that may still print inline. */
  buf: string[];
  bufLen: number;
}

/**
 * Pretty-prints a JSON token stream.
 *
 * Objects always break across lines. An array holding nothing but short
 * scalars stays on one line — `"sizes": ["36", "37", "38"]` reads far better
 * than eleven lines of one number each, and product feeds are full of them.
 * The decision is made without lookahead: scalars are buffered until either
 * the array closes (print inline) or the budget is passed (flush what was
 * buffered as separate lines and carry on expanded).
 *
 * Separators are regenerated rather than copied, so the input's own commas are
 * ignored. That is what lets the query pass reprint an arbitrary subset of a
 * document and still get valid JSON out.
 */
export class JsonPrinter {
  sink: (s: string) => void;
  private indent: string;
  private pads: string[] = [];
  private stack: Frame[] = [];
  private afterColon = false;
  private wroteTopLevel = false;

  constructor(sink: (s: string) => void, indent = "  ") {
    this.sink = sink;
    this.indent = indent;
    for (let i = 0; i < 64; i++) this.pads.push(indent.repeat(i));
  }

  private pad(depth: number): string {
    return depth < 64 ? this.pads[depth] : this.indent.repeat(depth);
  }

  private top(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  feed(tok: JsonToken): void {
    switch (tok.t) {
      case "{":
      case "[":
        this.openContainer(tok.t === "{" ? "object" : "array");
        return;
      case "}":
      case "]":
        this.closeContainer(tok.t);
        return;
      case ",":
        // Separators are ours to place; the input's are redundant.
        return;
      case ":":
        this.sink(": ");
        this.afterColon = true;
        return;
      default:
        break;
    }

    const f = this.top();
    if (f?.kind === "object" && !this.afterColon) {
      // A string in key position; its value follows after the colon.
      this.beginChild(f);
      this.sink(tok.raw);
      return;
    }
    const inKeySlot = this.afterColon;
    this.afterColon = false;
    this.writeValue(tok.raw, inKeySlot);
  }

  finish(): void {
    // Unterminated containers are left as they are; a truncated document is
    // the tokenizer's news to break, not the printer's.
  }

  private openContainer(kind: "object" | "array"): void {
    const f = this.top();
    if (this.afterColon) {
      this.afterColon = false;
    } else if (f) {
      // A nested container can never sit inside an inline array.
      if (!f.expanded) this.expand(f);
      this.beginChild(f);
    } else {
      this.beginTopLevel();
    }
    this.sink(kind === "object" ? "{" : "[");
    this.stack.push({ kind, count: 0, expanded: kind === "object", buf: [], bufLen: 0 });
  }

  private closeContainer(ch: "}" | "]"): void {
    const f = this.stack.pop();
    if (!f) {
      this.sink(ch);
      return;
    }
    if (f.buf.length > 0) {
      this.sink(f.buf.join(", "));
      this.sink(ch);
      return;
    }
    if (f.count === 0) {
      this.sink(ch);
      return;
    }
    this.sink("\n" + this.pad(this.stack.length) + ch);
  }

  private writeValue(raw: string, inKeySlot: boolean): void {
    const f = this.top();
    if (!f) {
      this.beginTopLevel();
      this.sink(raw);
      return;
    }
    // A value after `key:` goes straight where the colon left off — the child
    // slot, and its separator, were already opened by the key.
    if (inKeySlot) {
      this.sink(raw);
      return;
    }
    if (!f.expanded) {
      const extra = raw.length + (f.buf.length ? 2 : 0);
      if (f.bufLen + extra <= INLINE_BUDGET) {
        f.buf.push(raw);
        f.bufLen += extra;
        f.count++;
        return;
      }
      this.expand(f);
    }
    this.beginChild(f);
    this.sink(raw);
  }

  /** Commits a buffered array to multi-line layout, replaying what it held. */
  private expand(f: Frame): void {
    const held = f.buf;
    f.buf = [];
    f.bufLen = 0;
    f.expanded = true;
    for (let i = 0; i < held.length; i++) {
      if (i > 0) this.sink(",");
      this.sink("\n" + this.pad(this.stack.length));
      this.sink(held[i]);
    }
  }

  private beginChild(f: Frame): void {
    if (f.count > 0) this.sink(",");
    this.sink("\n" + this.pad(this.stack.length));
    f.count++;
  }

  /** Newline-delimited JSON arrives as several values with no container. */
  private beginTopLevel(): void {
    if (this.wroteTopLevel) this.sink("\n");
    this.wroteTopLevel = true;
  }
}

interface CursorFrame {
  kind: "object" | "array";
  /** Element name this container and — for an array — its items answer to. */
  name: string;
  lastKey: string | null;
  expectKey: boolean;
}

/**
 * Tracks where in the document the token stream currently is, and what to call
 * the thing being read.
 *
 * Names follow XML's repeated-element convention, which is what lets one query
 * engine serve both formats: the objects inside `"products": [...]` are each
 * called `products`, exactly as `<products><products>` would be read if the
 * feed were XML. Items of a nameless top-level array are called `item`.
 */
export class JsonCursor {
  readonly stack: CursorFrame[] = [];
  private afterColon = false;

  get depth(): number {
    return this.stack.length;
  }

  /** What an element opened here would be called. Call before `feed`. */
  nameFor(): string {
    const top = this.stack[this.stack.length - 1];
    if (!top) return ROOT_NAME;
    if (top.kind === "array") return top.name;
    return top.lastKey ?? top.name;
  }

  /** True when `tok` sits in key position rather than value. Call before `feed`. */
  isKey(tok: JsonToken): boolean {
    if (tok.t !== "string") return false;
    const top = this.stack[this.stack.length - 1];
    return !!top && top.kind === "object" && top.expectKey && !this.afterColon;
  }

  /** True when a container opening here is one of `recordName`'s records. */
  opensRecord(recordName: string): boolean {
    return this.nameFor() === recordName;
  }

  feed(tok: JsonToken): void {
    const top = this.stack[this.stack.length - 1];
    switch (tok.t) {
      case "{":
      case "[": {
        const kind = tok.t === "{" ? "object" : "array";
        let name: string;
        if (!top) name = kind === "array" ? ROOT_ITEM : ROOT_NAME;
        else if (top.kind === "array") name = top.name;
        else name = top.lastKey ?? top.name;
        this.stack.push({ kind, name, lastKey: null, expectKey: kind === "object" });
        this.afterColon = false;
        return;
      }
      case "}":
      case "]":
        this.stack.pop();
        this.afterColon = false;
        return;
      case ":":
        this.afterColon = true;
        return;
      case ",":
        if (top?.kind === "object") {
          top.expectKey = true;
          top.lastKey = null;
        }
        this.afterColon = false;
        return;
      default:
        if (top?.kind === "object" && top.expectKey && !this.afterColon && tok.t === "string") {
          top.lastKey = tok.value;
          top.expectKey = false;
        } else {
          this.afterColon = false;
        }
        return;
    }
  }
}

/**
 * Learns the document's shape by replaying it as XML elements.
 *
 * A key holding a scalar is a leaf element; a key holding an object or array
 * is a container; array items repeat under the array's name. Feeding those
 * through the same `ShapeCollector` the XML path uses means record detection,
 * the fan-out ranking and the field list behave identically across formats
 * instead of drifting apart in two implementations.
 */
export class JsonShape {
  private collector = new ShapeCollector();
  private cursor = new JsonCursor();

  constructor() {
    // One synthetic wrapper, so the document has a root the way XML does and
    // the real top-level value stays eligible to be the record.
    this.collector.feed({ t: "open", name: ROOT_NAME, raw: "", selfClose: false });
  }

  get rootName(): string | null {
    return this.collector.rootName;
  }

  get names() {
    return this.collector.names;
  }

  /** Nesting level the next element would sit at. Read it before `feed`. */
  get depth(): number {
    return this.collector.depth;
  }

  /** True when this token opens something the shape counts as an element. */
  static opensElement(tok: JsonToken): boolean {
    return tok.t === "{";
  }

  feed(tok: JsonToken): void {
    switch (tok.t) {
      case "{":
        this.collector.feed({
          t: "open",
          name: this.cursor.nameFor(),
          raw: "",
          selfClose: false,
        });
        break;
      case "}":
        this.collector.feed({ t: "close", name: "", raw: "" });
        break;
      // An array is a collection, not an element. Leaving it out is what makes
      // `"products": [ {…}, {…} ]` read as N elements named `products` — the
      // same shape XML would report for `<products>` repeated N times — rather
      // than one array wrapper sitting at a different depth from its own items
      // and stealing their name.
      case "[":
      case "]":
      case ",":
      case ":":
        break;
      default: {
        if (this.cursor.isKey(tok)) break;
        // A scalar is a leaf element named after its key, or after the array
        // holding it.
        const name = this.cursor.nameFor();
        this.collector.feed({ t: "open", name, raw: "", selfClose: false });
        this.collector.feed({ t: "close", name, raw: "" });
        break;
      }
    }

    this.cursor.feed(tok);
  }

  finish(): void {
    this.collector.feed({ t: "close", name: ROOT_NAME, raw: "" });
  }

  recordName(): string | null {
    return this.collector.recordName();
  }

  recordCandidates(limit?: number): FieldInfo[] {
    return this.collector.recordCandidates(limit);
  }

  fieldNames(limit?: number): FieldInfo[] {
    return this.collector.fieldNames(limit);
  }
}
