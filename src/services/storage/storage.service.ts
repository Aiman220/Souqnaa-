import path from 'path';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../../config';

export interface UploadResult {
  url: string;
  key: string;
  size: number;
  mimeType: string;
}

export interface IStorageService {
  uploadFile(file: Express.Multer.File, folder?: string): Promise<UploadResult>;
  deleteFile(key: string): Promise<void>;
  getFileStream(key: string): Promise<{
    stream: NodeJS.ReadableStream;
    contentType?: string;
    contentLength?: number;
    contentDisposition?: string;
  }>;
  getPublicUrl(key: string): string;
  normalizeUrl(rawUrl: string | null | undefined): string;
}

class CloudflareR2StorageService implements IStorageService {
  private s3: S3Client;
  private bucket: string;

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

    return trimmed;
  }

  async uploadFile(file: Express.Multer.File, folder = 'general'): Promise<UploadResult> {
    const ext = file.originalname ? path.extname(file.originalname) : '.jpg';
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const key = `${folder}/${fileName}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    );

    console.log(`[Storage] Uploaded ${key} to Cloudflare R2 bucket: ${this.bucket} (${file.size} bytes)`);

    const url = this.getPublicUrl(key);

    return {
      url,
      key,
      size: file.size,
      mimeType: file.mimetype,
    };
  }

  async getFileStream(key: string): Promise<{
    stream: NodeJS.ReadableStream;
    contentType?: string;
    contentLength?: number;
    contentDisposition?: string;
  }> {
    const cleanKey = key.replace(/^\/+/, '');
    const res = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: cleanKey,
      })
    );

    return {
      stream: res.Body as unknown as NodeJS.ReadableStream,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
      contentDisposition: res.ContentDisposition,
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
      console.log(`[Storage] Deleted ${cleanKey} from Cloudflare R2`);
    } catch (err) {
      console.warn('[Storage] Cloudflare R2 delete error:', err);
    }
  }
}

export const storageService: IStorageService = new CloudflareR2StorageService();

