import type { FeedFormat } from "../types";

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
