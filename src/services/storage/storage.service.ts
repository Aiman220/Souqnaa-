import path from 'path';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from '../../config';
import { ImageProcessorService, ImageVariantName } from './image-processor.service';

export interface ImageVariantUrls {
  thumbnail: string;
  small: string;
  medium: string;
  large: string;
  original: string;
}

export interface UploadResult {
  url: string;
  key: string;
  size: number;
  mimeType: string;
  width?: number;
  height?: number;
  hash?: string;
  variants?: ImageVariantUrls;
}

export interface IStorageService {
  uploadFile(file: Express.Multer.File, folder?: string): Promise<UploadResult>;
  deleteFile(key: string): Promise<void>;
  getFileStream(key: string): Promise<{
    stream: NodeJS.ReadableStream;
    contentType?: string;
    contentLength?: number;
    contentDisposition?: string;
    eTag?: string;
    lastModified?: Date;
  }>;
  getFileBuffer(key: string): Promise<{
    buffer: Buffer;
    contentType?: string;
    contentLength?: number;
    eTag?: string;
    lastModified?: Date;
  }>;
  putObject(key: string, body: Buffer, contentType: string, cacheControl?: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  getPublicUrl(key: string): string;
  getVariantUrl(key: string, variant: ImageVariantName): string;
  normalizeUrl(rawUrl: string | null | undefined): string;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

class CloudflareR2StorageService implements IStorageService {
  private s3: S3Client;
  private bucket: string;

  /**
   * In-memory cache of verified existing keys and variants.
   * Eliminates unnecessary R2 HEAD / LIST requests during normal requests (§11).
   */
  private knownExistingKeys = new Set<string>();

  constructor() {
    this.bucket = config.storage.s3.bucket || 'sogana';

    this.s3 = new S3Client({
      region: config.storage.s3.region || 'auto',
      endpoint: config.storage.s3.endpoint,
      credentials: {
        accessKeyId: config.storage.s3.accessKeyId,
        secretAccessKey: config.storage.s3.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  private resolveBaseUrl(): string {
    const rawPublicUrl = config.storage.s3.publicUrl || '';
    if (rawPublicUrl && !rawPublicUrl.includes('r2.cloudflarestorage.com')) {
      return rawPublicUrl.replace(/\/+$/, '');
    }

    const serverBase =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.BACKEND_PUBLIC_URL ||
      process.env.API_BASE_URL ||
      (config.domains?.backendPublicUrl && !config.domains.backendPublicUrl.includes('souqnaa.com') ? config.domains.backendPublicUrl : '') ||
      `http://localhost:${config.port || 3000}`;

    return `${serverBase.replace(/\/+$/, '')}${config.apiPrefix}/storage/file`;
  }

  getPublicUrl(key: string): string {
    const cleanKey = key.replace(/^\/+/, '');
    return `${this.resolveBaseUrl()}/${cleanKey}`;
  }

  getVariantUrl(key: string, variant: ImageVariantName): string {
    const cleanKey = key.replace(/^\/+/, '');
    if (variant === 'original') return this.getPublicUrl(cleanKey);
    const variantKey = ImageProcessorService.getVariantKey(cleanKey, variant, 'webp');
    return this.getPublicUrl(variantKey);
  }

  normalizeUrl(rawUrl: string | null | undefined): string {
    if (!rawUrl) return '';
    const trimmed = rawUrl.trim();

    // 1. If rawUrl is a private R2 endpoint, convert to public streaming URL
    if (trimmed.includes('r2.cloudflarestorage.com')) {
      const match = trimmed.match(/r2\.cloudflarestorage\.com\/[^/]+\/(.+)$/);
      if (match && match[1]) {
        return this.getPublicUrl(match[1]);
      }
    }

    // 2. If rawUrl contains localhost, 127.0.0.1, or 10.0.2.2 on deployed server (e.g. Render)
    if (
      (trimmed.includes('localhost') || trimmed.includes('127.0.0.1') || trimmed.includes('10.0.2.2')) &&
      (process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_PUBLIC_URL || process.env.NODE_ENV === 'production')
    ) {
      const filePart = trimmed.match(/\/(api\/v1\/)?storage\/file\/(.+)$/);
      if (filePart && filePart[2]) {
        return this.getPublicUrl(filePart[2]);
      }
    }

    // 3. If it's a relative path starting with /api/v1/storage/file or /storage/file
    if (trimmed.startsWith('/api/v1/storage/file/')) {
      const cleanKey = trimmed.replace('/api/v1/storage/file/', '');
      return this.getPublicUrl(cleanKey);
    }
    if (trimmed.startsWith('/storage/file/')) {
      const cleanKey = trimmed.replace('/storage/file/', '');
      return this.getPublicUrl(cleanKey);
    }

    // 4. If it's an external absolute URL (HTTP/HTTPS), return intact
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }

    // 5. If it's a relative key like "products/..." or "categories/...", resolve to public storage URL
    if (!trimmed.startsWith('/') && trimmed.includes('/')) {
      return this.getPublicUrl(trimmed);
    }

    return trimmed;
  }

  async objectExists(key: string): Promise<boolean> {
    const cleanKey = key.replace(/^\/+/, '');
    if (this.knownExistingKeys.has(cleanKey)) {
      return true;
    }

    try {
      await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: cleanKey,
        })
      );
      this.knownExistingKeys.add(cleanKey);
      return true;
    } catch {
      return false;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl = 'public, max-age=31536000, immutable'
  ): Promise<void> {
    const cleanKey = key.replace(/^\/+/, '');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: cleanKey,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      })
    );
    this.knownExistingKeys.add(cleanKey);
  }

  async uploadFile(file: Express.Multer.File, folder = 'general'): Promise<UploadResult> {
    // 1. Magic bytes validation (do not trust client-supplied MIME or extension)
    const detected = ImageProcessorService.detectMimeFromBuffer(file.buffer);
    const ext = detected.ext;
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const key = `${folder}/${fileName}`;

    let width: number | undefined;
    let height: number | undefined;
    let sha256: string | undefined;
    let uploadBuffer = file.buffer;

    // 2. If image: Inspect, auto-orient, strip EXIF metadata, and enforce size bounds
    if (detected.isImage) {
      const metadata = await ImageProcessorService.inspectImage(file.buffer);
      width = metadata.width;
      height = metadata.height;
      sha256 = metadata.sha256;

      // Auto-orient and strip EXIF for privacy on the preserved original
      try {
        const sharp = (await import('sharp')).default;
        uploadBuffer = await sharp(file.buffer).rotate().toBuffer();
      } catch (e) {
        console.warn('[Storage] Preserved original upload without re-encode:', e);
      }
    }

    // 3. Upload primary / original object to Cloudflare R2
    await this.putObject(
      key,
      uploadBuffer,
      detected.mime,
      folder.startsWith('refunds') || folder.startsWith('disputes') || folder.startsWith('support')
        ? 'private, no-store'
        : 'public, max-age=31536000, immutable'
    );

    console.log(
      `[Storage] Uploaded ${key} to Cloudflare R2 (${uploadBuffer.length} bytes, MIME: ${detected.mime})`
    );

    // 4. Construct variant URLs
    const variants: ImageVariantUrls = {
      thumbnail: this.getVariantUrl(key, 'thumbnail'),
      small: this.getVariantUrl(key, 'small'),
      medium: this.getVariantUrl(key, 'medium'),
      large: this.getVariantUrl(key, 'large'),
      original: this.getPublicUrl(key),
    };

    // 5. Asynchronous background variant generation (§2: "Use background processing so customers do not wait")
    if (detected.isImage) {
      setImmediate(async () => {
        try {
          const generated = await ImageProcessorService.generateAllVariants(uploadBuffer, key);
          for (const variant of generated) {
            await this.putObject(variant.key, variant.buffer, variant.mimeType);
            this.knownExistingKeys.add(variant.key);
          }
          console.log(`[Storage] Generated & uploaded ${generated.length} variants for ${key}`);
        } catch (err) {
          console.error(`[Storage] Background variant generation failed for ${key}:`, err);
        }
      });
    }

    const url = this.getPublicUrl(key);

    return {
      url,
      key,
      size: uploadBuffer.length,
      mimeType: detected.mime,
      width,
      height,
      hash: sha256,
      variants,
    };
  }

  async getFileStream(key: string): Promise<{
    stream: NodeJS.ReadableStream;
    contentType?: string;
    contentLength?: number;
    contentDisposition?: string;
    eTag?: string;
    lastModified?: Date;
  }> {
    const cleanKey = key.replace(/^\/+/, '');
    const res = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: cleanKey,
      })
    );

    this.knownExistingKeys.add(cleanKey);

    return {
      stream: res.Body as unknown as NodeJS.ReadableStream,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
      contentDisposition: res.ContentDisposition,
      eTag: res.ETag,
      lastModified: res.LastModified,
    };
  }

  async getFileBuffer(key: string): Promise<{
    buffer: Buffer;
    contentType?: string;
    contentLength?: number;
    eTag?: string;
    lastModified?: Date;
  }> {
    const file = await this.getFileStream(key);
    const buffer = await streamToBuffer(file.stream);
    return {
      buffer,
      contentType: file.contentType,
      contentLength: buffer.length,
      eTag: file.eTag,
      lastModified: file.lastModified,
    };
  }

  async deleteFile(key: string): Promise<void> {
    try {
      const cleanKey = key.replace(/^\/+/, '');
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: cleanKey,
        })
      );
      this.knownExistingKeys.delete(cleanKey);

      // Clean up associated variants if this was an image
      for (const v of ['thumbnail', 'small', 'medium', 'large'] as const) {
        const vKey = ImageProcessorService.getVariantKey(cleanKey, v, 'webp');
        await this.s3
          .send(
            new DeleteObjectCommand({
              Bucket: this.bucket,
              Key: vKey,
            })
          )
          .catch(() => {});
        this.knownExistingKeys.delete(vKey);
      }

      console.log(`[Storage] Deleted ${cleanKey} and variants from Cloudflare R2`);
    } catch (err) {
      console.warn('[Storage] Cloudflare R2 delete error:', err);
    }
  }
}

export const storageService: IStorageService = new CloudflareR2StorageService();
