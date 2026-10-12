import path from 'path';
import { Router, Request, Response } from 'express';
import { storageService } from '../../services/storage/storage.service';

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
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * GET /api/v1/storage/file/*
 * Streams any stored file directly from Cloudflare R2 / S3
 * with correct MIME headers, CORS, and Content-Disposition.
 */
router.get('/file/*', async (req: Request, res: Response) => {
  try {
    const rawKey = req.params[0] || (req.query.key as string);
    if (!rawKey) {
      return res.status(400).json({ success: false, message: 'Missing file key' });
    }

    const key = decodeURIComponent(rawKey).replace(/^\/+/, '');
    const file = await storageService.getFileStream(key);

    const ext = path.extname(key).toLowerCase();
    const detectedMime = MIME_MAP[ext] || file.contentType || 'application/octet-stream';

    res.setHeader('Content-Type', detectedMime);

    if (file.contentLength) {
      res.setHeader('Content-Length', file.contentLength);
    }

    // CORS, Expose, & Cache
    res.removeHeader('Cross-Origin-Opener-Policy');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('X-Download-Options');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    // Filename resolution
    const requestedName = (req.query.name as string) || key.split('/').pop() || 'file';
    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const dispositionType = isDownload ? 'attachment' : (ext === '.pdf' || detectedMime.startsWith('image/') || detectedMime.startsWith('audio/') || detectedMime.startsWith('video/') ? 'inline' : 'attachment');

    const encodedName = encodeURIComponent(requestedName);
    res.setHeader(
      'Content-Disposition',
      `${dispositionType}; filename="${encodedName}"; filename*=UTF-8''${encodedName}`
    );

    (file.stream as any).pipe(res);
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }
    console.error('[Storage Router] Error streaming file:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve file' });
  }
});

export const storageRoutes = router;

