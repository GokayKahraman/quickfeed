import type { FeedFormat } from "../lib/types";

export interface Span {
  c: string;
  t: string;
}

/**
 * Colours one already-formatted line.
 *
 * Only ever runs on the rows currently on screen, so it can afford to be a
 * plain left-to-right scan rather than anything clever. Delimited documents
 * are drawn as a table instead and never come through here.
 */
export function highlightLine(line: string, format: FeedFormat = "xml"): Span[] {
  return format === "json" ? highlightJson(line) : highlightXml(line);
}

/** Accumulates spans, merging runs that share a class. */
function collector(): { push: (c: string, t: string) => void; out: Span[] } {
  const out: Span[] = [];
  return {
    out,
    push(c, t) {
      if (!t) return;
      const last = out[out.length - 1];
      if (last && last.c === c) last.t += t;
      else out.push({ c, t });
    },
  };
}

function highlightXml(line: string): Span[] {
  const { push, out } = collector();
  let i = 0;
  const n = line.length;

  while (i < n) {
    const lt = line.indexOf("<", i);
    if (lt === -1) {
      push("t-text", line.slice(i));
      break;
    }
    if (lt > i) push("t-text", line.slice(i, lt));

    if (line.startsWith("<!--", lt)) {
      const end = line.indexOf("-->", lt + 4);
      const stop = end === -1 ? n : end + 3;
      push("t-comment", line.slice(lt, stop));
      i = stop;
      continue;
    }

    if (line.startsWith("<![CDATA[", lt)) {
      push("t-cdata", "<![CDATA[");
      const end = line.indexOf("]]>", lt + 9);
      if (end === -1) {
        push("t-text", line.slice(lt + 9));
        break;
      }
      push("t-text", line.slice(lt + 9, end));
      push("t-cdata", "]]>");
      i = end + 3;
      continue;
    }

    if (line.startsWith("<?", lt) || line.startsWith("<!", lt)) {
      const end = line.indexOf(">", lt);
      const stop = end === -1 ? n : end + 1;
      push("t-cdata", line.slice(lt, stop));
      i = stop;
      continue;
    }

    // Element tag: punctuation, name, then attributes until the closing '>'.
    const close = line.charCodeAt(lt + 1) === 47;
    push("t-punct", close ? "</" : "<");
    let j = lt + (close ? 2 : 1);
    const nameStart = j;
    while (j < n && !/[\s/>]/.test(line[j])) j++;
    push("t-name", line.slice(nameStart, j));

    while (j < n) {
      const ch = line[j];
      if (ch === ">") {
        push("t-punct", ">");
        j++;
        break;
      }
      if (ch === "/" && line[j + 1] === ">") {
        push("t-punct", "/>");
        j += 2;
        break;
      }
      if (/\s/.test(ch)) {
        const ws = j;
        while (j < n && /\s/.test(line[j])) j++;
        push("t-attr", line.slice(ws, j));
        continue;
      }
      const attrStart = j;
      while (j < n && !/[\s=/>]/.test(line[j])) j++;
      push("t-attr", line.slice(attrStart, j));
      if (line[j] === "=") {
        push("t-punct", "=");
        j++;
        const quote = line[j];
        if (quote === '"' || quote === "'") {
          const end = line.indexOf(quote, j + 1);
          const stop = end === -1 ? n : end + 1;
          push("t-val", line.slice(j, stop));
          j = stop;
        }
      }
    }
    i = j;
  }

  return out;
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
 * Colours a line of pretty-printed JSON.
 *
 * A string is a key when the next non-space character is a colon, which is all
 * the context a single line can offer and all this needs: the printer always
 * puts a key and its colon on the same line.
 */
function highlightJson(line: string): Span[] {
  const { push, out } = collector();
  let i = 0;
  const n = line.length;

  while (i < n) {
    const c = line.charCodeAt(i);

    if (c === 32 || c === 9) {
      let j = i;
      while (j < n && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
      push("t-text", line.slice(i, j));
      i = j;
      continue;
    }

    if (c === 34) {
      const end = stringEnd(line, i);
      let k = end;
      while (k < n && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
      push(line.charCodeAt(k) === 58 ? "t-name" : "t-val", line.slice(i, end));
      i = end;
      continue;
    }

    // { } [ ] : ,
    if (c === 123 || c === 125 || c === 91 || c === 93 || c === 58 || c === 44) {
      push("t-punct", line[i]);
      i++;
      continue;
    }

    if (c === 45 || (c >= 48 && c <= 57)) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(line[j])) j++;
      push("t-num", line.slice(i, j));
      i = j;
      continue;
    }

    if (line.startsWith("true", i) || line.startsWith("null", i)) {
      push("t-lit", line.slice(i, i + 4));
      i += 4;
      continue;
    }
    if (line.startsWith("false", i)) {
      push("t-lit", "false");
      i += 5;
      continue;
    }

    push("t-text", line[i]);
    i++;
  }

  return out;
}

/**
 * Overlays find hits onto syntax spans.
 *
 * The two colourings are computed independently — one from the document's
 * structure, one from character offsets — so spans are split wherever a hit
 * starts or ends and the pieces inside a hit pick up the highlight class.
 */
export function applyHits(
  spans: Span[],
  hits: { col: number; len: number; current: boolean }[],
): Span[] {
  if (hits.length === 0) return spans;
  const out: Span[] = [];
  let col = 0;
  for (const span of spans) {
    const start = col;
    const end = col + span.t.length;
    col = end;
    let cursor = start;
    for (const hit of hits) {
      const from = Math.max(cursor, hit.col);
      const to = Math.min(end, hit.col + hit.len);
      if (to <= from) continue;
      if (from > cursor) out.push({ c: span.c, t: span.t.slice(cursor - start, from - start) });
      out.push({
        c: `${span.c} hit${hit.current ? " current" : ""}`,
        t: span.t.slice(from - start, to - start),
      });
      cursor = to;
    }
    if (cursor < end) out.push({ c: span.c, t: span.t.slice(cursor - start) });
  }
  return out;
}
