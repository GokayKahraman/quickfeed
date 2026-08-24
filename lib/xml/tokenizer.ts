/**
 * Streaming XML tokenizer.
 *
 * Feeds arrive as decoded string chunks of arbitrary size; tokens may straddle
 * chunk boundaries, so anything incomplete stays in `buf` until more data lands.
 * Nothing here ever holds more than one unterminated token plus the tail of the
 * current chunk, which is what keeps multi-gigabyte feeds inside a flat memory
 * budget.
 */

export type Token =
  | { t: "open"; name: string; raw: string; selfClose: boolean }
  | { t: "close"; name: string; raw: string }
  | { t: "text"; raw: string }
  | { t: "cdata"; raw: string }
  | { t: "comment"; raw: string }
  | { t: "pi"; raw: string }
  | { t: "doctype"; raw: string };

export type Emit = (tok: Token) => void;

/** Longest prefix we must see before we can classify a `<` construct. */
const LOOKAHEAD = 9; // "<![CDATA["

function readName(raw: string, from: number): string {
  let i = from;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    // space, tab, CR, LF, '/', '>'
    if (c === 32 || c === 9 || c === 13 || c === 10 || c === 47 || c === 62) break;
    i++;
  }
  return raw.slice(from, i);
}

export class XmlTokenizer {
  private buf = "";
  private pos = 0;

  push(chunk: string, emit: Emit): void {
    this.buf = this.pos > 0 ? this.buf.slice(this.pos) + chunk : this.buf + chunk;
    this.pos = 0;
    this.run(emit, false);
  }

  /** Flush whatever is left; an unterminated tail is reported as text. */
  end(emit: Emit): void {
    this.run(emit, true);
    if (this.pos < this.buf.length) {
      emit({ t: "text", raw: this.buf.slice(this.pos) });
    }
    this.buf = "";
    this.pos = 0;
  }

  private run(emit: Emit, final: boolean): void {
    const buf = this.buf;
    const len = buf.length;

    while (this.pos < len) {
      const lt = buf.indexOf("<", this.pos);

      if (lt === -1) {
        emit({ t: "text", raw: buf.slice(this.pos) });
        this.pos = len;
        return;
      }
      if (lt > this.pos) {
        emit({ t: "text", raw: buf.slice(this.pos, lt) });
        this.pos = lt;
      }

      // Not enough bytes to tell a comment from a CDATA from an element yet.
      if (!final && len - lt < LOOKAHEAD && !this.classifiable(buf, lt, len)) return;

      let end: number;

      if (buf.startsWith("<!--", lt)) {
        end = buf.indexOf("-->", lt + 4);
        if (end === -1) return this.stall(final, emit, "comment");
        end += 3;
        emit({ t: "comment", raw: buf.slice(lt, end) });
      } else if (buf.startsWith("<![CDATA[", lt)) {
        end = buf.indexOf("]]>", lt + 9);
        if (end === -1) return this.stall(final, emit, "cdata");
        end += 3;
        emit({ t: "cdata", raw: buf.slice(lt, end) });
      } else if (buf.startsWith("<?", lt)) {
        end = buf.indexOf("?>", lt + 2);
        if (end === -1) return this.stall(final, emit, "pi");
        end += 2;
        emit({ t: "pi", raw: buf.slice(lt, end) });
      } else if (buf.startsWith("<!", lt)) {
        end = findDoctypeEnd(buf, lt);
        if (end === -1) return this.stall(final, emit, "doctype");
        emit({ t: "doctype", raw: buf.slice(lt, end) });
      } else {
        end = findTagEnd(buf, lt);
        if (end === -1) return this.stall(final, emit, "tag");
        const raw = buf.slice(lt, end);
        if (raw.charCodeAt(1) === 47) {
          emit({ t: "close", name: readName(raw, 2), raw });
        } else {
          const selfClose = raw.charCodeAt(raw.length - 2) === 47;
          emit({ t: "open", name: readName(raw, 1), raw, selfClose });
        }
      }

      this.pos = end;
    }
  }

  /** True once we can decide which construct starts at `lt`. */
  private classifiable(buf: string, lt: number, len: number): boolean {
    const avail = len - lt;
    if (avail >= LOOKAHEAD) return true;
    if (avail < 2) return false;
    const c = buf.charCodeAt(lt + 1);
    // '?' and '/' and a name character are decidable from two chars.
    return c !== 33; // '!' still needs "--" or "[CDATA[" to disambiguate
  }

  /** Terminator missing: wait for more data, or salvage the tail at EOF. */
  private stall(final: boolean, emit: Emit, kind: string): void {
    if (!final) return;
    emit({ t: "text", raw: this.buf.slice(this.pos) });
    this.pos = this.buf.length;
    void kind;
  }
}

/** Finds the '>' that closes a tag, ignoring any inside attribute quotes. */
function findTagEnd(buf: string, from: number): number {
  let quote = 0;
  for (let i = from + 1; i < buf.length; i++) {
    const c = buf.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i + 1;
    }
  }
  return -1;
}

/** DOCTYPE may carry an internal subset in [ ... ] that contains '>'. */
function findDoctypeEnd(buf: string, from: number): number {
  let depth = 0;
  let quote = 0;
  for (let i = from + 2; i < buf.length; i++) {
    const c = buf.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 91) {
      depth++;
    } else if (c === 93) {
      depth--;
    } else if (c === 62 && depth <= 0) {
      return i + 1;
    }
  }
  return -1;
}

/** Strips CDATA wrappers and resolves the five XML entities plus numeric refs. */
export function decodeValue(raw: string): string {
  let s = raw;
  if (s.startsWith("<![CDATA[")) s = s.slice(9, s.length - 3);
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: return m;
    }
  });
}
