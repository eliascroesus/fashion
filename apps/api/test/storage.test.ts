import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMMUTABLE_CACHE_CONTROL, OriginalTooLargeError, R2Storage } from '../src/storage.ts';

/** A tiny fake of R2's S3 API that records what the client sends. */
interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}
const requests: Recorded[] = [];
const objects = new Map<string, Buffer>();
let server: Server;
let storage: R2Storage;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.method === 'PUT') {
        objects.set(path, body);
        res.writeHead(200, { etag: '"x"' }).end();
      } else {
        const found = objects.get(path);
        if (!found) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-length': String(found.length) });
        res.end(req.method === 'HEAD' ? undefined : found);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  storage = new R2Storage({
    accountId: 'acc',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    originalsBucket: 'outfitly-originals',
    publicBucket: 'outfitly-public',
    publicBaseUrl: 'https://img.example.com/',
    endpoint: `http://127.0.0.1:${String(port)}`,
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('R2 storage', () => {
  it('makes a 15-minute upload link to the private bucket, locked to type and size', async () => {
    const upload = await storage.presignOriginalUpload('originals/abc', {
      contentType: 'image/heic',
      byteSize: 1234,
    });
    const url = new URL(upload.url);
    expect(url.pathname).toBe('/outfitly-originals/originals/abc');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    );
    expect(upload.headers).toEqual({ 'content-type': 'image/heic' });
    expect(upload.expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
  });

  it('accepts an upload through that link (the app’s PUT)', async () => {
    const body = Buffer.from('fake heic bytes');
    const upload = await storage.presignOriginalUpload('originals/def', {
      contentType: 'image/heic',
      byteSize: body.length,
    });
    const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body });
    expect(res.status).toBe(200);
    expect(await storage.originalSize('originals/def')).toBe(body.length);
    expect(await storage.getOriginal('originals/def', 1000)).toEqual(body);
  });

  it('refuses to download an original bigger than allowed', async () => {
    await expect(storage.getOriginal('originals/def', 5)).rejects.toBeInstanceOf(
      OriginalTooLargeError,
    );
  });

  it('reports a missing original as not uploaded', async () => {
    expect(await storage.originalSize('originals/missing')).toBeNull();
  });

  it('stores public sizes with long, immutable cache headers', async () => {
    await storage.putPublic('m/abc/300.webp', Buffer.from('webp'), 'image/webp');
    const put = requests.findLast((r) => r.method === 'PUT' && r.url.includes('/300.webp'));
    expect(put?.url).toContain('/outfitly-public/m/abc/300.webp');
    expect(put?.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(put?.headers['content-type']).toBe('image/webp');
    expect(IMMUTABLE_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
  });

  it('builds CDN links on the image domain', () => {
    expect(storage.publicUrl('m/abc/300.webp')).toBe('https://img.example.com/m/abc/300.webp');
  });
});
