/**
 * How a feed is signed in to, and how that becomes an HTTP request.
 *
 * Four schemes are carried, and they are the four that are only ever request
 * decoration: a header or a query parameter, decided before the request goes
 * out. Digest, NTLM, OAuth and the signing schemes need a handshake or a
 * canonical signature over the request, which is a different kind of machine
 * from this one; they are named back to the user rather than half-supported.
 */

import type { FeedAuth } from "./types";

/**
 * A header value HTTP can actually carry.
 *
 * Header field values are Latin-1 at best and ASCII in practice; `fetch`
 * throws on anything else. Tokens and API keys are ASCII in every scheme that
 * issues them, so this only ever catches a paste that picked up a stray
 * character — but it catches it with a sentence the user can act on instead of
 * an "Invalid value" from deep inside the fetch.
 */
export function isSendableValue(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\x20-\x7e]/.test(value);
}

/** Everything the fetch has to add, once the scheme is resolved. */
export interface AuthSpec {
  header?: { name: string; value: string };
  query?: { name: string; value: string };
}

/** UTF-8 safe `Basic` value; `btoa` alone throws past Latin-1. */
export function basicValue(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/** What this sign-in adds to the request, or null when it adds nothing. */
export function specFor(auth: FeedAuth | undefined): AuthSpec | null {
  if (!auth) return null;
  switch (auth.type) {
    case "none":
      return null;
    case "basic":
      if (!auth.username && !auth.password) return null;
      return { header: { name: "authorization", value: basicValue(auth.username, auth.password) } };
    case "bearer":
      if (!auth.token.trim()) return null;
      return { header: { name: "authorization", value: `Bearer ${auth.token.trim()}` } };
    case "apikey": {
      if (!auth.key.trim()) return null;
      const pair = { name: auth.key.trim(), value: auth.value };
      return auth.in === "query" ? { query: pair } : { header: pair };
    }
  }
}

/**
 * The part of a spec HTTP cannot carry, named for the user.
 *
 * Basic is exempt: its username and password are UTF-8 encoded into base64
 * before they are ever a header value, so an accented password is fine there
 * and only there.
 */
export function unsendableField(auth: FeedAuth | undefined): string | null {
  if (auth?.type === "bearer" && !isSendableValue(auth.token.trim())) return "bearer token";
  if (auth?.type === "apikey") {
    if (!isSendableValue(auth.key.trim())) return "API key name";
    if (auth.in === "header" && !isSendableValue(auth.value)) return "API key value";
  }
  return null;
}

/**
 * The spec, packed for the one hop to our own proxy.
 *
 * Base64 of JSON, because a header value cannot hold newlines or non-Latin-1
 * bytes and an API key can hold both. It is transport packing, not secrecy —
 * the point of putting it in a header at all is that headers are not written
 * into access logs the way a query string is.
 */
export function packSpec(spec: AuthSpec): string {
  const bytes = new TextEncoder().encode(JSON.stringify(spec));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function unpackSpec(packed: string): AuthSpec | null {
  try {
    const json = Buffer.from(packed, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const { header, query } = parsed as AuthSpec;
    const ok = (p: unknown) =>
      !p ||
      (typeof p === "object" &&
        typeof (p as { name?: unknown }).name === "string" &&
        typeof (p as { value?: unknown }).value === "string");
    if (!ok(header) || !ok(query)) return null;
    return { header, query };
  } catch {
    return null;
  }
}

/**
 * Header names the proxy will not let a sign-in set.
 *
 * `authorization` is the whole point and stays allowed. The rest either
 * describe the connection — changing them corrupts the response the proxy is
 * streaming — or would send the browser's own session somewhere it was never
 * meant to go.
 */
const RESERVED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "cookie",
]);

/** Is this a header name a sign-in may legitimately set? */
export function isSettableHeader(name: string): boolean {
  // RFC 9110 token characters; anything else cannot be a header name at all.
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return false;
  return !RESERVED_HEADERS.has(name.toLowerCase());
}

/** Schemes a `WWW-Authenticate` line can name, mapped to what the app can do. */
export function authTypeForScheme(scheme: string | null): FeedAuth["type"] | null {
  switch (scheme?.toLowerCase()) {
    case "basic":
      return "basic";
    case "bearer":
      return "bearer";
    default:
      return null;
  }
}
