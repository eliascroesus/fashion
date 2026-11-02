declare module 'heic-decode' {
  interface DecodedImage {
    width: number;
    height: number;
    /** RGBA pixels, 4 bytes per pixel. */
    data: Uint8ClampedArray;
  }
  /** Decodes the primary image of a HEIC/HEIF file (rotation already applied). */
  export default function decode(input: {
    buffer: ArrayBufferLike | Uint8Array;
  }): Promise<DecodedImage>;
}
