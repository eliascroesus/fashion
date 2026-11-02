import { crc32, deflateSync } from 'node:zlib';
import { MEDIA_SIZES, type MediaSize } from '@outfitly/shared';
import decodeHeic from 'heic-decode';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';

// Each photo is processed once; caching decoded images would only hold memory.
sharp.cache(false);

/** A 48 MP iPhone photo is 48.8 M pixels. Anything bigger is refused before decoding. */
const MAX_PIXELS = 50_000_000;
/**
 * HEIC is decoded in WebAssembly at full size, which needs far more memory
 * than JPEG (which shrinks while loading). The app sends JPEG; this covers
 * 12 and 24 MP HEIC from other sources.
 */
const MAX_HEIC_PIXELS = 25_000_000;
/** Longest side ÷ shortest side. Outfit photos are never panoramas or strips. */
const MAX_ASPECT_RATIO = 4;
const LARGEST = Math.max(...MEDIA_SIZES);
const WEBP_QUALITY = 80;

export interface ImageVariant {
  size: MediaSize;
  body: Buffer;
  width: number;
  height: number;
}

export interface ProcessedImage {
  variants: ImageVariant[];
  /** Dimensions of the largest variant; the grid uses them to reserve space. */
  width: number;
  height: number;
  thumbhash: string;
  dominantColor: string;
}

/** A photo we will never be able to use; retrying won't help. */
export class ImageRejectedError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'ImageRejectedError';
  }
}

interface Inspected {
  heic: boolean;
  icc: Buffer | undefined;
}

/** Reads only the header: format, size and colour profile. Refuses anything unsafe or unusable. */
async function inspect(input: Buffer): Promise<Inspected> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch (error) {
    throw new ImageRejectedError('The file is not a photo we can read.', { cause: error });
  }
  const heic = meta.format === 'heif' && meta.compression === 'hevc';
  const allowed =
    meta.format === 'jpeg' ||
    meta.format === 'png' ||
    meta.format === 'webp' ||
    (meta.format === 'heif' && (meta.compression === 'hevc' || meta.compression === 'av1'));
  if (!allowed) throw new ImageRejectedError(`Unsupported image format: ${meta.format}.`);

  const { width, height } = meta;
  if (!width || !height) throw new ImageRejectedError('The photo has no size.');
  if (width * height > (heic ? MAX_HEIC_PIXELS : MAX_PIXELS)) {
    throw new ImageRejectedError('The photo has too many pixels.');
  }
  if (Math.max(width, height) / Math.min(width, height) > MAX_ASPECT_RATIO) {
    throw new ImageRejectedError('The photo is too long and thin.');
  }
  return { heic, icc: meta.icc };
}

/** Adds an ICC colour profile to a PNG (as an iCCP chunk right after IHDR). */
function embedIccProfile(png: Buffer, icc: Buffer): Buffer {
  const type = Buffer.from('iCCP', 'latin1');
  // Profile name, NUL terminator, compression method 0 (deflate), compressed profile.
  const data = Buffer.concat([Buffer.from('icc\0\0', 'latin1'), deflateSync(icc)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const afterIhdr = 8 + 4 + 4 + 13 + 4; // PNG signature + IHDR chunk
  return Buffer.concat([
    png.subarray(0, afterIhdr),
    length,
    type,
    data,
    crc,
    png.subarray(afterIhdr),
  ]);
}

/**
 * Upright sRGB pixels at most 1080 wide, with all metadata gone (sharp drops
 * EXIF, GPS and camera data unless asked to keep them). Every size is cut
 * from this, so the full-size image is never held more than once.
 */
async function decodeUpright(
  input: Buffer,
  { heic, icc }: Inspected,
): Promise<{ data: Buffer; info: OutputInfo }> {
  const shrink = { width: LARGEST, withoutEnlargement: true };
  if (!heic) {
    // rotate() applies the EXIF orientation; JPEGs shrink while loading. sharp
    // converts embedded colour profiles (e.g. iPhone Display P3) to sRGB.
    return sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
      .rotate()
      .resize(shrink)
      .raw()
      .toBuffer({ resolveWithObject: true });
  }
  // sharp's prebuilt binaries can't decode HEVC, so libheif (WASM) does it,
  // rotation included. Its pixels are still in the photo's own colour space
  // (Display P3 on iPhones): re-attach the profile so sharp converts to sRGB.
  const decoded = await decodeHeic({ buffer: input });
  const pixels = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
  let png: Buffer = await sharp(pixels, {
    raw: { width: decoded.width, height: decoded.height, channels: 4 },
    limitInputPixels: MAX_HEIC_PIXELS,
  })
    .removeAlpha()
    .resize(shrink)
    .png({ compressionLevel: 1 })
    .toBuffer();
  if (icc) png = embedIccProfile(png, icc);
  return sharp(png).raw().toBuffer({ resolveWithObject: true });
}

function toHex(channel: number): string {
  return Math.round(channel).toString(16).padStart(2, '0');
}

/** Makes the 1080/600/300 WebP sizes, a thumbhash and the dominant colour. */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const inspected = await inspect(input);
  let base: { data: Buffer; info: OutputInfo };
  try {
    base = await decodeUpright(input, inspected);
  } catch (error) {
    throw new ImageRejectedError('The photo could not be decoded.', { cause: error });
  }
  const { width, height, channels } = base.info;
  const fromBase = () => sharp(base.data, { raw: { width, height, channels } });

  const variants: ImageVariant[] = [];
  for (const size of MEDIA_SIZES) {
    const { data, info } = await fromBase()
      .resize({ width: size, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    variants.push({ size, body: data, width: info.width, height: info.height });
  }

  const thumb = await fromBase()
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const thumbhash = Buffer.from(
    rgbaToThumbHash(thumb.info.width, thumb.info.height, thumb.data),
  ).toString('base64');

  const { dominant } = await fromBase().stats();
  return {
    variants,
    width,
    height,
    thumbhash,
    dominantColor: `#${toHex(dominant.r)}${toHex(dominant.g)}${toHex(dominant.b)}`,
  };
}
