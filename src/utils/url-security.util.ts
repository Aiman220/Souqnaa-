import { URL } from 'url';

/**
 * IP and Host patterns reserved for internal/private networks or cloud metadata.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // AWS/GCP/Azure/OpenStack metadata IP
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd00:/i,
];

export class UrlSecurityUtil {
  /**
   * Validates whether a given URL is safe from SSRF and local network access.
   */
  public static isSafeUrl(rawUrl: string): boolean {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    const trimmed = rawUrl.trim();

    // Allow relative paths for storage service (e.g. /api/v1/storage/...)
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      return true;
    }

    try {
      const parsed = new URL(trimmed);

      // Only allow http and https protocols
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }

      const hostname = parsed.hostname.toLowerCase();

      for (const pattern of BLOCKED_HOST_PATTERNS) {
        if (pattern.test(hostname)) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }
}

