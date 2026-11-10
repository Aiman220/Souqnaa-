import sharp from 'sharp';
import crypto from 'crypto';
import { AppError } from '../../middleware/error.middleware';

export type ImageVariantName = 'thumbnail' | 'small' | 'medium' | 'large' | 'original';

export interface VariantDefinition {
  name: ImageVariantName;
  width: number;
  quality: number;
  format: 'webp' | 'avif' | 'jpeg';
}

export const IMAGE_VARIANTS: Record<Exclude<ImageVariantName, 'original'>, VariantDefinition> = {
  thumbnail: { name: 'thumbnail', width: 150, quality: 80, format: 'webp' },
  small: { name: 'small', width: 320, quality: 80, format: 'webp' },
  medium: { name: 'medium', width: 640, quality: 80, format: 'webp' },
  large: { name: 'large', width: 1024, quality: 82, format: 'webp' },
};

export interface ProcessedVariant {
  name: ImageVariantName;
  buffer: Buffer;
  key: string;
  width: number;
  height: number;
  format: string;
  mimeType: string;
  size: number;
}

export interface ImageMetadataInfo {
  format: string;
  width: number;
  height: number;
  channels: number;
  hasAlpha: boolean;
  mimeType: string;
  sha256: string;
  size: number;
}

/** Maximum allowed input image resolution (50 Megapixels) to prevent decompression bomb / DoS attacks */
const MAX_IMAGE_PIXELS = 50 * 1024 * 1024;
const MAX_DIMENSION = 8192;

export class ImageProcessorService {
  /**
   * Validates file signature (magic bytes) to ensure the uploaded buffer matches a genuine, allowed format.
   * Does NOT trust client-supplied MIME type or file extension.
   */
  static detectMimeFromBuffer(buffer: Buffer): { mime: string; ext: string; isImage: boolean } {
    if (!buffer || buffer.length < 4) {
      throw new AppError('الملف فارغ أو تالف', 400, 'CORRUPTED_FILE');
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { mime: 'image/jpeg', ext: '.jpg', isImage: true };
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return { mime: 'image/png', ext: '.png', isImage: true };
    }

    // WebP: RIFF .... WEBP
    if (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return { mime: 'image/webp', ext: '.webp', isImage: true };
    }

    // GIF: GIF87a or GIF89a
    if (buffer.length >= 6 && buffer.toString('ascii', 0, 4) === 'GIF8') {
      return { mime: 'image/gif', ext: '.gif', isImage: true };
    }

    // AVIF / HEIF / MP4 / MOV / 3GP (ISO Base Media File Format: ftyp brand)
    if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
      const brand = buffer.toString('ascii', 8, 12).toLowerCase();
      if (brand === 'avif' || brand === 'avis') {
        return { mime: 'image/avif', ext: '.avif', isImage: true };
      }
      if (brand.startsWith('hei') || brand === 'mif1' || brand === 'msf1') {
        return { mime: 'image/heic', ext: '.heic', isImage: true };
      }
      if (brand.startsWith('qt')) {
        return { mime: 'video/quicktime', ext: '.mov', isImage: false };
      }
      // Any other ftyp brand is ISO BMFF video (mp4, isom, iso2, 3gp, dash, etc.)
      return { mime: 'video/mp4', ext: '.mp4', isImage: false };
    }

    // QuickTime MOV without ftyp (moov, mdat, wide, free)
    if (
      buffer.length >= 8 &&
      (buffer.toString('ascii', 4, 8) === 'moov' ||
        buffer.toString('ascii', 4, 8) === 'mdat' ||
        buffer.toString('ascii', 4, 8) === 'wide')
    ) {
      return { mime: 'video/quicktime', ext: '.mov', isImage: false };
    }

    // WebM / Matroska (MKV): EBML header 1A 45 DF A3
    if (
      buffer.length >= 4 &&
      buffer[0] === 0x1a &&
      buffer[1] === 0x45 &&
      buffer[2] === 0xdf &&
      buffer[3] === 0xa3
    ) {
      return { mime: 'video/webm', ext: '.webm', isImage: false };
    }

    // PDF: %PDF
    if (buffer.toString('ascii', 0, 4) === '%PDF') {
      return { mime: 'application/pdf', ext: '.pdf', isImage: false };
    }

    // MP3 (ID3 or sync word)
    if (
      buffer.toString('ascii', 0, 3) === 'ID3' ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
    ) {
      return { mime: 'audio/mpeg', ext: '.mp3', isImage: false };
    }

    // WAV: RIFF .... WAVE
    if (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WAVE'
    ) {
      return { mime: 'audio/wav', ext: '.wav', isImage: false };
    }

    throw new AppError(
      'نوع الملف غير مدعوم أو تالف. يسمح فقط بالصور (JPEG, PNG, WebP, GIF) ومستندات PDF ومقاطع الوسائط المعتمدة.',
      400,
      'INVALID_FILE_SIGNATURE'
    );
  }

  /**
   * Deeply inspects an image buffer using Sharp.
   * Enforces dimension and pixel bounds to protect against decompression bombs.
   */
  static async inspectImage(buffer: Buffer): Promise<ImageMetadataInfo> {
    const detected = this.detectMimeFromBuffer(buffer);
    if (!detected.isImage) {
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      return {
        format: detected.ext.replace('.', ''),
        width: 0,
        height: 0,
        channels: 0,
        hasAlpha: false,
        mimeType: detected.mime,
        sha256,
        size: buffer.length,
      };
    }

    try {
      const metadata = await sharp(buffer, { failOn: 'truncated' }).metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      const totalPixels = width * height;

      if (totalPixels > MAX_IMAGE_PIXELS || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new AppError(
          `أبعاد الصورة تتجاوز الحد الأقصى المسموح به (${MAX_DIMENSION}x${MAX_DIMENSION} بكسل)`,
          400,
          'IMAGE_DIMENSIONS_EXCEEDED'
        );
      }

      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      return {
        format: metadata.format || detected.ext.replace('.', ''),
        width,
        height,
        channels: metadata.channels || 3,
        hasAlpha: Boolean(metadata.hasAlpha),
        mimeType: detected.mime,
        sha256,
        size: buffer.length,
      };
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'تعذر قراءة بيانات الصورة. قد يكون الملف تالفاً أو غير صالح.',
        400,
        'IMAGE_DECODE_FAILED'
      );
    }
  }

  /**
   * Generates a variant key name from an original object key.
   * Example:
   * baseKey: "products/1730000000-1234.jpg"
   * variant: "thumbnail"
   * format: "webp"
   * Returns: "products/variants/1730000000-1234_thumbnail.webp"
   */
  static getVariantKey(baseKey: string, variant: ImageVariantName, format = 'webp'): string {
    const cleanKey = baseKey.replace(/^\/+/, '');
    if (variant === 'original') return cleanKey;

    const parts = cleanKey.split('/');
    const fileName = parts.pop() || 'image';
    const folder = parts.join('/');

    const baseName = fileName.replace(/\.[^/.]+$/, '');
    const variantFileName = `${baseName}_${variant}.${format}`;

    return folder ? `${folder}/variants/${variantFileName}` : `variants/${variantFileName}`;
  }

  /**
   * Optimizes and resizes a single image buffer.
   * Auto-orients according to EXIF orientation tag, strips metadata for privacy and size,
   * preserves aspect ratio, and encodes to WebP (or AVIF).
   */
  static async createVariant(
    buffer: Buffer,
    targetWidth: number,
    options: {
      quality?: number;
      format?: 'webp' | 'avif' | 'jpeg';
      fit?: 'inside' | 'cover';
    } = {}
  ): Promise<{ buffer: Buffer; width: number; height: number; format: string; mimeType: string }> {
    const format = options.format || 'webp';
    const quality = Math.min(100, Math.max(20, options.quality || 80));
    const fit = options.fit || 'inside';

    let pipeline = sharp(buffer, { failOn: 'none' })
      .rotate() // Automatically orient based on EXIF tag and strip orientation metadata
      .resize({
        width: targetWidth,
        fit,
        withoutEnlargement: true,
      });

    let mimeType = 'image/webp';
    if (format === 'avif') {
      pipeline = pipeline.avif({ quality: Math.max(50, quality - 10), effort: 4 });
      mimeType = 'image/avif';
    } else if (format === 'jpeg') {
      pipeline = pipeline.jpeg({ quality, progressive: true, mozjpeg: true });
      mimeType = 'image/jpeg';
    } else {
      pipeline = pipeline.webp({ quality, smartSubsample: true, effort: 4 });
      mimeType = 'image/webp';
    }

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    return {
      buffer: data,
      width: info.width,
      height: info.height,
      format,
      mimeType,
    };
  }

  /**
   * Generates all required standard variants for an uploaded image.
   * Thumbnail (150px), Small (320px), Medium (640px), Large (1024px).
   */
  static async generateAllVariants(
    buffer: Buffer,
    originalKey: string
  ): Promise<ProcessedVariant[]> {
    const variants: ProcessedVariant[] = [];

    for (const [key, def] of Object.entries(IMAGE_VARIANTS)) {
      const variantName = key as Exclude<ImageVariantName, 'original'>;
      try {
        const result = await this.createVariant(buffer, def.width, {
          quality: def.quality,
          format: def.format,
        });

        const variantKey = this.getVariantKey(originalKey, variantName, def.format);

        variants.push({
          name: variantName,
          buffer: result.buffer,
          key: variantKey,
          width: result.width,
          height: result.height,
          format: result.format,
          mimeType: result.mimeType,
          size: result.buffer.length,
        });
      } catch (err) {
        console.warn(`[ImageProcessor] Failed to generate variant ${variantName} for ${originalKey}:`, err);
      }
    }

    return variants;
  }
}

