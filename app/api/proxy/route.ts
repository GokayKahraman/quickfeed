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
        accept: "application/xml, text/xml, application/rss+xml, */*",
        "user-agent": "QuickFeed/0.1 (feed formatter)",
      },
    });
  } catch (err) {
    return bad(`Could not reach the source: ${(err as Error).message}`, 502);
  }

  if (!upstream.ok || !upstream.body) {
    return bad(`The source returned ${upstream.status} ${upstream.statusText}.`, 502);
  }

  // content-encoding is dropped on purpose: fetch already decoded the body.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/xml",
      "cache-control": "no-store",
    },
  });
}
