import { URL } from 'url';
import { isIP } from 'net';

function ipv4Number(raw: string): number | null {
  if (isIP(raw) !== 4) return null;
  return raw.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function ipv4InRange(ip: string, network: string, bits: number): boolean {
  const address = ipv4Number(ip);
  const base = ipv4Number(network);
  if (address === null || base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

/** Reject non-public IPv4 and IPv6 destinations, including mapped IPv4 addresses. */
export function isPrivateOrReservedHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host === 'localhost.localdomain' ||
      ['.localhost', '.local', '.internal', '.corp', '.home', '.lan'].some((suffix) => host.endsWith(suffix))) return true;
  if (isIP(host) === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([network, bits]) => ipv4InRange(host, network as string, bits as number));
  }
  if (isIP(host) === 6) {
    if (host === '::' || host === '::1' || host.startsWith('::ffff:') ||
        host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host) ||
        host.startsWith('ff') || host.startsWith('2002:') || host.startsWith('2001:db8:')) return true;
    return !/^[23]/.test(host);
  }
  return false;
}

/**
 * IP and Host patterns reserved for internal/private networks or cloud metadata.
 */
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
      if (parsed.username || parsed.password) return false;

      const hostname = parsed.hostname.toLowerCase();
      return !isPrivateOrReservedHost(hostname);
    } catch {
      return false;
    }
  }
}

