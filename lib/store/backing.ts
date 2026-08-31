/**
 * Byte storage for a formatted document.
 *
 * The preferred backing is an OPFS file opened with a sync access handle: the
 * bytes live on disk, so a 3 GB feed costs a few hundred kilobytes of RAM.
 * Browsers without OPFS fall back to an in-memory chunk list, which is capped
 * and reported to the user rather than allowed to crash the tab.
 */

export interface BackingStore {
  readonly size: number;
  readonly persistent: boolean;
  append(bytes: Uint8Array): void;
  read(start: number, end: number): Uint8Array;
  /** Snapshot for download. Disk-backed stores hand back a File, not a copy. */
  snapshot(name: string): Promise<Blob>;
  dispose(): Promise<void>;
}

export function opfsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage?.getDirectory &&
    typeof FileSystemFileHandle !== "undefined" &&
    "createSyncAccessHandle" in FileSystemFileHandle.prototype
  );
}

const DIR = "quickfeed-tmp";

/**
 * Per-worker prefix for temporary file names.
 *
 * Document ids restart at doc1 on every page load, so a fixed name collides
 * with the file a previous load — or a second open tab — still holds a sync
 * access handle on. Acquiring that handle then fails and the whole document
 * silently drops to the in-memory store. A unique prefix keeps sessions apart.
 */
const SESSION =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.floor(Math.random() * 0xffffffff).toString(16);

class OpfsStore implements BackingStore {
  readonly persistent = true;
  size = 0;
  private access: FileSystemSyncAccessHandle | null;

  constructor(
    private handle: FileSystemFileHandle,
    private dir: FileSystemDirectoryHandle,
    private fileName: string,
    access: FileSystemSyncAccessHandle,
  ) {
    this.access = access;
  }

  private need(): FileSystemSyncAccessHandle {
    if (!this.access) throw new Error("The temporary file is closed.");
    return this.access;
  }

  append(bytes: Uint8Array): void {
    this.need().write(bytes, { at: this.size });
    this.size += bytes.length;
  }

  read(start: number, end: number): Uint8Array {
    const clampedEnd = Math.min(end, this.size);
    if (clampedEnd <= start) return new Uint8Array(0);
    const buf = new Uint8Array(clampedEnd - start);
    const n = this.need().read(buf, { at: start });
    return n === buf.length ? buf : buf.subarray(0, n);
  }

  /**
   * The sync handle holds an exclusive lock, so it is released just long
   * enough to take the File reference, then re-acquired for further reads.
   */
  async snapshot(): Promise<Blob> {
    const access = this.need();
    access.flush();
    access.close();
    this.access = null;
    const file = await this.handle.getFile();
    this.access = await this.handle.createSyncAccessHandle();
    return file;
  }

  async dispose(): Promise<void> {
    try {
      this.access?.flush();
      this.access?.close();
    } catch {
      /* already closed */
    }
    this.access = null;
    try {
      await this.dir.removeEntry(this.fileName);
    } catch {
      /* best effort */
    }
  }
}

class MemoryStore implements BackingStore {
  readonly persistent = false;
  size = 0;
  private chunks: Uint8Array[] = [];
  private starts: number[] = [];

  append(bytes: Uint8Array): void {
    this.starts.push(this.size);
    this.chunks.push(bytes);
    this.size += bytes.length;
  }

  read(start: number, end: number): Uint8Array {
    const clampedEnd = Math.min(end, this.size);
    if (clampedEnd <= start) return new Uint8Array(0);
    const out = new Uint8Array(clampedEnd - start);
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= start) lo = mid;
      else hi = mid - 1;
    }
    let written = 0;
    for (let i = lo; i < this.chunks.length && written < out.length; i++) {
      const chunkStart = this.starts[i];
      const chunk = this.chunks[i];
      const from = Math.max(0, start - chunkStart);
      const to = Math.min(chunk.length, clampedEnd - chunkStart);
      if (to <= from) continue;
      out.set(chunk.subarray(from, to), written);
      written += to - from;
    }
    return out;
  }

  async snapshot(): Promise<Blob> {
    return new Blob(this.chunks as BlobPart[], { type: "application/xml" });
  }

  async dispose(): Promise<void> {
    this.chunks = [];
    this.starts = [];
    this.size = 0;
  }
}

export async function createBackingStore(id: string): Promise<BackingStore> {
  if (opfsSupported()) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIR, { create: true });
      const fileName = `${SESSION}-${id}.xml`;
      const handle = await dir.getFileHandle(fileName, { create: true });
      const access = await handle.createSyncAccessHandle();
      access.truncate(0);
      return new OpfsStore(handle, dir, fileName, access);
    } catch {
      /* fall through to memory */
    }
  }
  return new MemoryStore();
}

/**
 * Clears leftovers from sessions that ended without cleaning up.
 *
 * Files belonging to a live tab are skipped by name, and any that are still
 * locked refuse deletion anyway — so this cannot pull the floor out from under
 * a second window that has the app open.
 */
export async function purgeTempFiles(): Promise<void> {
  if (!opfsSupported()) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIR, { create: false });
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.startsWith(SESSION)) continue;
      try {
        await dir.removeEntry(name);
      } catch {
        /* still held by another tab */
      }
    }
  } catch {
    /* nothing to clean */
  }
}
