import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Public sizes never change once written, so browsers and the CDN may keep them forever. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

/** Photo storage: a private bucket for originals and a public one (behind the CDN) for sizes. */
export interface PhotoStorage {
  presignOriginalUpload(
    key: string,
    upload: { contentType: string; byteSize: number },
  ): Promise<PresignedUpload>;
  /** Size of an uploaded original, or null if nothing has been uploaded. */
  originalSize(key: string): Promise<number | null>;
  getOriginal(key: string): Promise<Buffer>;
  putPublic(key: string, body: Buffer, contentType: string): Promise<void>;
  publicUrl(key: string): string;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  originalsBucket: string;
  publicBucket: string;
  /** CDN origin for the public bucket, e.g. https://img.outfitly.com */
  publicBaseUrl: string;
  /** Override the R2 endpoint (tests only). */
  endpoint?: string;
}

const UPLOAD_LINK_SECONDS = 15 * 60;

/** Cloudflare R2 through its S3-compatible API. */
export class R2Storage implements PhotoStorage {
  readonly #s3: S3Client;
  readonly #config: R2Config;

  constructor(config: R2Config) {
    this.#config = config;
    this.#s3 = new S3Client({
      region: 'auto',
      endpoint: config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // R2 doesn't support every checksum the AWS SDK adds by default (Cloudflare's advice).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async presignOriginalUpload(
    key: string,
    upload: { contentType: string; byteSize: number },
  ): Promise<PresignedUpload> {
    // Type and exact size are part of the signature, so the link can't be used for anything else.
    const command = new PutObjectCommand({
      Bucket: this.#config.originalsBucket,
      Key: key,
      ContentType: upload.contentType,
      ContentLength: upload.byteSize,
    });
    const url = await getSignedUrl(this.#s3, command, {
      expiresIn: UPLOAD_LINK_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      headers: { 'content-type': upload.contentType },
      expiresAt: new Date(Date.now() + UPLOAD_LINK_SECONDS * 1000),
    };
  }

  async originalSize(key: string): Promise<number | null> {
    try {
      const head = await this.#s3.send(
        new HeadObjectCommand({ Bucket: this.#config.originalsBucket, Key: key }),
      );
      return head.ContentLength ?? null;
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  async getOriginal(key: string): Promise<Buffer> {
    const object = await this.#s3.send(
      new GetObjectCommand({ Bucket: this.#config.originalsBucket, Key: key }),
    );
    if (!object.Body) throw new Error(`Original ${key} has no body.`);
    return Buffer.from(await object.Body.transformToByteArray());
  }

  async putPublic(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#config.publicBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: IMMUTABLE_CACHE_CONTROL,
      }),
    );
  }

  publicUrl(key: string): string {
    return new URL(key, `${this.#config.publicBaseUrl.replace(/\/$/, '')}/`).toString();
  }
}
