/**
 * Content-addressed blob storage for observation screenshots.
 *
 * A computer-use trajectory produces one screenshot per turn and can run to
 * hundreds of turns. Three consequences shape this design:
 *
 * ADDRESS BY CONTENT, NOT BY NAME. The key IS the SHA-256 of the bytes, so an
 * unchanged screen across ten turns is stored once, and two references to the
 * same address are provably the same image. There is no rename, no overwrite
 * and no versioning, because none of those are meaningful when the name is the
 * content.
 *
 * IMMUTABLE BY CONSTRUCTION. `put` of an address that exists is a no-op that
 * returns the existing address. That is not an optimisation — it is what makes
 * the store safe to point an append-only audit trail at: no sequence of writes
 * can change what a stored address resolves to.
 *
 * VERIFY ON READ. `get` re-hashes the bytes and refuses to return them if they
 * do not match the address asked for. A screenshot is evidence; silently
 * serving corrupted or substituted bytes under an address an auditor is
 * checking would defeat the point of addressing it by hash at all.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** `sha256:<64 lowercase hex>`. */
export type ContentAddress = string;

const ADDRESS_RE = /^sha256:[0-9a-f]{64}$/;

export type ImageFormat = 'webp' | 'avif' | 'png';

export interface BlobMetadata {
  address: ContentAddress;
  bytes: number;
  format: ImageFormat;
}

export class BlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobError';
  }
}

export function computeAddress(bytes: Buffer): ContentAddress {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function isContentAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}

/**
 * Detect the format from magic bytes rather than trusting a caller's label.
 *
 * A mislabelled blob is served with the wrong Content-Type, and a browser that
 * sniffs a mismatched type is exactly the shape of bug that turns an image
 * viewer into an XSS sink. Returning null for anything unrecognized means the
 * store refuses it rather than guessing.
 */
export function detectFormat(bytes: Buffer): ImageFormat | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  // AVIF: ISO-BMFF box, "ftyp" at offset 4, brand "avif"/"avis" at 8.
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

export const CONTENT_TYPES: Record<ImageFormat, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  png: 'image/png',
};

export interface BlobStore {
  /** Store bytes, returning their address. Idempotent. */
  put(bytes: Buffer): Promise<BlobMetadata>;
  /** Retrieve by address, verifying the content hash. */
  get(address: ContentAddress): Promise<{ bytes: Buffer; format: ImageFormat } | null>;
  has(address: ContentAddress): Promise<boolean>;
}

/**
 * Filesystem-backed store.
 *
 * Fans out over the first two hex characters (`ab/abcdef…`) because a single
 * directory holding a million entries is slow to traverse on most filesystems
 * and unpleasant to inspect by hand.
 */
export class FileBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private pathFor(address: ContentAddress): string {
    const hex = address.slice('sha256:'.length);
    // The address is validated before this is called, so the slice is safe and
    // cannot contain a path separator or traversal sequence.
    return resolve(join(this.root, hex.slice(0, 2), hex));
  }

  async put(bytes: Buffer): Promise<BlobMetadata> {
    const format = detectFormat(bytes);
    if (!format) {
      throw new BlobError(
        'Unrecognized image format. Screenshots must be WebP, AVIF or PNG; ' +
          'the format is detected from the file header, not from a caller-supplied label.',
      );
    }

    const address = computeAddress(bytes);
    const target = this.pathFor(address);

    // Already present: identical content by definition, so nothing to do.
    if (await this.has(address)) return { address, bytes: bytes.length, format };

    await mkdir(dirname(target), { recursive: true });
    // Write to a temp name then rename. A rename within a directory is atomic
    // on POSIX and on NTFS, so a reader never observes a partially written
    // blob under an address that is supposed to be complete.
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, bytes, { flag: 'wx' });
      await rename(tmp, target);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      // A concurrent writer winning the race is success, not failure: the
      // content is identical, which is the whole point of addressing by hash.
      if (await this.has(address)) return { address, bytes: bytes.length, format };
      throw new BlobError(`Could not store blob ${address}: ${(e as Error).message}`);
    }

    return { address, bytes: bytes.length, format };
  }

  async get(address: ContentAddress): Promise<{ bytes: Buffer; format: ImageFormat } | null> {
    if (!isContentAddress(address)) {
      // Rejected before it can reach the filesystem: an unvalidated address is
      // a path traversal waiting to happen.
      throw new BlobError(`Not a content address: ${address}`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(this.pathFor(address));
    } catch {
      return null;
    }

    // Re-verify. Serving substituted bytes under an address an auditor is
    // checking would defeat content addressing entirely.
    const actual = computeAddress(bytes);
    if (actual !== address) {
      throw new BlobError(
        `Blob integrity failure: ${address} contains bytes hashing to ${actual}. ` +
          'The store has been corrupted or tampered with.',
      );
    }

    const format = detectFormat(bytes);
    if (!format) throw new BlobError(`Stored blob ${address} is not a recognized image.`);
    return { bytes, format };
  }

  async has(address: ContentAddress): Promise<boolean> {
    if (!isContentAddress(address)) return false;
    try {
      const s = await stat(this.pathFor(address));
      return s.isFile();
    } catch {
      return false;
    }
  }
}

/** In-memory store for tests and single-process development. */
export class InMemoryBlobStore implements BlobStore {
  private blobs = new Map<ContentAddress, Buffer>();

  async put(bytes: Buffer): Promise<BlobMetadata> {
    const format = detectFormat(bytes);
    if (!format) {
      throw new BlobError(
        'Unrecognized image format. Screenshots must be WebP, AVIF or PNG.',
      );
    }
    const address = computeAddress(bytes);
    // Deliberately does NOT overwrite: same address means same bytes.
    if (!this.blobs.has(address)) this.blobs.set(address, Buffer.from(bytes));
    return { address, bytes: bytes.length, format };
  }

  async get(address: ContentAddress): Promise<{ bytes: Buffer; format: ImageFormat } | null> {
    if (!isContentAddress(address)) throw new BlobError(`Not a content address: ${address}`);
    const bytes = this.blobs.get(address);
    if (!bytes) return null;
    const actual = computeAddress(bytes);
    if (actual !== address) {
      throw new BlobError(`Blob integrity failure: ${address} hashes to ${actual}.`);
    }
    const format = detectFormat(bytes);
    if (!format) throw new BlobError(`Stored blob ${address} is not a recognized image.`);
    return { bytes, format };
  }

  async has(address: ContentAddress): Promise<boolean> {
    return isContentAddress(address) && this.blobs.has(address);
  }

  get size(): number {
    return this.blobs.size;
  }
}
