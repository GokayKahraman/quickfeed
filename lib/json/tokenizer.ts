/**
 * Streaming JSON lexer.
 *
 * Emits one token per JSON lexeme. Anything it cannot finish — a string whose
 * closing quote has not arrived, a number that may still gain digits — stays
 * in `buf` until the next chunk, so a value may straddle any number of chunk
 * boundaries. Nothing larger than one unterminated token plus the tail of the
 * current chunk is ever held.
 *
 * Structure is not validated here; that is the cursor's job. A lexer that
 * stays out of grammar is what lets the same token stream feed the printer,
 * the shape collector and the query pass without three parsers.
 */

export type JsonToken =
  | { t: "{" }
  | { t: "}" }
  | { t: "[" }
  | { t: "]" }
  | { t: "," }
  | { t: ":" }
  | { t: "string"; raw: string; value: string }
  | { t: "number"; raw: string }
  | { t: "literal"; raw: string; value: "true" | "false" | "null" };

export type JsonEmit = (tok: JsonToken) => void;

const LITERALS = ["true", "false", "null"] as const;

/** Resolves the escapes in a raw JSON string literal, quotes included. */
export function decodeJsonString(raw: string): string {
  const inner =
    raw.length >= 2 && raw.charCodeAt(0) === 34 && raw.charCodeAt(raw.length - 1) === 34
      ? raw.slice(1, -1)
      : raw.replace(/^"/, "");
  if (inner.indexOf("\\") === -1) return inner;

  let out = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner.charCodeAt(i) !== 92) {
      out += inner[i];
      continue;
    }
    const n = inner[++i];
    switch (n) {
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "u": {
        const code = parseInt(inner.slice(i + 1, i + 5), 16);
        if (Number.isFinite(code)) {
          out += String.fromCharCode(code);
          i += 4;
        } else {
          out += n;
        }
        break;
      }
      default:
        if (n !== undefined) out += n;
        break;
    }
  }
  return out;
}

export class JsonTokenizer {
  private buf = "";
  private pos = 0;
  /** Physical lines consumed from the input so far. */
  line = 0;

  push(chunk: string, emit: JsonEmit): void {
    this.buf = this.pos > 0 ? this.buf.slice(this.pos) + chunk : this.buf + chunk;
    this.pos = 0;
    this.run(emit, false);
  }

  end(emit: JsonEmit): void {
    this.run(emit, true);
    this.buf = "";
    this.pos = 0;
  }

  private skipSpace(): void {
    const buf = this.buf;
    while (this.pos < buf.length) {
      const c = buf.charCodeAt(this.pos);
      if (c === 10) this.line++;
      else if (c !== 13 && c !== 9 && c !== 32) return;
      this.pos++;
    }
  }

  private run(emit: JsonEmit, final: boolean): void {
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.buf.length) return;

      const c = this.buf.charCodeAt(this.pos);

      switch (c) {
        case 123: emit({ t: "{" }); this.pos++; continue;
        case 125: emit({ t: "}" }); this.pos++; continue;
        case 91: emit({ t: "[" }); this.pos++; continue;
        case 93: emit({ t: "]" }); this.pos++; continue;
        case 44: emit({ t: "," }); this.pos++; continue;
        case 58: emit({ t: ":" }); this.pos++; continue;
      }

      if (c === 34) {
        const end = this.stringEnd(final);
        if (end === -1) return;
        const raw = this.buf.slice(this.pos, end);
        emit({ t: "string", raw, value: decodeJsonString(raw) });
        this.pos = end;
        continue;
      }

      if (c === 45 || (c >= 48 && c <= 57)) {
        const end = this.numberEnd(final);
        if (end === -1) return;
        emit({ t: "number", raw: this.buf.slice(this.pos, end) });
        this.pos = end;
        continue;
      }

      const lit = this.literalEnd(final);
      if (lit === null) return;
      emit({ t: "literal", raw: lit, value: lit as "true" | "false" | "null" });
      this.pos += lit.length;
    }
  }

  /** Index just past the closing quote, or -1 while it has not arrived. */
  private stringEnd(final: boolean): number {
    const buf = this.buf;
    let i = this.pos + 1;
    while (i < buf.length) {
      const c = buf.charCodeAt(i);
      if (c === 92) {
        // A `\uXXXX` needs five more characters before it can be skipped.
        if (buf.charCodeAt(i + 1) === 117) {
          if (i + 6 > buf.length) return final ? buf.length : -1;
          i += 6;
          continue;
        }
        if (i + 2 > buf.length) return final ? buf.length : -1;
        i += 2;
        continue;
      }
      if (c === 34) return i + 1;
      if (c === 10) this.line++;
      i++;
    }
    return final ? buf.length : -1;
  }

  /**
   * A number ends where a non-number character begins, so it cannot be
   * emitted until that character is in hand — otherwise `1` at a chunk
   * boundary would be emitted before the `23` that completes it.
   */
  private numberEnd(final: boolean): number {
    const buf = this.buf;
    let i = this.pos;
    if (buf.charCodeAt(i) === 45) i++;
    while (i < buf.length && buf.charCodeAt(i) >= 48 && buf.charCodeAt(i) <= 57) i++;
    if (buf.charCodeAt(i) === 46) {
      i++;
      while (i < buf.length && buf.charCodeAt(i) >= 48 && buf.charCodeAt(i) <= 57) i++;
    }
    const e = buf.charCodeAt(i);
    if (e === 101 || e === 69) {
      i++;
      const sign = buf.charCodeAt(i);
      if (sign === 43 || sign === 45) i++;
      while (i < buf.length && buf.charCodeAt(i) >= 48 && buf.charCodeAt(i) <= 57) i++;
    }
    if (i >= buf.length && !final) return -1;
    return i;
  }

  private literalEnd(final: boolean): string | null {
    const rest = this.buf.slice(this.pos, this.pos + 5);
    for (const word of LITERALS) {
      if (rest.startsWith(word)) return word;
      // "tru" at the end of a chunk is not yet wrong, just incomplete.
      if (!final && word.startsWith(rest)) return null;
    }
    throw new Error(
      `This does not look like JSON: unexpected ${JSON.stringify(rest.slice(0, 1))} on line ${this.line + 1}.`,
    );
  }
}
