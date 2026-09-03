import { lookup } from "node:dns/promises";

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
 * A password-protected feed is the one case where something private passes
 * through this function. It is read from a request header, never from the
 * query string, so it stays out of access logs, the referrer and browser
 * history; it is forwarded to the feed host and to nowhere else; and it is
 * never logged, cached or written down here.
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
   * Two ways in, both ending as one `Authorization` header:
   *
   *   - `x-feed-authorization`, what the app sends. A same-origin request
   *     header, so no preflight, and nothing that a log would keep.
   *   - `https://user:pass@host/feed.xml`, what a feed host hands its
   *     customers. `fetch` will not take credentials in the URL, so they are
   *     lifted out here and the address is scrubbed before it is used.
   *
   * The header wins when both are present: it is the deliberate one.
   */
  let authorization = request.headers.get("x-feed-authorization");
  if (target.username || target.password) {
    if (!authorization) {
      const pair = `${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`;
      authorization = `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
    }
    target.username = "";
    target.password = "";
  }

  // Keep the proxy from being used to reach the machine it runs on.
  try {
    const resolved = await lookup(target.hostname);
    if (isPrivateAddress(resolved.address, resolved.family)) {
      return bad("Local network addresses cannot be fetched through the proxy.", 403);
    }
  } catch {
    return bad("The address could not be resolved.", 502);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      redirect: "follow",
      headers: {
        accept:
          "application/json, text/csv, text/tab-separated-values, application/xml, text/xml, application/rss+xml, text/plain, */*",
        "user-agent": "QuickFeed/0.1 (feed formatter)",
        // `fetch` drops this itself if a redirect crosses to another origin,
        // which is what keeps one host's password from reaching another.
        ...(authorization ? { authorization } : {}),
      },
    });
  } catch (err) {
    return bad(`Could not reach the source: ${(err as Error).message}`, 502);
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
