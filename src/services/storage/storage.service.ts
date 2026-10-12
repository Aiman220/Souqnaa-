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
  private publicUrl: string;

  constructor() {
    this.bucket = config.storage.s3.bucket || 'sogana';
    
    // If publicUrl is the private S3 API endpoint (*.r2.cloudflarestorage.com),
    // we route through the backend streaming endpoint so browsers & apps can access files publicly
    const rawPublicUrl = config.storage.s3.publicUrl || '';
    if (rawPublicUrl && !rawPublicUrl.includes('r2.cloudflarestorage.com')) {
      this.publicUrl = rawPublicUrl.replace(/\/+$/, '');
    } else {
      const port = config.port || 3000;
      this.publicUrl = `http://localhost:${port}${config.apiPrefix}/storage/file`;
    }

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

  getPublicUrl(key: string): string {
    const cleanKey = key.replace(/^\/+/, '');
    return `${this.publicUrl}/${cleanKey}`;
  }

  normalizeUrl(rawUrl: string | null | undefined): string {
    if (!rawUrl) return '';
    // If rawUrl is a private R2 endpoint, convert to public streaming URL
    if (rawUrl.includes('r2.cloudflarestorage.com')) {
      const match = rawUrl.match(/r2\.cloudflarestorage\.com\/[^/]+\/(.+)$/);
      if (match && match[1]) {
        return this.getPublicUrl(match[1]);
      }
    }
    return rawUrl;
  }

  async uploadFile(file: Express.Multer.File, folder = 'general'): Promise<UploadResult> {
    const ext = path.extname(file.originalname);
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

