import type { FeedFormat } from "../types";
import { decodeValue } from "../xml/tokenizer";

/**
 * Where a formatted line sits in the nesting.
 *
 * `open` starts something that closes on a later line, `close` ends one, and
 * `flat` is everything self-contained: a leaf element, an inline array, a
 * comment, a stray line of text.
 */
export type LineRole = "open" | "close" | "flat";

export interface LineShape {
  role: LineRole;
  /** Leading whitespace characters. One indent unit per nesting level. */
  indent: number;
}

/**
 * Reads a line's role and depth straight off its text.
 *
 * This works because the lines were not found in the wild — `PrettyPrinter`
 * and `JsonPrinter` wrote them, and both pad every line with exactly one
 * indent unit per level, closing tag included. So an element's opening line
 * and its closing line always carry the same indentation, and the first
 * closing line at that same indentation after an open is that open's own
 * close: everything in between belongs to children, which are deeper.
 *
 * The one text a printer does not control is a multi-line text node with
 * `collapseText` off — its continuation lines land at column 0. They read as
 * `flat` at indent 0, which only matters for an element at the very top of the
 * document, and copying a whole root is capped for other reasons anyway.
 */
export function shapeOf(line: string, format: FeedFormat): LineShape {
  return format === "json" ? jsonShape(line) : xmlShape(line);
}

/** Strips up to `width` characters of leading whitespace, and no more. */
export function stripIndent(line: string, width: number): string {
  let i = 0;
  while (i < width && isSpace(line.charCodeAt(i))) i++;
  return i === 0 ? line : line.slice(i);
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9;
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && isSpace(line.charCodeAt(i))) i++;
  return i;
}

/** Index just past the `>` of the tag starting at `from`, quotes respected. */
function endOfTag(line: string, from: number): number {
  let quote = 0;
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i + 1;
    }
  }
  return line.length;
}

/**
 * Whether a closing tag follows on the same line.
 *
 * CDATA is skipped rather than scanned: `<![CDATA[</p>]]>` holds a `</` that
 * closes nothing, and a text node long enough to be spilled onto the opening
 * line is exactly where that shows up.
 */
function hasCloseTag(line: string, from: number): boolean {
  for (let i = from; i < line.length; i++) {
    if (line.charCodeAt(i) !== 60) continue;
    if (line.startsWith("<![CDATA[", i)) {
      const end = line.indexOf("]]>", i + 9);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    if (line.charCodeAt(i + 1) === 47) return true;
  }
  return false;
}

function xmlShape(line: string): LineShape {
  const indent = indentOf(line);
  if (line.charCodeAt(indent) !== 60) return { role: "flat", indent };
  if (line.startsWith("</", indent)) return { role: "close", indent };
  // Declarations, comments and doctypes never span lines here.
  if (line.startsWith("<?", indent) || line.startsWith("<!", indent)) {
    return { role: "flat", indent };
  }
  const tagEnd = endOfTag(line, indent);
  if (line.charCodeAt(tagEnd - 2) === 47) return { role: "flat", indent };
  return hasCloseTag(line, tagEnd) ? { role: "flat", indent } : { role: "open", indent };
}

/** End of a JSON string literal starting at `from`, quotes included. */
function stringEnd(line: string, from: number): number {
  for (let i = from + 1; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 92) {
      i++;
      continue;
    }
    if (c === 34) return i + 1;
  }
  return line.length;
}

/**
 * JSON's role comes from the line's net bracket depth, which is what tells
 * `"sizes": ["36", "37"]` — an inline array, self-contained — apart from
 * `"colors": [`, which opens one. Counting brackets is the only way to see
 * the difference; both lines end in a bracket.
 */
function jsonShape(line: string): LineShape {
  const indent = indentOf(line);
  let depth = 0;
  for (let i = indent; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 34) {
      i = stringEnd(line, i) - 1;
      continue;
    }
    if (c === 123 || c === 91) depth++;
    else if (c === 125 || c === 93) depth--;
  }
  if (depth > 0) return { role: "open", indent };
  if (depth < 0) return { role: "close", indent };
  return { role: "flat", indent };
}

/**
 * The value of a block that holds no other element, or null when it does.
 *
 * `<id>3000</id>` gives `3000`, `<fiyat para="TRY">199.00</fiyat>` gives
 * `199.00`, and `"name": "Ceket"` gives `Ceket` — the text a reader means to
 * paste somewhere else, without the markup around it. Entities are resolved
 * and CDATA unwrapped for the same reason: `&amp;` in a spreadsheet cell is a
 * bug, not a value. An element with children is left to be copied whole.
 *
 * `block` is the dedented text `handleBlock` collected, starting at the tag.
 */
export function leafValue(block: string, format: FeedFormat): string | null {
  return format === "json" ? jsonLeafValue(block) : xmlLeafValue(block);
}

const CLOSE_TAIL = /<\/[^<>]*>\s*$/;

function xmlLeafValue(block: string): string | null {
  if (block.charCodeAt(0) !== 60) return null;
  if (block.startsWith("</") || block.startsWith("<?") || block.startsWith("<!")) return null;
  const openEnd = endOfTag(block, 0);
  // `<aktif/>` holds nothing at all, which is still a value: an empty one.
  if (block.charCodeAt(openEnd - 2) === 47) return "";
  const tail = CLOSE_TAIL.exec(block);
  if (!tail || tail.index < openEnd) return null;
  const inner = block.slice(openEnd, tail.index);

  let out = "";
  let i = 0;
  while (i < inner.length) {
    const lt = inner.indexOf("<", i);
    if (lt === -1) {
      out += decodeValue(inner.slice(i));
      break;
    }
    out += decodeValue(inner.slice(i, lt));
    if (!inner.startsWith("<![CDATA[", lt)) return null; // a child element, comment or PI
    const end = inner.indexOf("]]>", lt + 9);
    if (end === -1) return null;
    out += inner.slice(lt + 9, end);
    i = end + 3;
  }
  return out.trim();
}

function jsonLeafValue(block: string): string | null {
  if (block.charCodeAt(0) !== 34) return null;
  let i = stringEnd(block, 0);
  while (isSpace(block.charCodeAt(i))) i++;
  if (block.charCodeAt(i) !== 58) return null;
  const value = block.slice(i + 1).trim();

  // A key inside the value means it holds other fields; copy it whole.
  // An array of plain values has none and comes out as the array itself.
  for (let k = 0; k < value.length; k++) {
    const c = value.charCodeAt(k);
    if (c === 34) {
      k = stringEnd(value, k) - 1;
      continue;
    }
    if (c === 58) return null;
  }
  if (value.charCodeAt(0) === 34) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return null;
    }
  }
  return value;
}
