import type { Condition, Query } from "../types";

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
