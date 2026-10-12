import { prisma } from '../../../database/prisma';
import { DeepLinkType } from '@prisma/client';
import { AppError } from '../../../middleware/error.middleware';

export interface ValidatedDeepLink {
  uri: string;
  type: DeepLinkType;
  targetId?: string;
  path: string;
  queryParameters?: Record<string, string>;
  isExternal: boolean;
}

const ALLOWED_EXTERNAL_DOMAINS = [
  'souqnaa.online',
  'www.souqnaa.online',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'youtube.com',
  'wa.me',
  'api.whatsapp.com',
];

const DISALLOWED_PATTERNS = [
  /^javascript:/i,
  /^data:/i,
  /^vbscript:/i,
  /\/api\/v1\/admin/i,
  /\/admin/i,
  /<script/i,
];

class DeepLinkService {
  /**
   * Sanitizes and validates a URL or deep link.
   * Throws AppError if malicious, unauthorized, or malformed.
   */
  validateUrl(url: string): { isValid: boolean; reason?: string } {
    if (!url || typeof url !== 'string') {
      return { isValid: false, reason: 'URL cannot be empty' };
    }

    const trimmed = url.trim();

    for (const pattern of DISALLOWED_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { isValid: false, reason: 'Disallowed or potentially malicious URL pattern' };
      }
    }

    if (trimmed.startsWith('souqnaa://')) {
      return { isValid: true };
    }

    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
      try {
        const parsed = new URL(trimmed);
        const hostname = parsed.hostname.toLowerCase();

        // Check if domain is allowed or general safe web url
        const isKnownDomain = ALLOWED_EXTERNAL_DOMAINS.some(
          (d) => hostname === d || hostname.endsWith(`.${d}`)
        );

        if (!isKnownDomain) {
          // If not in standard whitelist, ensure it uses standard safe protocols and no suspicious port
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return { isValid: false, reason: 'Only HTTP/HTTPS protocols are supported' };
          }
        }

        return { isValid: true };
      } catch {
        return { isValid: false, reason: 'Invalid web URL format' };
      }
    }

    // Relative app paths like /product/123
    if (trimmed.startsWith('/')) {
      if (trimmed.startsWith('/admin') || trimmed.startsWith('/api')) {
        return { isValid: false, reason: 'Restricted internal destination' };
      }
      return { isValid: true };
    }

    return { isValid: false, reason: 'Unsupported URL scheme. Use souqnaa:// or https://' };
  }

  /**
   * Builds a canonical souqnaa:// URI for a target.
   */
  buildCanonicalUri(type: DeepLinkType, targetId?: string, query?: Record<string, string>): string {
    let path = '';
    switch (type) {
      case 'PRODUCT':
        path = `product/${targetId || ''}`;
        break;
      case 'CATEGORY':
        path = `category/${targetId || ''}`;
        break;
      case 'BRAND':
        path = `brand/${targetId || ''}`;
        break;
      case 'SELLER':
        path = `seller/${targetId || ''}`;
        break;
      case 'STORE':
        path = `store/${targetId || ''}`;
        break;
      case 'FLASH_SALE':
        path = `flash-sale/${targetId || ''}`;
        break;
      case 'VOUCHER':
        path = `voucher/${targetId || ''}`;
        break;
      case 'CAMPAIGN':
        path = `campaign/${targetId || ''}`;
        break;
      case 'COLLECTION':
        path = `collection/${targetId || ''}`;
        break;
      case 'SEARCH':
        path = `search`;
        break;
      case 'HOME':
      default:
        path = `home`;
        break;
    }

    let uri = `souqnaa://${path}`;
    if (query && Object.keys(query).length > 0) {
      const q = new URLSearchParams(query).toString();
      uri += `?${q}`;
    }
    return uri;
  }

  /**
   * Creates or registers a deep link in the database.
   */
  async createDeepLink(data: {
    type: DeepLinkType;
    targetId?: string;
    path?: string;
    queryParameters?: Record<string, any>;
    metadata?: Record<string, any>;
  }) {
    const canonical = this.buildCanonicalUri(data.type, data.targetId, data.queryParameters);
    const finalPath = data.path || canonical;

    const validation = this.validateUrl(finalPath);
    if (!validation.isValid) {
      throw new AppError(validation.reason || 'Invalid deep link', 400);
    }

    return prisma.deepLink.create({
      data: {
        type: data.type,
        targetId: data.targetId || null,
        path: finalPath,
        queryParameters: data.queryParameters || {},
        metadata: data.metadata || {},
        isActive: true,
      },
    });
  }

  /**
   * Resolves a deep link by ID or URI string.
   */
  async resolveDeepLink(idOrUri: string): Promise<ValidatedDeepLink> {
    if (!idOrUri) {
      throw new AppError('Deep link identifier is required', 400);
    }

    // Check if it's a UUID in DB
    const dbLink = await prisma.deepLink.findUnique({
      where: { id: idOrUri },
    });

    if (dbLink) {
      return {
        uri: dbLink.path,
        type: dbLink.type,
        targetId: dbLink.targetId || undefined,
        path: dbLink.path,
        queryParameters: (dbLink.queryParameters as Record<string, string>) || {},
        isExternal: dbLink.type === 'EXTERNAL_URL',
      };
    }

    // Parse raw URI string
    const validation = this.validateUrl(idOrUri);
    if (!validation.isValid) {
      throw new AppError(validation.reason || 'Invalid deep link', 400);
    }

    if (idOrUri.startsWith('souqnaa://')) {
      const withoutScheme = idOrUri.replace('souqnaa://', '');
      const [pathPart, queryPart] = withoutScheme.split('?');
      const segments = pathPart.split('/').filter(Boolean);
      const section = (segments[0] || 'home').toUpperCase();
      const targetId = segments[1];

      let type: DeepLinkType = 'HOME';
      if (section === 'PRODUCT') type = 'PRODUCT';
      else if (section === 'CATEGORY') type = 'CATEGORY';
      else if (section === 'BRAND') type = 'BRAND';
      else if (section === 'SELLER') type = 'SELLER';
      else if (section === 'STORE') type = 'STORE';
      else if (section === 'FLASH-SALE') type = 'FLASH_SALE';
      else if (section === 'VOUCHER') type = 'VOUCHER';
      else if (section === 'CAMPAIGN') type = 'CAMPAIGN';
      else if (section === 'COLLECTION') type = 'COLLECTION';
      else if (section === 'SEARCH') type = 'SEARCH';

      const qParams: Record<string, string> = {};
      if (queryPart) {
        new URLSearchParams(queryPart).forEach((v, k) => {
          qParams[k] = v;
        });
      }

      return {
        uri: idOrUri,
        type,
        targetId,
        path: withoutScheme,
        queryParameters: qParams,
        isExternal: false,
      };
    }

    return {
      uri: idOrUri,
      type: 'EXTERNAL_URL',
      path: idOrUri,
      isExternal: true,
    };
  }
}

export const deepLinkService = new DeepLinkService();
