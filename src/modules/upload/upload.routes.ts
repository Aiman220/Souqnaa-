import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import dns from 'dns/promises';
import { storageService } from '../../services/storage/storage.service';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { uploadFileLimiter, uploadByUrlLimiter } from '../../middleware/rate-limiter.middleware';
import { ImageProcessorService } from '../../services/storage/image-processor.service';

const router = Router();
router.use(authenticate);

// Allowlist of valid R2 folder prefixes that clients may write into.
// Never allow arbitrary user-supplied paths to reach the storage bucket.
export const ALLOWED_UPLOAD_FOLDERS = new Set([
  'general',
  'products',
  'categories',
  'stores',
  'avatars',
  'chat',
  'support',
  'refunds',
  'reviews',
  'disputes',
  'documents',
  'reports',
  'promotions',
  'campaign-badges',
  'branding',
]);

/** Folder specific file-size limits (§7) */
const FOLDER_MAX_SIZES: Record<string, number> = {
  avatars: 5 * 1024 * 1024,
  stores: 5 * 1024 * 1024,
  categories: 5 * 1024 * 1024,
  'campaign-badges': 5 * 1024 * 1024,
  branding: 5 * 1024 * 1024,
  products: 10 * 1024 * 1024,
  promotions: 10 * 1024 * 1024,
  general: 10 * 1024 * 1024,
  reviews: 10 * 1024 * 1024,
  chat: 25 * 1024 * 1024,
  support: 25 * 1024 * 1024,
  refunds: 25 * 1024 * 1024,
  disputes: 25 * 1024 * 1024,
  documents: 25 * 1024 * 1024,
  reports: 25 * 1024 * 1024,
};

function enforceFolderFileSizeLimit(file: Express.Multer.File, folder: string) {
  const maxSize = FOLDER_MAX_SIZES[folder] || 15 * 1024 * 1024;
  if (file.size > maxSize) {
    const mb = Math.round(maxSize / (1024 * 1024));
    throw new AppError(
      `حجم الملف يتجاوز الحد الأقصى المسموح به لمجلد ${folder} (${mb} ميجابايت)`,
      400,
      'FILE_TOO_LARGE'
    );
  }
}

/** Sanitise a client-supplied folder name: must be in the allowlist, no path traversal. */
function sanitizeFolder(raw: unknown, defaultFolder = 'general'): string {
  if (typeof raw !== 'string' || !raw.trim()) return defaultFolder;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return ALLOWED_UPLOAD_FOLDERS.has(cleaned) ? cleaned : defaultFolder;
}

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'application/pdf',
]);

export const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.mp4',
  '.webm',
  '.mov',
  '.mp3',
  '.wav',
  '.m4a',
  '.pdf',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIME_TYPES.has(mime)) {
      return cb(
        new AppError(
          'نوع الملف غير مدعوم لأسباب أمنية. يسمح فقط بالصور (JPG, PNG, WebP) ومقاطع الفيديو ومستندات PDF.',
          400,
          'UNSUPPORTED_FILE_TYPE'
        )
      );
    }
    cb(null, true);
  },
});

export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().trim();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.corp') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc00:') ||
    host.startsWith('fd') ||
    host.includes('::ffff:127.') ||
    host.includes('::ffff:10.') ||
    host.includes('::ffff:192.168.') ||
    host.includes('::ffff:169.254.')
  ) {
    return true;
  }

  // IPv4 regex check
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [_, o1, o2] = ipv4Match.map(Number);
    if (o1 === 127) return true; // Loopback
    if (o1 === 10) return true; // 10.0.0.0/8
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
    if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16
    if (o1 === 169 && o2 === 254) return true; // Link-local / Cloud metadata (AWS, GCP, Azure)
    if (o1 === 0) return true;
  }

  return false;
}

// POST /api/v1/upload (single)
router.post('/', uploadFileLimiter, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError('No file uploaded', 400);

    const folder = sanitizeFolder(req.body.folder);
    enforceFolderFileSizeLimit(req.file, folder);

    // Deep magic-bytes validation (§7: "Do not trust client-provided MIME types or file extensions")
    ImageProcessorService.detectMimeFromBuffer(req.file.buffer);

    const result = await storageService.uploadFile(req.file, folder);

    ResponseUtil.created(res, result, 'File uploaded successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/upload/multiple
router.post('/multiple', uploadFileLimiter, upload.array('files', 10), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) throw new AppError('No files uploaded', 400);

    const folder = sanitizeFolder(req.body.folder);

    for (const f of files) {
      enforceFolderFileSizeLimit(f, folder);
      ImageProcessorService.detectMimeFromBuffer(f.buffer);
    }

    const results = await Promise.all(
      files.map((f) => storageService.uploadFile(f, folder))
    );

    ResponseUtil.created(res, results, 'Files uploaded successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/upload/by-url (SSRF-hardened & magic-bytes inspected)
router.post('/by-url', uploadByUrlLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = req.body;
    const folder = sanitizeFolder(req.body.folder, 'products');
    if (!url || typeof url !== 'string' || !url.trim()) {
      throw new AppError('رابط الصورة مطلوب', 400);
    }

    const cleanUrl = url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(cleanUrl);
    } catch {
      throw new AppError('رابط غير صالح', 400, 'INVALID_URL');
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new AppError('بروتوكول الرابط غير مدعوم. يسمح فقط بروابط HTTP/HTTPS.', 400, 'INVALID_PROTOCOL');
    }

    if (isPrivateOrReservedHost(parsedUrl.hostname)) {
      throw new AppError('لا يمكن استرداد الملفات من عناوين الشبكة الداخلية أو العناوين المحجوزة.', 403, 'SSRF_BLOCKED');
    }

    // Resolve DNS and verify resolved IP to prevent DNS rebinding attacks
    try {
      const resolved = await dns.lookup(parsedUrl.hostname);
      if (isPrivateOrReservedHost(resolved.address)) {
        throw new AppError('لا يمكن استرداد الملفات من عناوين الشبكة الداخلية أو العناوين المحجوزة.', 403, 'SSRF_BLOCKED');
      }
    } catch (dnsErr: any) {
      if (dnsErr instanceof AppError) throw dnsErr;
      throw new AppError('تعذر التحقق من عنوان الخادم للرابط المطلوب.', 400, 'DNS_LOOKUP_FAILED');
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(cleanUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SOUQNA-Media-Fetcher/1.0',
          'Accept': 'image/jpeg,image/png,image/webp,image/gif,application/pdf,video/mp4',
        },
      });
      clearTimeout(timeout);

      if (response.ok) {
        const rawContentType = (response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();

        if (!ALLOWED_MIME_TYPES.has(rawContentType)) {
          throw new AppError('نوع محتوى الملف المسترد غير مدعوم أو غير آمن.', 400, 'UNSUPPORTED_MEDIA_TYPE');
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const maxSize = FOLDER_MAX_SIZES[folder] || 10 * 1024 * 1024;
        if (buffer.length > maxSize) {
          throw new AppError(`حجم الملف المسترد يتجاوز الحد الأقصى (${Math.round(maxSize / (1024 * 1024))} ميجابايت).`, 400, 'FILE_TOO_LARGE');
        }

        // Verify buffer magic bytes
        const detected = ImageProcessorService.detectMimeFromBuffer(buffer);

        const mockFile: Express.Multer.File = {
          fieldname: 'file',
          originalname: `download-${Date.now()}${detected.ext}`,
          encoding: '7bit',
          mimetype: detected.mime,
          buffer,
          size: buffer.length,
          destination: '',
          filename: '',
          path: '',
          stream: null as any,
        };

        const result = await storageService.uploadFile(mockFile, folder);
        ResponseUtil.created(res, result, 'تم تحميل وحفظ الملف بنجاح');
        return;
      }
    } catch (fetchErr: any) {
      if (fetchErr instanceof AppError) throw fetchErr;
      console.warn('[Upload by URL] Direct download failed:', fetchErr?.message);
    }

    throw new AppError('تعذر تحميل الملف من الرابط المحدد. يرجى التحقق من الرابط وصيغة الملف.', 400, 'FETCH_FAILED');
  } catch (error) {
    next(error);
  }
});

export const uploadRoutes = router;
