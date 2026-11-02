import { OriginalTooLargeError, type PhotoStorage, type PresignedUpload } from '../src/storage.ts';

/** In-memory stand-in for R2, so the upload flow can be tested without Cloudflare. */
export class MemoryStorage implements PhotoStorage {
  readonly originals = new Map<string, Buffer>();
  readonly publicObjects = new Map<string, { body: Buffer; contentType: string }>();

  presignOriginalUpload(
    key: string,
    upload: { contentType: string; byteSize: number },
  ): Promise<PresignedUpload> {
    return Promise.resolve({
      url: `https://uploads.test/${key}?signed=1`,
      headers: { 'content-type': upload.contentType },
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
  }

  /** What the app's PUT to the upload link would do. */
  simulateUpload(key: string, body: Buffer): void {
    this.originals.set(key, body);
  }

  originalSize(key: string): Promise<number | null> {
    return Promise.resolve(this.originals.get(key)?.length ?? null);
  }

  /** Set to make downloads fail, like a storage outage. */
  failDownloads = false;
  /** Set to make downloads wait until it resolves, like a slow network. */
  downloadGate: Promise<void> | null = null;

  async getOriginal(key: string, maxBytes: number): Promise<Buffer> {
    if (this.downloadGate) await this.downloadGate;
    const body = this.originals.get(key);
    if (this.failDownloads) return Promise.reject(new Error('storage unavailable'));
    if (!body) return Promise.reject(new Error(`No original ${key}`));
    if (body.length > maxBytes) return Promise.reject(new OriginalTooLargeError());
    return Promise.resolve(body);
  }

  putOriginal(key: string, body: Buffer): Promise<void> {
    this.originals.set(key, body);
    return Promise.resolve();
  }

  putPublic(key: string, body: Buffer, contentType: string): Promise<void> {
    this.publicObjects.set(key, { body, contentType });
    return Promise.resolve();
  }

  publicUrl(key: string): string {
    return `https://img.test/${key}`;
  }
}
