import { AppError } from '../middleware/error.middleware';

export function validatePresignFileSize(fileSize: unknown, maxSize: number): number {
  if (typeof fileSize !== 'number' || !Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new AppError('A positive integer file size is required.', 400, 'INVALID_FILE_SIZE');
  }
  if (fileSize > maxSize) throw new AppError('File exceeds the folder size limit.', 400, 'FILE_TOO_LARGE');
  return fileSize;
}
