import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import { storageService } from '../../services/storage/storage.service';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { uploadFileLimiter, uploadByUrlLimiter } from '../../middleware/rate-limiter.middleware';
import { ImageProcessorService } from '../../services/storage/image-processor.service';
import { fetchPublicMedia } from '../../utils/remote-media-fetch.util';
import { validatePresignFileSize } from '../../utils/upload-policy.util';

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
  'banners',
  'campaigns',
  'campaign-badges',
  'branding',
  'seller-promotions',
  'seller-verification',
  'refund-evidence',
  'review-images',
  'review-videos',
  'proofs',
  'finance_proofs',
  'customer-deposits',
  'videos',
]);

const FOLDER_ALIASES: Record<string, string> = {
  'banners': 'banners',
  'campaigns': 'campaigns',
  'seller-promotions': 'promotions',
  'seller-verification': 'documents',
  'refund-evidence': 'refunds',
  'review-images': 'reviews',
  'review-videos': 'reviews',
  'proofs': 'disputes',
  'finance_proofs': 'documents',
  'customer-deposits': 'documents',
  'videos': 'products',
};

/** Folder specific file-size limits (§7) */
const FOLDER_MAX_SIZES: Record<string, number> = {
  avatars: 5 * 1024 * 1024,
  stores: 5 * 1024 * 1024,
  categories: 5 * 1024 * 1024,
  'campaign-badges': 5 * 1024 * 1024,
  branding: 5 * 1024 * 1024,
  products: 15 * 1024 * 1024,
  promotions: 15 * 1024 * 1024,
  banners: 15 * 1024 * 1024,
  campaigns: 15 * 1024 * 1024,
  general: 15 * 1024 * 1024,
  reviews: 25 * 1024 * 1024,
  chat: 50 * 1024 * 1024,
  support: 50 * 1024 * 1024,
  refunds: 25 * 1024 * 1024,
  disputes: 25 * 1024 * 1024,
  documents: 25 * 1024 * 1024,
  reports: 25 * 1024 * 1024,
  'seller-promotions': 15 * 1024 * 1024,
  'seller-verification': 25 * 1024 * 1024,
  'refund-evidence': 25 * 1024 * 1024,
  'review-images': 15 * 1024 * 1024,
  'review-videos': 50 * 1024 * 1024,
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
  if (FOLDER_ALIASES[cleaned]) return FOLDER_ALIASES[cleaned];
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

export const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.ps1',
  '.vbs',
  '.js',
  '.mjs',
  '.jar',
  '.scr',
  '.pif',
  '.com',
  '.hta',
  '.cpl',
  '.msi',
  '.php',
  '.asp',
  '.aspx',
  '.py',
  '.elf',
  '.bin',
  '.html',
  '.htm',
  '.xml',
  '.xhtml',
  '.svg',
]);

export const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();

    // 1. Guard against dangerous executable and script files
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return cb(
        new AppError(
          'نوع الملف غير مدعوم لأسباب أمنية. الملفات التنفيذية والبرمجية محظورة.',
          400,
          'UNSUPPORTED_FILE_TYPE'
        )
      );
    }

    if (
      mime.includes('html') ||
      mime.includes('javascript') ||
      mime.includes('xml') ||
      mime.includes('svg')
    ) {
      return cb(
        new AppError('صيغة الملف غير آمنة للرفع.', 400, 'UNSUPPORTED_FILE_TYPE')
      );
    }

    // 2. Allow mobile binary requests where mime is generic application/octet-stream
    // but extension or magic bytes are valid.
    if (!mime || mime === 'application/octet-stream') {
      if (ext && ALLOWED_EXTENSIONS.has(ext)) {
        file.mimetype = EXT_TO_MIME[ext] || 'image/jpeg';
        return cb(null, true);
      }
      if (!ext) {
        // Let it pass to ImageProcessorService.detectMimeFromBuffer
        return cb(null, true);
      }
    }

    if (
      !ALLOWED_EXTENSIONS.has(ext) &&
      !ALLOWED_MIME_TYPES.has(mime) &&
      !mime.startsWith('image/') &&
      !mime.startsWith('video/')
    ) {
      return cb(
        new AppError(
          'نوع الملف غير مدعوم لأسباب أمنية. يسمح فقط بالصور ومقاطع الفيديو ومستندات PDF.',
          400,
          'UNSUPPORTED_FILE_TYPE'
        )
      );
    }
    cb(null, true);
  },
});

export { isPrivateOrReservedHost } from '../../utils/url-security.util';

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

    try {
      const maxSize = FOLDER_MAX_SIZES[folder] || 10 * 1024 * 1024;
      const response = await fetchPublicMedia(cleanUrl, maxSize, 10000);
      const rawContentType = response.contentType || '';

      if (!ALLOWED_MIME_TYPES.has(rawContentType)) {
        throw new AppError('نوع محتوى الملف المسترد غير مدعوم أو غير آمن.', 400, 'UNSUPPORTED_MEDIA_TYPE');
      }

      const buffer = response.body;

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
    } catch (fetchErr: any) {
      if (fetchErr instanceof AppError) throw fetchErr;
      console.warn('[Upload by URL] Direct download failed:', fetchErr?.message);
    }

    throw new AppError('تعذر تحميل الملف من الرابط المحدد. يرجى التحقق من الرابط وصيغة الملف.', 400, 'FETCH_FAILED');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/upload/presign
router.post('/presign', uploadFileLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawFolder = req.body.folder;
    const folder = sanitizeFolder(rawFolder);
    const filename = String(req.body.filename || req.body.name || `file_${Date.now()}`);
    let mimeType = String(req.body.mimeType || req.body.contentType || '').toLowerCase().trim();
    const fileSize = req.body.fileSize;

    // Authorization checks:
    const userRole = (req as any).user?.role;
    if (['branding', 'categories', 'banners', 'campaign-badges'].includes(folder)) {
      if (userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN') {
        throw new AppError('غير مصرح لك بالرفع إلى هذا المجلد المحدد.', 403, 'FORBIDDEN_FOLDER');
      }
    }
    if (['products', 'stores', 'seller-promotions', 'seller-verification'].includes(folder)) {
      if (userRole !== 'SELLER' && userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN') {
        throw new AppError('غير مصرح لك برفع وسائط التجار والمنتجات.', 403, 'FORBIDDEN_FOLDER');
      }
    }

    const ext = path.extname(filename).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      throw new AppError('نوع الملف المرفوع محظور لأسباب أمنية.', 400, 'UNSUPPORTED_FILE_TYPE');
    }

    if (!mimeType || mimeType === 'application/octet-stream') {
      mimeType = EXT_TO_MIME[ext] || 'image/jpeg';
    }

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new AppError('صيغة الملف غير مدعومة.', 400, 'UNSUPPORTED_MEDIA_TYPE');
    }

    const maxSize = FOLDER_MAX_SIZES[folder] || 15 * 1024 * 1024;
    validatePresignFileSize(fileSize, maxSize);

    const presigned = await storageService.createPresignedUploadUrl(
      folder,
      filename,
      mimeType,
      fileSize
    );

    ResponseUtil.success(res, presigned, 'تم إنشاء رابط الرفع المباشر بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/upload/verify
router.post('/verify', uploadFileLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = req.body.key;
    if (!key || typeof key !== 'string') {
      throw new AppError('مفتاح الملف مطلوب للتحقق', 400, 'MISSING_KEY');
    }

    const expectedFolder = req.body.folder ? sanitizeFolder(req.body.folder) : undefined;
    const result = await storageService.verifyUploadedObject(key, expectedFolder);

    ResponseUtil.success(res, result, 'تم التحقق من الملف المرفوع بنجاح');
  } catch (error: any) {
    if (error instanceof AppError) return next(error);
    console.warn('[Upload Verify] Verification failed for key:', req.body.key, error?.message);
    next(new AppError('فشل التحقق من الملف في وحدة التخزين السحابية.', 400, 'VERIFICATION_FAILED'));
  }
});

export const uploadRoutes = router;
