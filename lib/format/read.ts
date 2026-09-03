/**
 * Byte-level plumbing shared by every format.
 *
 * Reading, decompressing, decoding and progress pacing are identical whether
 * the feed turns out to be XML, JSON or a delimited table, so they live here
 * and each format module only has to say what to do with the decoded text.
 */

import type { BackingStore } from "../store/backing";

/** How often a long pass reports progress and yields to the event loop. */
export const PROGRESS_MS = 120;
/** Bytes pulled per read when re-streaming an already-stored document. */
export const READ_CHUNK = 2 * 1024 * 1024;
/** Per-record guards so one malformed giant record cannot exhaust memory. */
export const MAX_FIELDS_PER_RECORD = 512;
export const MAX_VALUE_CHARS = 64 * 1024;

export class Cancelled extends Error {
  constructor() {
    super("Operation cancelled.");
  }
}

export const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

export function countNewlines(s: string): number {
  let n = 0;
  let i = s.indexOf("\n");
  while (i !== -1) {
    n++;
    i = s.indexOf("\n", i + 1);
  }
  return n;
}

/**
 * Picks a decoder from the BOM or an XML declaration.
 *
 * Turkish marketplace feeds are still routinely served as ISO-8859-9 or
 * windows-1254; decoding those as UTF-8 turns every ş and ğ into replacement
 * characters, so a declaration is honoured before anything else happens.
 *
 * The HTTP `charset` is deliberately *not* consulted. Feed hosts get it wrong
 * often enough to do real damage: one of the feeds this was tested against is
 * served as `charset=iso-8859-1` while actually being UTF-8, and obeying that
 * header would turn every ö into Ã¶. A BOM or a declaration is a statement the
 * file makes about itself; a header is a guess the server makes about the file.
 */
export function detectEncoding(head: Uint8Array): { label: string; skip: number } {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { label: "utf-8", skip: 3 };
  }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    return { label: "utf-16le", skip: 2 };
  }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    return { label: "utf-16be", skip: 2 };
  }
  let ascii = "";
  const n = Math.min(head.length, 1024);
  for (let i = 0; i < n; i++) ascii += String.fromCharCode(head[i]);
  const m = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(ascii);
  if (m) {
    const label = m[1].toLowerCase();
    try {
      new TextDecoder(label);
      return { label, skip: 0 };
    } catch {
      /* unknown label, fall back */
    }
  }
  return { label: "utf-8", skip: 0 };
}

/**
 * Looks at the opening bytes of a stream without consuming them.
 *
 * Format detection has to see the start of the document before it can decide
 * which parser to build, so the bytes it read are replayed into a rebuilt
 * stream and the parser still sees the feed from byte zero. `minBytes` is a
 * floor, not a cap — whole chunks are kept, so the head is usually larger.
 */
export async function peekStream(
  stream: ReadableStream<Uint8Array>,
  minBytes: number,
): Promise<{ stream: ReadableStream<Uint8Array>; head: Uint8Array }> {
  const reader = stream.getReader();
  const collected: Uint8Array[] = [];
  let size = 0;
  let ended = false;

  while (size < minBytes) {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    if (value && value.length) {
      collected.push(value);
      size += value.length;
    }
  }

  const head = new Uint8Array(size);
  let at = 0;
  for (const chunk of collected) {
    head.set(chunk, at);
    at += chunk.length;
  }

  let replayed = 0;
  const rebuilt = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (replayed < collected.length) {
        controller.enqueue(collected[replayed++]);
        return;
      }
      if (ended) {
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else if (value) controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return { stream: rebuilt, head };
}

/**
 * Transparently unwraps gzip-compressed feeds (`.xml.gz` is common).
 *
 * The caller is told whether decompression happened, because a compressed
 * source makes the announced byte total meaningless as a progress denominator.
 */
export async function maybeDecompress(
  stream: ReadableStream<Uint8Array>,
): Promise<{ stream: ReadableStream<Uint8Array>; gzipped: boolean }> {
  const { stream: rebuilt, head } = await peekStream(stream, 2);
  const gzipped = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

  if (!gzipped || typeof DecompressionStream === "undefined") {
    return { stream: rebuilt, gzipped: false };
  }
  // DecompressionStream is typed as accepting BufferSource, which does not line
  // up with ReadableStream<Uint8Array> in lib.dom; the runtime contract is fine.
  const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return { stream: rebuilt.pipeThrough(gunzip), gzipped: true };
}

export interface PumpHandlers {
  /** Decoded text, in chunks of whatever size the source hands over. */
  onText: (text: string) => void;
  /** Called roughly every 120 ms with the bytes consumed so far. */
  onTick: (bytesRead: number) => void;
  shouldCancel: () => boolean;
}

/**
 * Drains a byte stream into decoded text, yielding between chunks.
 *
 * The decoder is chosen from the first chunk and then kept in streaming mode,
 * so a multi-byte character split across a chunk boundary still decodes.
 */
export async function pumpStream(
  stream: ReadableStream<Uint8Array>,
  h: PumpHandlers,
): Promise<number> {
  const reader = stream.getReader();
  let decoder: TextDecoder | null = null;
  let bytesRead = 0;
  let lastReport = 0;

  try {
    for (;;) {
      if (h.shouldCancel()) throw new Cancelled();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      let bytes = value;
      if (!decoder) {
        const detected = detectEncoding(bytes);
        decoder = new TextDecoder(detected.label, { fatal: false });
        if (detected.skip) bytes = bytes.subarray(detected.skip);
      }
      bytesRead += value.length;
      h.onText(decoder.decode(bytes, { stream: true }));

      const now = performance.now();
      if (now - lastReport > PROGRESS_MS) {
        lastReport = now;
        h.onTick(bytesRead);
        await yieldToLoop();
      }
    }
    if (decoder) h.onText(decoder.decode());
  } finally {
    reader.releaseLock();
  }

  return bytesRead;
}

/**
 * Same contract as `pumpStream`, but over a document already written to a
 * backing store — the second pass a query makes over the formatted output.
 * Stored text is always UTF-8, so no detection is needed.
 */
export async function pumpStore(store: BackingStore, h: PumpHandlers): Promise<number> {
  const decoder = new TextDecoder("utf-8");
  const total = store.size;
  let bytesRead = 0;
  let lastReport = 0;

  for (let offset = 0; offset < total; offset += READ_CHUNK) {
    if (h.shouldCancel()) throw new Cancelled();
    const bytes = store.read(offset, Math.min(offset + READ_CHUNK, total));
    bytesRead += bytes.length;
    h.onText(decoder.decode(bytes, { stream: true }));

    const now = performance.now();
    if (now - lastReport > PROGRESS_MS) {
      lastReport = now;
      h.onTick(bytesRead);
    }
    await yieldToLoop();
  }
  h.onText(decoder.decode());
  return bytesRead;
}
