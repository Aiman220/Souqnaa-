import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import { storageService } from '../../services/storage/storage.service';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';

const router = Router();
router.use(authenticate);

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB limit
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
    host === '[::1]'
  ) {
    return true;
  }

  // IPv4 regex check
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [_, o1, o2] = ipv4Match.map(Number);
    if (o1 === 127) return true; // Loopback
    if (o1 === 10) return true;  // 10.0.0.0/8
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
    if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16
    if (o1 === 169 && o2 === 254) return true; // Link-local / Cloud metadata (AWS, GCP, Azure)
    if (o1 === 0) return true;
  }

  return false;
}

// POST /api/v1/upload (single)
router.post('/', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError('No file uploaded', 400);

    const folder = (req.body.folder as string) || 'general';
    const result = await storageService.uploadFile(req.file, folder);

    ResponseUtil.created(res, result, 'File uploaded successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/upload/multiple
router.post('/multiple', upload.array('files', 10), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) throw new AppError('No files uploaded', 400);

    const folder = (req.body.folder as string) || 'general';
    const results = await Promise.all(
      files.map((f) => storageService.uploadFile(f, folder))
    );

    ResponseUtil.created(res, results, 'Files uploaded successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/upload/by-url (SSRF-hardened)
router.post('/by-url', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, folder = 'products' } = req.body;
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

        if (buffer.length > 25 * 1024 * 1024) {
          throw new AppError('حجم الملف المسترد يتجاوز الحد الأقصى (25 ميجابايت).', 400, 'FILE_TOO_LARGE');
        }

        let ext = '.jpg';
        if (rawContentType.includes('png')) ext = '.png';
        else if (rawContentType.includes('webp')) ext = '.webp';
        else if (rawContentType.includes('gif')) ext = '.gif';
        else if (rawContentType.includes('pdf')) ext = '.pdf';
        else if (rawContentType.includes('mp4')) ext = '.mp4';
        else if (rawContentType.includes('webm')) ext = '.webm';
        else if (rawContentType.includes('quicktime')) ext = '.mov';

        const mockFile: Express.Multer.File = {
          fieldname: 'file',
          originalname: `download-${Date.now()}${ext}`,
          encoding: '7bit',
          mimetype: rawContentType,
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
