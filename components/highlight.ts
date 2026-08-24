export interface Span {
  c: string;
  t: string;
}

/**
 * Colours one already-formatted line of XML.
 *
 * Only ever runs on the lines currently on screen, so it can afford to be a
 * plain left-to-right scan rather than anything clever.
 */
export function highlightLine(line: string): Span[] {
  const out: Span[] = [];
  const push = (c: string, t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.c === c) last.t += t;
    else out.push({ c, t });
  };

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
