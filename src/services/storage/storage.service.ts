import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

export interface PresignedUploadResult {
  uploadUrl: string;
  key: string;
  publicUrl: string;
  expiresIn: number;
  headers: Record<string, string>;
}

export interface IStorageService {
  uploadFile(file: Express.Multer.File, folder?: string): Promise<UploadResult>;
  deleteFile(key: string): Promise<void>;
  createPresignedUploadUrl(
    folder: string,
    filename: string,
    mimeType: string,
    fileSize?: number
  ): Promise<PresignedUploadResult>;
  verifyUploadedObject(key: string, expectedFolder?: string): Promise<UploadResult>;
  getFileStream(key: string, range?: string): Promise<{
    stream: NodeJS.ReadableStream;
    contentType?: string;
    contentLength?: number;
    contentRange?: string;
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
  createPresignedDownloadUrl(key: string, expiresIn?: number): Promise<string>;
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
    // 1. Explicit override via ASSETS_BASE_URL env var (highest priority)
    const assetsBaseUrlOverride = process.env.ASSETS_BASE_URL || '';
    if (assetsBaseUrlOverride && !assetsBaseUrlOverride.includes('r2.cloudflarestorage.com')) {
      return assetsBaseUrlOverride.replace(/\/+$/, '');
    }

    // 2. S3_PUBLIC_URL if it's not a private R2 endpoint
    const rawPublicUrl = config.storage.s3.publicUrl || '';
    if (rawPublicUrl && !rawPublicUrl.includes('r2.cloudflarestorage.com')) {
      return rawPublicUrl.replace(/\/+$/, '');
    }

    // 3. Cloudflare CDN delivery domain from config — only use if it's explicitly
    //    set via env var (meaning DNS is actually live), not the hardcoded default.
    //    The hardcoded "assets.souqnaa.com" may not yet have a DNS record.
    const envAssetsOverrideKey = `ASSETS_DOMAIN_${(config.env || 'production').toUpperCase()}`;
    const envAssetsDynamic = process.env[envAssetsOverrideKey] || '';
    if (envAssetsDynamic && !envAssetsDynamic.includes('r2.cloudflarestorage.com')) {
      return envAssetsDynamic.replace(/\/+$/, '');
    }

    // 4. Fall back to Render/backend streaming endpoint
    const serverBase =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.BACKEND_PUBLIC_URL ||
      process.env.API_BASE_URL ||
      config.domains?.backendPublicUrl ||
      `http://localhost:${config.port || 3000}`;

    return `${serverBase.replace(/\/+$/, '')}${config.apiPrefix}/storage/file`;
  }

  cleanKey(key: string): string {
    let k = (key || '').trim().replace(/^\/+/, '');
    if (k.includes('?')) {
      k = k.split('?')[0];
    }
    if (k.startsWith('http://') || k.startsWith('https://')) {
      try {
        k = new URL(k).pathname.replace(/^\/+/, '');
      } catch (_) {}
    }
    if (k.startsWith(`${this.bucket}/`)) {
      k = k.substring(this.bucket.length + 1);
    } else if (k.startsWith('sogana/')) {
      k = k.substring('sogana/'.length);
    }
    // Also remove any duplicate storage/file path prefix if accidentally passed as key
    k = k.replace(/^(api\/v1\/)?storage\/file\//, '');
    return k.replace(/^\/+/, '');
  }

  isPrivatePrefix(key: string): boolean {
    const k = this.cleanKey(key);
    return /^(chat|refunds|support|disputes|documents|reports|customer-deposits|finance_proofs|refund-evidence|seller-verification|withdrawals)\//.test(k);
  }

  async createPresignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const clean = this.cleanKey(key);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: clean,
    });
    return getSignedUrl(this.s3, command, { expiresIn });
  }

  private resolveAuthenticatedStorageBaseUrl(): string {
    const serverBase = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_PUBLIC_URL ||
      process.env.API_BASE_URL || config.domains?.backendPublicUrl || `http://localhost:${config.port || 3000}`;
    return `${serverBase.replace(/\/+$/, '')}${config.apiPrefix}/storage/file`;
  }

  getPublicUrl(key: string): string {
    const clean = this.cleanKey(key);
    if (this.isPrivatePrefix(clean)) {
      return `${this.resolveAuthenticatedStorageBaseUrl()}/${clean}`;
    }
    return `${this.resolveBaseUrl()}/${clean}`;
  }

  getVariantUrl(key: string, variant: ImageVariantName): string {
    const clean = this.cleanKey(key);
    if (variant === 'original') return this.getPublicUrl(clean);
    const variantKey = ImageProcessorService.getVariantKey(clean, variant, 'webp');
    return this.getPublicUrl(variantKey);
  }

  normalizeUrl(rawUrl: string | null | undefined): string {
    if (!rawUrl) return '';
    let trimmed = rawUrl.trim();

    // 0. Unwrap duplicate or embedded URLs (e.g. ".../storage/file/https://...")
    if (trimmed.includes('https://') || trimmed.includes('http://')) {
      const lastHttpIndex = Math.max(trimmed.lastIndexOf('https://'), trimmed.lastIndexOf('http://'));
      if (lastHttpIndex > 0) {
        trimmed = trimmed.substring(lastHttpIndex);
      }
    }

    // 1. If rawUrl is a private R2 endpoint, convert to public streaming URL
    if (trimmed.includes('r2.cloudflarestorage.com')) {
      const match = trimmed.match(/r2\.cloudflarestorage\.com\/[^/]+\/(.+)$/);
      if (match && match[1]) {
        return this.getPublicUrl(this.cleanKey(match[1]));
      }
    }

    // 1b. If rawUrl contains assets.souqnaa.com, dev-assets, or staging-assets
    if (
      trimmed.includes('assets.souqnaa.com') ||
      trimmed.includes('dev-assets.souqnaa.com') ||
      trimmed.includes('staging-assets.souqnaa.com')
    ) {
      const match = trimmed.match(/(assets|dev-assets|staging-assets)\.souqnaa\.com\/(.+)$/);
      if (match && match[2]) {
        return this.getPublicUrl(this.cleanKey(match[2]));
      }
    }

    // 2. If rawUrl contains localhost, 127.0.0.1, or 10.0.2.2 on deployed server (e.g. Render)
    if (
      (trimmed.includes('localhost') || trimmed.includes('127.0.0.1') || trimmed.includes('10.0.2.2')) &&
      (process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_PUBLIC_URL || process.env.NODE_ENV === 'production')
    ) {
      const filePart = trimmed.match(/\/(api\/v1\/)?storage\/file\/(.+)$/);
      if (filePart && filePart[2]) {
        return this.getPublicUrl(this.cleanKey(filePart[2]));
      }
    }

    // 3. If it's a relative path starting with /api/v1/storage/file or /storage/file
    if (trimmed.includes('/api/v1/storage/file/')) {
      const cleanKey = trimmed.substring(trimmed.lastIndexOf('/api/v1/storage/file/') + '/api/v1/storage/file/'.length);
      return this.getPublicUrl(this.cleanKey(cleanKey));
    }
    if (trimmed.includes('/storage/file/')) {
      const cleanKey = trimmed.substring(trimmed.lastIndexOf('/storage/file/') + '/storage/file/'.length);
      return this.getPublicUrl(this.cleanKey(cleanKey));
    }

    // 4. If it's an external absolute URL (HTTP/HTTPS) that is NOT one of our domains, return intact
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }

    // 5. If it's a relative key like "products/..." or "sogana/products/..."
    return this.getPublicUrl(this.cleanKey(trimmed));
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
    try {
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
    } catch (s3Err) {
      console.warn(`[Storage] S3 putObject failed for ${cleanKey}, syncing locally:`, s3Err);
    }

    // Mirror to local upload directory for zero-latency local fallback & static access
    try {
      const localPath = path.resolve(process.cwd(), config.storage.uploadDir, cleanKey);
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(localPath, body);
      this.knownExistingKeys.add(cleanKey);
    } catch (fsErr) {
      console.error(`[Storage] Local writeFileSync failed for ${cleanKey}:`, fsErr);
    }
  }

  async createPresignedUploadUrl(
    folder = 'general',
    filename: string,
    mimeType: string,
    fileSize: number
  ): Promise<PresignedUploadResult> {
    const cleanFolder = folder.replace(/^\/+|\/+$/g, '') || 'general';
    const ext =
      path.extname(filename || '').toLowerCase() ||
      (mimeType === 'image/jpeg'
        ? '.jpg'
        : mimeType === 'image/png'
        ? '.png'
        : mimeType === 'image/webp'
        ? '.webp'
        : mimeType === 'application/pdf'
        ? '.pdf'
        : mimeType === 'video/mp4'
        ? '.mp4'
        : '.bin');
    const nonce = crypto.randomBytes(8).toString('hex');
    const key = `${cleanFolder}/${Date.now()}-${nonce}${ext}`;

    const isPrivate =
      cleanFolder.startsWith('refund') ||
      cleanFolder.startsWith('dispute') ||
      cleanFolder.startsWith('support') ||
      cleanFolder.startsWith('chat') ||
      cleanFolder.startsWith('document') ||
      cleanFolder.startsWith('report');

    const cacheControl = isPrivate ? 'private, no-store' : 'public, max-age=31536000, immutable';

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mimeType,
      ContentLength: fileSize,
      CacheControl: cacheControl,
    });

    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: 3600 });
    const publicUrl = this.getPublicUrl(key);

    return {
      uploadUrl,
      key,
      publicUrl,
      expiresIn: 3600,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(fileSize),
      },
    };
  }

  async verifyUploadedObject(key: string, expectedFolder?: string): Promise<UploadResult> {
    const cleanKey = key.replace(/^\/+/, '');
    if (cleanKey.includes('..') || cleanKey.includes('\\') || /[\x00-\x1f]/.test(cleanKey)) {
      throw new Error('Invalid storage key');
    }

    if (expectedFolder) {
      const cleanExpected = expectedFolder.replace(/^\/+|\/+$/g, '');
      if (!cleanKey.startsWith(`${cleanExpected}/`)) {
        throw new Error(`Object key does not belong to expected folder ${expectedFolder}`);
      }
    }

    // 1. Verify object exists via HEAD
    const head = await this.s3.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: cleanKey,
      })
    );

    const size = head.ContentLength || 0;
    if (size === 0) {
      throw new Error('Uploaded object is empty or not found');
    }

    // 2. Fetch header bytes to verify real magic bytes & MIME type
    let headerBuffer: Buffer;
    try {
      const rangeRes = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: cleanKey,
          Range: 'bytes=0-1023',
        })
      );
      headerBuffer = await streamToBuffer(rangeRes.Body as NodeJS.ReadableStream);
    } catch {
      const full = await this.getFileBuffer(cleanKey);
      headerBuffer = full.buffer;
    }

    const detected = ImageProcessorService.detectMimeFromBuffer(headerBuffer);
    this.knownExistingKeys.add(cleanKey);

    let width: number | undefined;
    let height: number | undefined;
    let hash: string | undefined;

    // 3. For images, inspect metadata and auto-generate variants in background
    if (detected.isImage) {
      try {
        const full = await this.getFileBuffer(cleanKey);
        const metadata = await ImageProcessorService.inspectImage(full.buffer);
        width = metadata.width;
        height = metadata.height;
        hash = metadata.sha256;

        setImmediate(async () => {
          try {
            const variants = await ImageProcessorService.generateAllVariants(full.buffer, cleanKey);
            for (const v of variants) {
              await this.putObject(v.key, v.buffer, v.mimeType);
              this.knownExistingKeys.add(v.key);
            }
            console.log(`[Storage] Generated ${variants.length} background variants for verified key ${cleanKey}`);
          } catch (varErr) {
            console.warn(`[Storage] Background variant generation failed for verified key ${cleanKey}:`, varErr);
          }
        });
      } catch (metaErr) {
        console.warn(`[Storage] Failed to inspect image metadata for ${cleanKey}:`, metaErr);
      }
    }

    const variants: ImageVariantUrls = {
      thumbnail: this.getVariantUrl(cleanKey, 'thumbnail'),
      small: this.getVariantUrl(cleanKey, 'small'),
      medium: this.getVariantUrl(cleanKey, 'medium'),
      large: this.getVariantUrl(cleanKey, 'large'),
      original: this.getPublicUrl(cleanKey),
    };

    return {
      url: this.getPublicUrl(cleanKey),
      key: cleanKey,
      size,
      mimeType: detected.mime || head.ContentType || 'application/octet-stream',
      width,
      height,
      hash,
      variants,
    };
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
      folder.startsWith('refunds') || folder.startsWith('disputes') || folder.startsWith('support') || folder.startsWith('chat')
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

  async getFileStream(key: string, range?: string): Promise<{
    stream: NodeJS.ReadableStream;
    contentType?: string;
    contentLength?: number;
    contentRange?: string;
    contentDisposition?: string;
    eTag?: string;
    lastModified?: Date;
  }> {
    const cleanKey = key.replace(/^\/+/, '');

    try {
      const res = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: cleanKey,
          Range: range,
        })
      );

      this.knownExistingKeys.add(cleanKey);

      return {
        stream: res.Body as unknown as NodeJS.ReadableStream,
        contentType: res.ContentType,
        contentLength: res.ContentLength,
        contentRange: res.ContentRange,
        contentDisposition: res.ContentDisposition,
        eTag: res.ETag,
        lastModified: res.LastModified,
      };
    } catch (s3Err) {
      // Local disk fallback for assets stored in uploadDir
      const localPath = path.resolve(process.cwd(), config.storage.uploadDir, cleanKey);
      if (fs.existsSync(localPath)) {
        const stats = fs.statSync(localPath);
        const ext = path.extname(localPath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.gif': 'image/gif',
          '.ico': 'image/x-icon',
          '.pdf': 'application/pdf',
        };
        const detectedMime = mimeTypes[ext] || 'application/octet-stream';
        this.knownExistingKeys.add(cleanKey);

        return {
          stream: fs.createReadStream(localPath),
          contentType: detectedMime,
          contentLength: stats.size,
          eTag: `"${Math.round(stats.mtimeMs)}-${stats.size}"`,
          lastModified: stats.mtime,
        };
      }
      throw s3Err;
    }
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
