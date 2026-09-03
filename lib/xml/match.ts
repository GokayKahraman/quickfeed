import type { Condition, Query } from "../types";
import { MAX_FIELDS_PER_RECORD, MAX_VALUE_CHARS } from "../format/read";

/**
 * Case- and diacritic-insensitive folding, tuned for Turkish feeds.
 *
 * Plain `toLowerCase()` turns "İSTANBUL" into a dotted-i sequence that never
 * matches a typed "istanbul", and feed data mixes "Kırmızı"/"KIRMIZI"/"kirmizi"
 * freely. Folding both case and Turkish diacritics is what makes a search for
 * "yesil" find "Yeşil". Turn on the case-sensitive switch to compare raw text.
 */
const FOLD: Record<string, string> = {
  İ: "i", I: "i", ı: "i", Ş: "s", ş: "s", Ğ: "g", ğ: "g",
  Ü: "u", ü: "u", Ö: "o", ö: "o", Ç: "c", ç: "c",
};

export function fold(s: string): string {
  let out = "";
  for (const ch of s) out += FOLD[ch] ?? ch;
  return out.toLowerCase();
}

/**
 * Length-preserving fold, for search.
 *
 * `fold` is used on whole values where only equality matters, but the find bar
 * reports column offsets into the original line — so a fold that changed the
 * string's length would put every highlight in the wrong place. Mapping one
 * character at a time and keeping the original whenever lowercasing would
 * resize it guarantees index-for-index alignment.
 */
export function foldForSearch(s: string): string {
  let out = "";
  for (const ch of s) {
    const mapped = FOLD[ch];
    if (mapped) {
      out += mapped;
      continue;
    }
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a find query.
 *
 * Plain searches fold both sides so "yesil" finds "Yeşil", matching how the
 * query bar behaves. Regex searches never fold: folding a pattern would rewrite
 * `\S` into `\s` and silently invert what the user asked for.
 */
export function buildSearchRegex(
  query: string,
  opts: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
): { re: RegExp; foldHaystack: boolean } {
  const foldHaystack = !opts.regex && !opts.caseSensitive;
  let source = opts.regex
    ? query
    : escapeRegex(foldHaystack ? foldForSearch(query) : query);
  // `\\b` here is a literal backslash-b for the regex, not a backspace escape.
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  return {
    re: new RegExp(source, opts.caseSensitive ? "g" : "gi"),
    foldHaystack,
  };
}

export type RecordValues = Map<string, string[]>;

/** Local name of `g:price` is `price`; feeds are inconsistent about prefixes. */
function localName(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

/** Resolves a queried tag against the record, tolerating prefix and case. */
export function valuesFor(values: RecordValues, tag: string): string[] {
  const direct = values.get(tag);
  if (direct) return direct;
  const wanted = fold(localName(tag));
  let hits: string[] | null = null;
  for (const [name, list] of values) {
    if (fold(localName(name)) === wanted) {
      if (hits) hits = hits.concat(list);
      else hits = list;
    }
  }
  return hits ?? [];
}

/**
 * Records one field value, honouring the per-record guards.
 *
 * Shared by every format's query pass: a CSV column, a JSON key and an XML
 * element all end up as one entry here, which is what lets a single condition
 * evaluator serve all three.
 */
export function addField(values: RecordValues, key: string, text: string): void {
  if (!key) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const clipped =
    trimmed.length > MAX_VALUE_CHARS ? trimmed.slice(0, MAX_VALUE_CHARS) : trimmed;
  const list = values.get(key);
  if (list) {
    // A repeated key is normal (many <size> elements, a JSON array); a runaway
    // one is not, so the list is capped rather than the record abandoned.
    if (list.length < 64) list.push(clipped);
  } else if (values.size < MAX_FIELDS_PER_RECORD) {
    values.set(key, [clipped]);
  }
}

export function isUsable(c: Condition): boolean {
  return c.tag.trim().length > 0 && c.value.trim().length > 0;
}

function testOne(values: RecordValues, c: Condition, caseSensitive: boolean): boolean {
  const raw = valuesFor(values, c.tag.trim());
  const norm = (s: string) => (caseSensitive ? s : fold(s));
  const needle = norm(c.value.trim());
  switch (c.op) {
    case "contains":
      return raw.some((v) => norm(v).includes(needle));
    case "not_contains":
      // A record without the tag does not contain the value either.
      return !raw.some((v) => norm(v).includes(needle));
    case "exact":
      return raw.some((v) => norm(v.trim()) === needle);
  }
}

export function compileQuery(query: Query): ((values: RecordValues) => boolean) | null {
  const active = query.conditions.filter(isUsable);
  if (active.length === 0) return null;
  const cs = query.caseSensitive;
  if (query.combinator === "AND") {
    return (values) => active.every((c) => testOne(values, c, cs));
  }
  return (values) => active.some((c) => testOne(values, c, cs));
}

export function describeQuery(query: Query): string {
  const active = query.conditions.filter(isUsable);
  if (active.length === 0) return "no filter";
  const labels: Record<Condition["op"], string> = {
    contains: "⊃",
    not_contains: "⊅",
    exact: "=",
  };
  return active
    .map((c) => `${c.tag} ${labels[c.op]} ${c.value}`)
    .join(query.combinator === "AND" ? " and " : " or ");
}
