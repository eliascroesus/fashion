// Sends one photo through the real pipeline on Cloudflare R2 and prints the 3 public links.
//   pnpm media:try path/to/photo.heic      (from the repo root; needs the R2_* settings in .env)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { makePublicSizes, originalKey } from '../src/media/pipeline.ts';
import { R2Storage } from '../src/storage.ts';

const file = process.argv[2];
if (!file) {
  console.error('Usage: pnpm media:try path/to/photo.heic');
  process.exit(1);
}
const env = z
  .object({
    R2_ACCOUNT_ID: z.string().min(1),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_ORIGINALS_BUCKET: z.string().min(1),
    R2_PUBLIC_BUCKET: z.string().min(1),
    MEDIA_PUBLIC_BASE_URL: z.url(),
    // Only to try the script against a local S3 stand-in.
    R2_ENDPOINT: z.url().optional(),
  })
  .parse(process.env);
const storage = new R2Storage({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  originalsBucket: env.R2_ORIGINALS_BUCKET,
  publicBucket: env.R2_PUBLIC_BUCKET,
  publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
  ...(env.R2_ENDPOINT ? { endpoint: env.R2_ENDPOINT } : {}),
});

const body = readFileSync(resolve(process.env['INIT_CWD'] ?? process.cwd(), file));
const mediaId = crypto.randomUUID();
const contentType = file.toLowerCase().endsWith('.heic') ? 'image/heic' : 'image/jpeg';

// 1–2. Get an upload link and upload the original, exactly like the app does.
const upload = await storage.presignOriginalUpload(originalKey(mediaId), {
  contentType,
  byteSize: body.length,
});
const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body });
if (!put.ok) throw new Error(`Upload failed: HTTP ${String(put.status)} ${await put.text()}`);

// 4–5. What the background job does.
const started = performance.now();
const { image, keys } = await makePublicSizes(storage, mediaId);
const seconds = ((performance.now() - started) / 1000).toFixed(2);

const gpsLeft = await Promise.all(
  image.variants.map(async (v) => (await sharp(v.body).metadata()).exif !== undefined),
);
console.log(
  `Processed in ${seconds} s — ${String(image.width)}×${String(image.height)}, colour ${image.dominantColor}`,
);
console.log(`Location/camera data in output: ${gpsLeft.some(Boolean) ? 'YES (problem!)' : 'none'}`);
for (const size of [1080, 600, 300] as const) console.log(storage.publicUrl(keys[size]));
