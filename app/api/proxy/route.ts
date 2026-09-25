import { lookup } from "node:dns/promises";
import { basicValue, isSettableHeader, unpackSpec, type AuthSpec } from "../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Large feeds take a while to stream through. 60s is the ceiling on Vercel's
 * Hobby plan and a valid value on every plan; without it the function is cut
 * off at the much shorter default, mid-feed.
 */
export const maxDuration = 60;

/**
 * CORS escape hatch for feed URLs.
 *
 * The feed is never parsed, buffered or stored here — the upstream body is
 * piped straight through to the browser, which does all the work. This exists
 * only because most feed hosts do not send `Access-Control-Allow-Origin`.
 *
 * A protected feed is the one case where something private passes through this
 * function. It is read from a request header, never from the query string, so
 * it stays out of access logs, the referrer and browser history; it is
 * forwarded to the feed host and to nowhere else; and it is never logged,
 * cached or written down here.
 */

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
];

function isPrivateAddress(address: string, family: number): boolean {
  if (family === 4) return PRIVATE_V4.some((re) => re.test(address));
  const a = address.toLowerCase();
  return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80");
}

function bad(message: string, status = 400): Response {
  return new Response(message, { status, headers: { "cache-control": "no-store" } });
}

/** A refusal with the status it should reach the browser as. */
class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const MAX_REDIRECTS = 5;

/** Page fragments that only a bot-protection wall serves, never a feed or a login. */
const BOT_WALL_MARKERS = [
  "challenge-platform",
  "cf-chl-",
  "cf-error-details",
  "Attention Required! | Cloudflare",
  "<title>Just a moment...</title>",
];

/** How much of a refusal page is read looking for those markers. */
const BOT_WALL_SNIFF_BYTES = 32 * 1024;

/**
 * Whether the refusal came from a bot-protection wall in front of the feed
 * rather than from the feed host itself.
 *
 * The two look alike from outside — a 403, no challenge line — but mean very
 * different things: one wants a sign-in, the other wants a browser a human is
 * sitting at, and a sign-in will never get past it. A feed host whose visitors
 * open the feed fine can still refuse the proxy this way, because the wall
 * judges the address a request comes from, and this function runs in a data
 * centre.
 *
 * Cloudflare labels its challenges with `cf-mitigated`; its block pages carry
 * no such label, so an HTML refusal is read far enough to recognise one.
 */
async function isBotWall(res: Response): Promise<boolean> {
  if (res.headers.get("cf-mitigated")) return true;
  if (res.status !== 403 && res.status !== 429 && res.status !== 503) return false;
  if (!res.headers.get("content-type")?.includes("html") || !res.body) return false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < BOT_WALL_SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel();
  }
  return BOT_WALL_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Walks the redirect chain by hand, which `redirect: "follow"` cannot be asked
 * to do safely here.
 *
 * Two things have to happen at every hop, not just the first. The private
 * address guard has to run again — otherwise a public host can redirect the
 * proxy at the machine it runs on, and the check at the top is decoration. And
 * the sign-in has to be dropped the moment the origin changes: `fetch` does
 * that for `Authorization` on its own, but an API key in a vendor header or a
 * query parameter is just an ordinary part of the request to it, and would
 * follow the redirect to whoever it points at.
 */
async function followRedirects(target: URL, spec: AuthSpec | null): Promise<Response> {
  const origin = target.origin;
  let url = target;

  for (let hop = 0; ; hop++) {
    let resolved;
    try {
      resolved = await lookup(url.hostname);
    } catch {
      throw new Refused("The address could not be resolved.", 502);
    }
    if (isPrivateAddress(resolved.address, resolved.family)) {
      throw new Refused("Local network addresses cannot be fetched through the proxy.", 403);
    }

    const sameOrigin = url.origin === origin;
    if (spec?.query && !sameOrigin) url.searchParams.delete(spec.query.name);

    const res = await fetch(url, {
      redirect: "manual",
      headers: {
        accept:
          "application/json, text/csv, text/tab-separated-values, application/xml, text/xml, application/rss+xml, text/plain, */*",
        "user-agent": "QuickFeed/0.1 (feed formatter)",
        ...(spec?.header && sameOrigin ? { [spec.header.name]: spec.header.value } : {}),
      },
    });

    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) throw new Refused("The source redirected too many times.", 502);

    try {
      url = new URL(location, url);
    } catch {
      throw new Refused("The source redirected to an address that could not be read.", 502);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Refused("The source redirected to an unsupported address.", 502);
    }
    // A redirect carrying its own credentials is not a sign-in we were given.
    url.username = "";
    url.password = "";
    void res.body?.cancel();
  }
}

export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) return bad("A url parameter is required.");

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return bad("Invalid address.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return bad("Only http and https addresses are supported.");
  }

  /*
   * Two ways in, both ending as something added to the upstream request:
   *
   *   - `x-feed-auth`, what the app sends: a packed spec naming one header
   *     and/or one query parameter to add. A same-origin request header, so no
   *     preflight, and nothing that a log would keep.
   *   - `https://user:pass@host/feed.xml`, what a feed host hands its
   *     customers. `fetch` will not take credentials in the URL, so they are
   *     lifted out here and the address is scrubbed before it is used.
   *
   * The header wins when both are present: it is the deliberate one.
   */
  let spec: AuthSpec | null = unpackSpec(request.headers.get("x-feed-auth") ?? "");
  if (target.username || target.password) {
    if (!spec) {
      spec = {
        header: {
          name: "authorization",
          value: basicValue(
            decodeURIComponent(target.username),
            decodeURIComponent(target.password),
          ),
        },
      };
    }
    target.username = "";
    target.password = "";
  }

  /*
   * The spec arrives from the browser, so the header name is checked rather
   * than trusted: a sign-in may set `Authorization` or a vendor's `X-Api-Key`,
   * but not `Host`, `Cookie` or anything describing the connection this
   * function is about to stream a response over.
   */
  if (spec?.header && !isSettableHeader(spec.header.name)) {
    return bad("That header name cannot be set by a sign-in.");
  }

  /* A key the API wants as a query parameter is added here, not in the browser,
     so it appears in the request to the feed host and in no log of ours. */
  if (spec?.query) target.searchParams.set(spec.query.name, spec.query.value);

  let upstream: Response;
  try {
    upstream = await followRedirects(target, spec);
  } catch (err) {
    if (err instanceof Refused) return bad(err.message, err.status);
    return bad(`Could not reach the source: ${(err as Error).message}`, 502);
  }

  /*
   * Checked before the sign-in path below, which would otherwise take the
   * wall's 403 for a feed asking to be signed in to. The body is consumed by
   * the check, which is fine: nothing past this point is sent on a refusal.
   */
  if (!upstream.ok && (await isBotWall(upstream))) {
    return new Response(
      `The source's bot protection refused the proxy (${upstream.status} ${upstream.statusText}).`,
      {
        status: 502,
        headers: { "cache-control": "no-store", "x-feed-blocked": "bot-protection" },
      },
    );
  }

  /*
   * 401 and 403 are relayed with their own status, not flattened into a 502:
   * they are the difference between "this feed is broken" and "this feed wants
   * a sign-in", and only the browser can ask the user for one. The challenge
   * travels with them so the app can tell Basic from a scheme it cannot serve.
   */
  if (upstream.status === 401 || upstream.status === 403) {
    const challenge = upstream.headers.get("www-authenticate");
    return new Response(`The source returned ${upstream.status} ${upstream.statusText}.`, {
      status: upstream.status,
      headers: {
        "cache-control": "no-store",
        ...(challenge ? { "x-feed-authenticate": challenge } : {}),
      },
    });
  }

  if (!upstream.ok || !upstream.body) {
    return bad(`The source returned ${upstream.status} ${upstream.statusText}.`, 502);
  }

  // content-encoding is dropped on purpose: fetch already decoded the body.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}
