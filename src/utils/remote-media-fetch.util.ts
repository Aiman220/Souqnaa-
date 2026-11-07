import dns from 'dns/promises';
import http from 'http';
import https from 'https';
import { isPrivateOrReservedHost } from './url-security.util';
import { AppError } from '../middleware/error.middleware';

type Address = { address: string; family: number };
type RemoteResponse = { statusCode: number; location?: string; contentType?: string; body: Buffer };
type FetchDependencies = {
  lookup?: (hostname: string) => Promise<Address[]>;
  request?: (url: URL, addresses: Address[], maxBytes: number, timeoutMs: number) => Promise<RemoteResponse>;
};

async function resolvePublicAddresses(hostname: string, lookup: FetchDependencies['lookup'] = (host) => dns.lookup(host, { all: true, verbatim: true })): Promise<Address[]> {
  if (isPrivateOrReservedHost(hostname)) throw new AppError('Private or reserved destination blocked.', 403, 'SSRF_BLOCKED');
  let addresses: Address[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new AppError('Unable to resolve remote host.', 400, 'DNS_LOOKUP_FAILED');
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateOrReservedHost(address))) {
    throw new AppError('Private or reserved destination blocked.', 403, 'SSRF_BLOCKED');
  }
  return addresses;
}

function requestPinned(url: URL, addresses: Address[], maxBytes: number, timeoutMs: number): Promise<RemoteResponse> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const transport = secure ? https : http;
    const address = addresses[0];
    const port = url.port ? Number(url.port) : (secure ? 443 : 80);
    const headers: Record<string, string> = {
      'User-Agent': 'SOUQNA-Media-Fetcher/1.0',
      'Accept': 'image/jpeg,image/png,image/webp,image/gif,application/pdf,video/mp4',
      'Host': url.host,
    };
    const request = transport.request({
      protocol: url.protocol,
      hostname: address.address,
      port,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      ...(secure ? { servername: url.hostname } : {}),
    }, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        response.resume();
        resolve({ statusCode, location, body: Buffer.alloc(0) });
        return;
      }
      const contentLength = Number(response.headers['content-length'] || 0);
      if (contentLength > maxBytes) {
        response.destroy();
        reject(new AppError('Remote file exceeds the maximum allowed size.', 400, 'FILE_TOO_LARGE'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > maxBytes) {
          response.destroy(new AppError('Remote file exceeds the maximum allowed size.', 400, 'FILE_TOO_LARGE'));
          return;
        }
        chunks.push(bytes);
      });
      response.on('end', () => resolve({
        statusCode,
        contentType: String(response.headers['content-type'] || '').toLowerCase().split(';')[0].trim(),
        body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Remote request timed out')));
    request.on('error', reject);
    request.end();
  });
}

/** Fetch public media with per-hop DNS validation, pinned IPs, bounded redirects and streaming limits. */
export async function fetchPublicMedia(
  rawUrl: string,
  maxBytes: number,
  timeoutMs = 10000,
  dependencies: FetchDependencies = {}
): Promise<RemoteResponse> {
  let target: URL;
  try { target = new URL(rawUrl); } catch { throw new AppError('Invalid URL.', 400, 'INVALID_URL'); }
  for (let redirects = 0; ; redirects++) {
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) {
      throw new AppError('Only credential-free HTTP/HTTPS URLs are supported.', 400, 'INVALID_URL');
    }
    const addresses = await resolvePublicAddresses(target.hostname, dependencies.lookup);
    const response = await (dependencies.request || requestPinned)(target, addresses, maxBytes, timeoutMs);
    if (response.body.length > maxBytes) throw new AppError('Remote file exceeds the maximum allowed size.', 400, 'FILE_TOO_LARGE');
    if (![301, 302, 303, 307, 308].includes(response.statusCode)) {
      if (response.statusCode < 200 || response.statusCode >= 300) throw new AppError('Remote file request failed.', 400, 'FETCH_FAILED');
      return response;
    }
    if (!response.location || redirects >= 3) throw new AppError('Too many or invalid redirects.', 400, 'REDIRECT_LIMIT');
    try { target = new URL(response.location, target); } catch { throw new AppError('Invalid redirect target.', 400, 'INVALID_URL'); }
  }
}
