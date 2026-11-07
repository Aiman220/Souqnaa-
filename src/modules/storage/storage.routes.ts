import path from 'path';
import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { storageService } from '../../services/storage/storage.service';
import { authenticate } from '../../middleware/auth.middleware';
import { AppError } from '../../middleware/error.middleware';
import { ImageProcessorService, ImageVariantName, IMAGE_VARIANTS } from '../../services/storage/image-processor.service';
import { imageMetricsService } from '../../services/storage/image-metrics.service';

const router = Router();

const MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// Folder prefixes that require an authenticated session before streaming.
const PRIVATE_FOLDER_PREFIXES = [
  'refunds/',
  'support/',
  'disputes/',
  'documents/',
  'reports/',
];

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

/**
 * Normalizes user-supplied tier or variant string into standard ImageVariantName.
 */
function normalizeVariantName(raw: string | undefined): ImageVariantName | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower === 'thumb' || lower === 'thumbnail') return 'thumbnail';
  if (lower === 'small' || lower === 'sm') return 'small';
  if (lower === 'medium' || lower === 'md') return 'medium';
  if (lower === 'large' || lower === 'lg') return 'large';
  if (lower === 'original' || lower === 'raw') return 'original';
  return undefined;
}

/**
 * Resolves optimal target width from requested parameters.
 */
function resolveTargetWidth(variant?: ImageVariantName, requestedWidth?: number): number | undefined {
  if (variant && variant !== 'original' && IMAGE_VARIANTS[variant]) {
    return IMAGE_VARIANTS[variant].width;
  }
  if (requestedWidth && requestedWidth > 0) {
    if (requestedWidth <= 150) return 150;
    if (requestedWidth <= 320) return 320;
    if (requestedWidth <= 640) return 640;
    if (requestedWidth <= 1024) return 1024;
    return Math.min(2048, requestedWidth);
  }
  return undefined;
}

/**
 * GET /api/v1/storage/metrics
 * Performance, bandwidth savings, and cache hit ratio observability snapshot (§9).
 * Protected: requires ADMIN authentication.
 */
router.get('/metrics', authenticate, async (req: any, res: Response) => {
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  res.setHeader('Cache-Control', 'no-store, private');
  res.json({
    success: true,
    data: imageMetricsService.getSnapshot(),
  });
});

/**
 * POST /api/v1/storage/metrics/reset
 */
router.post('/metrics/reset', authenticate, async (req: any, res: Response) => {
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  imageMetricsService.reset();
  res.json({ success: true, message: 'Image metrics reset successfully' });
});

/**
 * GET & HEAD /api/v1/storage/file/*
 * Optimized image delivery with automatic variant selection, Cloudflare CDN headers,
 * 304 Not Modified revalidation, WebP/AVIF format conversion, and backward compatibility.
 */
async function handleFileRequest(req: Request, res: Response, next: NextFunction, isHead = false) {
  const startTime = Date.now();
  try {
    const rawKey = req.params[0] || (req.query.key as string);
    if (!rawKey) {
      return res.status(400).json({ success: false, message: 'Missing file key' });
    }

    // --- 1. Path traversal guard ---
    const key = decodeURIComponent(rawKey).replace(/^\/+/, '');
    if (
      key.includes('..') ||
      key.includes('\\') ||
      key.startsWith('/') ||
      /[\x00-\x1f]/.test(key)
    ) {
      return res.status(400).json({ success: false, message: 'Invalid file key' });
    }

    // --- 2. Auth gate for private folders ---
    const isPrivate = PRIVATE_FOLDER_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (isPrivate) {
      await new Promise<void>((resolve, reject) => {
        authenticate(req, res, (err?: any) => {
          if (err) reject(err instanceof AppError ? err : new AppError('Unauthorized', 401));
          else resolve();
        });
      });

      // Role authorization for privileged folders
      const userRole = (req as any).user?.role;
      if (key.startsWith('reports/')) {
        if (userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN' && userRole !== 'SELLER') {
          return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions to access reports' });
        }
      }
    }

    const ext = path.extname(key).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(ext);

    // --- 3. Determine variant and format ---
    const rawVariant = req.query.variant as string || req.query.tier as string;
    const requestedVariant = normalizeVariantName(rawVariant);
    const requestedWidth = parseInt(req.query.w as string || req.query.width as string, 10) || undefined;
    const requestedQuality = parseInt(req.query.q as string || req.query.quality as string, 10) || 80;

    let targetFormat: 'webp' | 'avif' | 'jpeg' = 'webp';
    const fmtQuery = (req.query.fmt as string || req.query.format as string || '').toLowerCase();
    if (fmtQuery === 'avif' || req.headers.accept?.includes('image/avif')) {
      targetFormat = 'avif';
    } else if (fmtQuery === 'jpeg' || fmtQuery === 'jpg') {
      targetFormat = 'jpeg';
    } else {
      targetFormat = 'webp';
    }

    const targetWidth = resolveTargetWidth(requestedVariant, requestedWidth);

    // If key is already a variant key (e.g. products/variants/123_small.webp), serve it directly
    const isDirectVariantPath = key.includes('/variants/');

    // Check if variant pre-exists in R2
    let effectiveKey = key;
    let shouldServeDirectVariant = false;

    if (isImage && !isDirectVariantPath && requestedVariant && requestedVariant !== 'original') {
      const candidateVariantKey = ImageProcessorService.getVariantKey(key, requestedVariant, 'webp');
      const variantExists = await storageService.objectExists(candidateVariantKey);
      if (variantExists) {
        effectiveKey = candidateVariantKey;
        shouldServeDirectVariant = true;
      }
    }

    // --- 4. Fetch stream from storage ---
    let fileStreamObj;
    let fallbackGeneratedBuffer: Buffer | null = null;
    let effectiveMime = MIME_MAP[ext] || 'application/octet-stream';

    try {
      fileStreamObj = await storageService.getFileStream(effectiveKey);
    } catch (fetchErr: any) {
      // If the direct variant key or requested variant is not found in R2,
      // dynamically generate the variant from the original image on-the-fly!
      if (
        isImage &&
        (fetchErr?.name === 'NoSuchKey' || fetchErr?.$metadata?.httpStatusCode === 404) &&
        (targetWidth || isDirectVariantPath)
      ) {
        // Resolve original key by stripping /variants/ and _variant suffix
        let originalKey = key;
        if (isDirectVariantPath) {
          originalKey = key
            .replace('/variants/', '/')
            .replace(/_(thumbnail|small|medium|large)\.(webp|avif|jpg|jpeg|png)$/, ext);
        }

        try {
          const original = await storageService.getFileBuffer(originalKey);
          const computedWidth = targetWidth || 320;
          const processed = await ImageProcessorService.createVariant(original.buffer, computedWidth, {
            quality: requestedQuality,
            format: targetFormat,
          });

          fallbackGeneratedBuffer = processed.buffer;
          effectiveMime = processed.mimeType;

          // Asynchronously save generated variant to R2 for future instant cache hits (§2, §11)
          const targetVariantName: ImageVariantName = requestedVariant || (computedWidth <= 150 ? 'thumbnail' : computedWidth <= 320 ? 'small' : computedWidth <= 640 ? 'medium' : 'large');
          const saveKey = ImageProcessorService.getVariantKey(originalKey, targetVariantName, targetFormat);
          storageService.putObject(saveKey, processed.buffer, processed.mimeType).catch((saveErr) => {
            console.warn('[Storage] Failed to cache on-demand variant to R2:', saveErr);
          });
        } catch (genErr) {
          console.warn('[Storage] On-demand variant generation failed:', genErr);
          return res.status(404).json({ success: false, message: 'Image variant not found' });
        }
      } else {
        throw fetchErr;
      }
    }

    // --- 5. Generate and check ETag / 304 Not Modified ---
    const effectiveExt = path.extname(effectiveKey).toLowerCase();
    effectiveMime = fallbackGeneratedBuffer
      ? effectiveMime
      : (MIME_MAP[effectiveExt] || fileStreamObj?.contentType || effectiveMime);

    const contentLength = fallbackGeneratedBuffer
      ? fallbackGeneratedBuffer.length
      : fileStreamObj?.contentLength;

    const rawETag = fileStreamObj?.eTag || (fallbackGeneratedBuffer
      ? `"${crypto.createHash('md5').update(fallbackGeneratedBuffer).digest('hex')}"`
      : undefined);

    const clientETag = req.headers['if-none-match'];
    const clientSince = req.headers['if-modified-since'];

    // 304 Not Modified validation
    if (
      (rawETag && clientETag && (clientETag === rawETag || clientETag === `W/${rawETag}`)) ||
      (fileStreamObj?.lastModified && clientSince && new Date(clientSince) >= new Date(fileStreamObj.lastModified))
    ) {
      imageMetricsService.recordRequest({
        variant: requestedVariant || 'original',
        isHit: true,
        is304: true,
        bytesTransferred: 0,
        processingDurationMs: Date.now() - startTime,
      });

      res.status(304).end();
      return;
    }

    // --- 6. Set response headers ---
    res.setHeader('Content-Type', effectiveMime);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    if (rawETag) {
      res.setHeader('ETag', rawETag);
    }
    if (fileStreamObj?.lastModified) {
      res.setHeader('Last-Modified', new Date(fileStreamObj.lastModified).toUTCString());
    }

    // Security & CORS
    res.removeHeader('Cross-Origin-Opener-Policy');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('X-Download-Options');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type, ETag');
    res.setHeader('Vary', 'Accept, Accept-Encoding');

    // CDN Caching policy
    if (isPrivate) {
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }

    // Filename resolution for Content-Disposition
    const rawName = typeof req.query.name === 'string' ? req.query.name : effectiveKey.split('/').pop() || 'file';
    const requestedName = rawName.replace(/[\r\n"\\]/g, '').slice(0, 200);
    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const dispositionType = isDownload
      ? 'attachment'
      : (ext === '.pdf' || effectiveMime.startsWith('image/') || effectiveMime.startsWith('audio/') || effectiveMime.startsWith('video/')
        ? 'inline'
        : 'attachment');

    const encodedName = encodeURIComponent(requestedName);
    res.setHeader(
      'Content-Disposition',
      `${dispositionType}; filename="${encodedName}"; filename*=UTF-8''${encodedName}`
    );

    // --- 7. Metrics tracking ---
    const bytesTransferred = contentLength || 0;
    imageMetricsService.recordRequest({
      variant: requestedVariant || (isDirectVariantPath ? 'variant' : 'original'),
      isHit: shouldServeDirectVariant || isDirectVariantPath,
      is304: false,
      bytesTransferred,
      processingDurationMs: Date.now() - startTime,
    });

    if (isHead) {
      res.status(200).end();
      return;
    }

    // --- 8. Deliver payload ---
    if (fallbackGeneratedBuffer) {
      res.status(200).send(fallbackGeneratedBuffer);
    } else if (fileStreamObj?.stream) {
      (fileStreamObj.stream as any).pipe(res);
    } else {
      res.status(200).end();
    }
  } catch (err: any) {
    imageMetricsService.recordRequest({
      isHit: false,
      isError: true,
      bytesTransferred: 0,
      processingDurationMs: Date.now() - startTime,
    });

    if (err instanceof AppError) return next(err);
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }
    console.error('[Storage Router] Error streaming file:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve file' });
  }
}

router.get('/file/*', (req: Request, res: Response, next: NextFunction) => {
  handleFileRequest(req, res, next, false);
});

router.head('/file/*', (req: Request, res: Response, next: NextFunction) => {
  handleFileRequest(req, res, next, true);
});

export const storageRoutes = router;
