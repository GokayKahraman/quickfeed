import type { BackingStore } from "./backing";

/** Lines per index checkpoint. 64 keeps the index ~1 MB for a 5 M line file. */
export const BLOCK = 64;

/** String buffered before encoding. Bigger writes, fewer syscalls. */
const FLUSH_AT = 256 * 1024;

export interface LineIndex {
  /** Byte offset of the first line of each 64-line block. */
  checkpoints: Float64Array;
  lineCount: number;
  byteLength: number;
}

/**
 * Adaptive density histogram.
 *
 * Records are counted into 512 buckets before the document's total length is
 * known, so the covered span starts small and doubles — folding bucket pairs
 * each time — until it contains the whole document.
 */
export class DensityHistogram {
  static readonly BUCKETS = 512;
  private buckets = new Uint32Array(DensityHistogram.BUCKETS);
  private span = 65536;

  add(line: number): void {
    while (line >= this.span) this.grow();
    this.buckets[Math.floor(line / (this.span / DensityHistogram.BUCKETS))]++;
  }

  private grow(): void {
    const b = this.buckets;
    const half = DensityHistogram.BUCKETS / 2;
    for (let i = 0; i < half; i++) b[i] = b[i * 2] + b[i * 2 + 1];
    b.fill(0, half);
    this.span *= 2;
  }

  /** Resamples onto exactly [0, lineCount) so the tape maps 1:1 to the file. */
  finalize(lineCount: number): number[] {
    const n = DensityHistogram.BUCKETS;
    const out = new Array<number>(n).fill(0);
    if (lineCount <= 0) return out;
    const bucketSpan = this.span / n;
    for (let i = 0; i < n; i++) {
      const v = this.buckets[i];
      if (!v) continue;
      const center = (i + 0.5) * bucketSpan;
      const idx = Math.min(n - 1, Math.floor((center / lineCount) * n));
      out[idx] += v;
    }
    return out;
  }
}

/**
 * Writes formatted text into a backing store while building the line index.
 *
 * Newlines are counted twice on purpose: once over the encoded bytes (which is
 * what the checkpoints need) and once over the incoming strings (so `line()`
 * is exact while output is still buffered, which is how record boundaries get
 * their line numbers).
 */
export class DocWriter {
  private enc = new TextEncoder();
  private pending = "";
  private pendingNewlines = 0;
  private flushedNewlines = 0;
  private checkpoints: Float64Array;
  private checkpointCount = 1;
  private lastByte = -1;

  constructor(private store: BackingStore) {
    this.checkpoints = new Float64Array(4096);
    this.checkpoints[0] = 0;
  }

  get byteLength(): number {
    return this.store.size;
  }

  /** Zero-based index of the line currently being written. */
  line(): number {
    return this.flushedNewlines + this.pendingNewlines;
  }

  write(s: string): void {
    if (!s) return;
    this.pending += s;
    if (s.length === 1) {
      if (s === "\n") this.pendingNewlines++;
    } else {
      let i = s.indexOf("\n");
      while (i !== -1) {
        this.pendingNewlines++;
        i = s.indexOf("\n", i + 1);
      }
    }
    if (this.pending.length >= FLUSH_AT) this.flush();
  }

  flush(): void {
    if (!this.pending) return;
    const bytes = this.enc.encode(this.pending);
    this.pending = "";
    this.pendingNewlines = 0;
    const base = this.store.size;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 10) {
        this.flushedNewlines++;
        if (this.flushedNewlines % BLOCK === 0) {
          this.pushCheckpoint(base + i + 1);
        }
      }
    }
    if (bytes.length > 0) this.lastByte = bytes[bytes.length - 1];
    this.store.append(bytes);
  }

  private pushCheckpoint(offset: number): void {
    if (this.checkpointCount === this.checkpoints.length) {
      const bigger = new Float64Array(this.checkpoints.length * 2);
      bigger.set(this.checkpoints);
      this.checkpoints = bigger;
    }
    this.checkpoints[this.checkpointCount++] = offset;
  }

  close(): LineIndex {
    this.flush();
    const byteLength = this.store.size;
    const lineCount =
      byteLength === 0 ? 0 : this.flushedNewlines + (this.lastByte === 10 ? 0 : 1);
    return {
      checkpoints: this.checkpoints.slice(0, this.checkpointCount),
      lineCount,
      byteLength,
    };
  }
}

/** Random access by line number, backed by the checkpoint index. */
export class DocReader {
  private dec = new TextDecoder();

  constructor(
    private store: BackingStore,
    private index: LineIndex,
  ) {}

  lines(from: number, count: number): string[] {
    const { checkpoints, lineCount, byteLength } = this.index;
    const start = Math.max(0, Math.min(from, lineCount));
    const end = Math.min(lineCount, start + count);
    if (end <= start) return [];

    const firstBlock = Math.floor(start / BLOCK);
    const lastBlock = Math.floor((end - 1) / BLOCK);
    const startOffset = checkpoints[firstBlock];
    const endOffset =
      lastBlock + 1 < checkpoints.length ? checkpoints[lastBlock + 1] : byteLength;

    // Both offsets sit on line boundaries, so no multi-byte char is split.
    const text = this.dec.decode(this.store.read(startOffset, endOffset));
    const all = text.split("\n");
    const offsetInBlock = start - firstBlock * BLOCK;
    return all.slice(offsetInBlock, offsetInBlock + (end - start));
  }

  /** Byte offset where a line begins — used to seek during a query pass. */
  offsetOfLine(line: number): number {
    const block = Math.floor(line / BLOCK);
    return this.index.checkpoints[Math.min(block, this.index.checkpoints.length - 1)];
  }
}
