import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { thumbHashToRGBA } from 'thumbhash';
import { describe, expect, it } from 'vitest';
import { processImage, ImageRejectedError } from '../src/media/image.ts';

const IPHONE_HEIC = readFileSync(new URL('./fixtures/iphone-12mp-gps.heic', import.meta.url));
/** Pure red saved by macOS in Display P3, the colour space every iPhone photo uses. */
const P3_RED_HEIC = readFileSync(new URL('./fixtures/p3-red.heic', import.meta.url));

/** A tiny PNG whose header claims a huge size: a decompression bomb. */
async function pngClaiming(width: number, height: number): Promise<Buffer> {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
    .png()
    .toBuffer();
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29); // IHDR checksum
  return png;
}

async function firstPixel(webp: Buffer | undefined): Promise<number[]> {
  const raw = await sharp(webp).raw().toBuffer();
  return [raw[0] ?? -1, raw[1] ?? -1, raw[2] ?? -1];
}

/** True if an EXIF block contains a GPS section (tag 0x8825), in either byte order. */
function hasGps(exif: Buffer | undefined): boolean {
  if (!exif) return false;
  return exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]));
}

describe('processImage', () => {
  it('turns a 12-megapixel iPhone HEIC with GPS into 3 WebP sizes in under 10 seconds, GPS removed', async () => {
    const input = await sharp(IPHONE_HEIC).metadata();
    expect(input).toMatchObject({ width: 4032, height: 3024, compression: 'hevc' });
    expect(hasGps(input.exif)).toBe(true);

    const started = performance.now();
    const result = await processImage(IPHONE_HEIC);
    const seconds = (performance.now() - started) / 1000;
    console.log(`12 MP HEIC → 3 sizes in ${seconds.toFixed(2)} s`);
    expect(seconds).toBeLessThan(10);

    expect(result.variants.map((v) => [v.size, v.width, v.height])).toEqual([
      [1080, 1080, 810],
      [600, 600, 450],
      [300, 300, 225],
    ]);
    for (const variant of result.variants) {
      const out = await sharp(variant.body).metadata();
      expect(out.format).toBe('webp');
      expect(out.exif).toBeUndefined();
      expect(out.xmp).toBeUndefined();
      expect(out.icc).toBeUndefined();
    }
    expect({ width: result.width, height: result.height }).toEqual({ width: 1080, height: 810 });
  });

  it('makes a thumbhash placeholder and a dominant colour', async () => {
    const result = await processImage(IPHONE_HEIC);
    const decoded = thumbHashToRGBA(Buffer.from(result.thumbhash, 'base64'));
    expect(decoded.w / decoded.h).toBeCloseTo(4 / 3, 0);
    expect(result.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps portrait photos upright (EXIF orientation) and strips their metadata', async () => {
    // Stored sideways (landscape pixels) with "rotate 90°" in EXIF, like many phone JPEGs.
    const sideways = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: '#336699' },
    })
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '59/1 0/1 0/1' } })
      .jpeg()
      .toBuffer();
    const before = await sharp(sideways).metadata();
    expect({ orientation: before.orientation, gps: hasGps(before.exif) }).toEqual({
      orientation: 6,
      gps: true,
    });
    const result = await processImage(sideways);
    expect(result.variants[0]).toMatchObject({ width: 1080, height: 1440 });
    expect((await sharp(result.variants[0]?.body).metadata()).exif).toBeUndefined();
  });

  it('never enlarges small photos', async () => {
    const small = await sharp({
      create: { width: 400, height: 500, channels: 4, background: '#ff000080' },
    })
      .png()
      .toBuffer();
    const result = await processImage(small);
    expect(result.variants.map((v) => v.width)).toEqual([400, 400, 300]);
  });

  it('converts iPhone Display P3 colours to sRGB instead of dulling them', async () => {
    const result = await processImage(P3_RED_HEIC);
    const [r = 0, g = 0, b = 0] = await firstPixel(result.variants[0]?.body);
    // Unconverted P3 red reads as (233, 52, 35): dull and orange.
    expect(r).toBeGreaterThan(245);
    expect(g).toBeLessThan(20);
    expect(b).toBeLessThan(20);
  });

  it('refuses decompression bombs from the header, before decoding', async () => {
    const started = performance.now();
    await expect(processImage(await pngClaiming(8_000, 7_000))).rejects.toThrow(/too many pixels/);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('refuses very long and thin images', async () => {
    const strip = await sharp({
      create: { width: 2000, height: 400, channels: 3, background: '#888' },
    })
      .jpeg()
      .toBuffer();
    await expect(processImage(strip)).rejects.toThrow(/long and thin/);
  });

  it.each(['gif', 'tiff'] as const)('refuses %s files even if they decode', async (format) => {
    const image = await sharp({
      create: { width: 50, height: 50, channels: 3, background: '#888' },
    })
      .toFormat(format)
      .toBuffer();
    await expect(processImage(image)).rejects.toBeInstanceOf(ImageRejectedError);
  });

  it('refuses SVG (it is code, not a photo)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(processImage(svg)).rejects.toBeInstanceOf(ImageRejectedError);
  });

  it('rejects files that are not photos', async () => {
    await expect(processImage(Buffer.from('definitely not an image'))).rejects.toBeInstanceOf(
      ImageRejectedError,
    );
  });
});
