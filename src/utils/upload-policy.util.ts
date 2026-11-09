import { AppError } from '../middleware/error.middleware';

export function validatePresignFileSize(fileSize: unknown, maxSize: number): number {
  if (typeof fileSize !== 'number' || !Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new AppError('A positive integer file size is required.', 400, 'INVALID_FILE_SIZE');
  }
  if (fileSize > maxSize) throw new AppError('File exceeds the folder size limit.', 400, 'FILE_TOO_LARGE');
  return fileSize;
}

const ADMIN_ONLY_UPLOAD_FOLDERS = new Set(['branding', 'categories', 'banners', 'campaign-badges']);
const SELLER_UPLOAD_FOLDERS = new Set(['products', 'stores', 'seller-promotions', 'seller-verification', 'seller-banners']);

export function assertUploadFolderRole(userRole: unknown, folder: string): void {
  if (userRole === 'ADMIN' || userRole === 'SUPER_ADMIN') return;

  if (ADMIN_ONLY_UPLOAD_FOLDERS.has(folder)) {
    throw new AppError('You are not allowed to upload to this folder.', 403, 'FORBIDDEN_FOLDER');
  }

  if (SELLER_UPLOAD_FOLDERS.has(folder) && userRole !== 'SELLER') {
    throw new AppError('Seller or administrator access is required for this upload folder.', 403, 'FORBIDDEN_FOLDER');
  }
}
