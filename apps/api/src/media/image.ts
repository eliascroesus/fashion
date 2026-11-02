import { MEDIA_SIZES, type MediaSize } from '@outfitly/shared';
import decodeHeic from 'heic-decode';
import sharp, { type OutputInfo, type Sharp } from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';

/** Refuse decompression bombs: about 4× a 48 MP iPhone photo. */
const MAX_INPUT_PIXELS = 200_000_000;
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

export class UnreadableImageError extends Error {
  constructor(cause: unknown) {
    super('The photo could not be read.', { cause });
    this.name = 'UnreadableImageError';
  }
}

/** HEIC/HEIF files (iPhone photos) start with an ISO-BMFF `ftyp` box naming a HEIF brand. */
function isHeic(input: Buffer): boolean {
  if (input.subarray(4, 8).toString('latin1') !== 'ftyp') return false;
  const brands = input.subarray(8, 32).toString('latin1');
  return /hei[cxms]|hev[cxms]|mif1|msf1/.test(brands) && !brands.includes('avif');
}

/**
 * Opens any upload as an upright sharp pipeline. sharp's prebuilt binaries
 * can't decode HEVC, so HEIC goes through libheif (WASM) first. Metadata is
 * never carried over: sharp drops EXIF, GPS and camera data unless asked.
 */
async function open(input: Buffer): Promise<Sharp> {
  const options = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' as const };
  if (isHeic(input)) {
    const { width, height, data } = await decodeHeic({ buffer: input });
    if (width * height > MAX_INPUT_PIXELS) throw new Error('Image is too large.');
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      ...options,
      raw: { width, height, channels: 4 },
    });
  }
  // rotate() applies the EXIF orientation so portrait photos stay portrait.
  return sharp(input, options).rotate();
}

function toHex(channel: number): string {
  return Math.round(channel).toString(16).padStart(2, '0');
}

/** Makes the 1080/600/300 WebP sizes, a thumbhash and the dominant colour. */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  // Decode once into upright, metadata-free raw pixels that every size is cut from.
  let pixels: { data: Buffer; info: OutputInfo };
  try {
    pixels = await (await open(input)).raw().toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new UnreadableImageError(error);
  }
  const { width, height, channels } = pixels.info;
  const fromPixels = () => sharp(pixels.data, { raw: { width, height, channels } });

  // One size at a time keeps memory flat on small machines.
  const variants: ImageVariant[] = [];
  for (const size of MEDIA_SIZES) {
    const { data, info } = await fromPixels()
      .resize({ width: size, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    variants.push({ size, body: data, width: info.width, height: info.height });
  }

  const thumb = await fromPixels()
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const thumbhash = Buffer.from(
    rgbaToThumbHash(thumb.info.width, thumb.info.height, thumb.data),
  ).toString('base64');

  const { dominant } = await fromPixels().stats();
  const largest = variants[0];
  if (!largest) throw new Error('No sizes configured.');

  return {
    variants,
    width: largest.width,
    height: largest.height,
    thumbhash,
    dominantColor: `#${toHex(dominant.r)}${toHex(dominant.g)}${toHex(dominant.b)}`,
  };
}
