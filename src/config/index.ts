
const googleOAuth = {
  clientId: '',
  clientSecret: '',
  androidClientId: '',
  androidCustomerClientId: '',
  androidSellerClientId: '',
  iosClientId: '',
  iosCustomerClientId: '',
  iosSellerClientId: '',
  serverClientId: '',
};
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Validates and retrieves mandatory cryptographic secrets from environment variables.
 * Fails safely without printing secret values to logs or console.
 */
export function resolveMandatoryJwtSecret(envVarName: string, minLength = 32): string {
  const secret = process.env[envVarName]?.trim();
  if (!secret) {
    throw new Error(`[Configuration Error] Mandatory secret ${envVarName} is not set in environment.`);
  }
  const disallowedInsecureDefaults = [
    'souqna_super_jwt_secret_2026',
    'souqna_super_refresh_secret_2026',
    'your_jwt_secret_min_32_characters_here',
    'your_jwt_refresh_secret_min_32_characters_here',
    'change_me',
  ];
  if (disallowedInsecureDefaults.includes(secret)) {
    throw new Error(`[Configuration Error] Secret ${envVarName} contains an insecure default placeholder.`);
  }
  if (secret.length < minLength) {
    throw new Error(`[Configuration Error] Secret ${envVarName} must be at least ${minLength} characters for cryptographic security.`);
  }
  return secret;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  apiPrefix: process.env.API_PREFIX || '/api/v1',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  domains: {
    backendPublicUrl:
      process.env.BACKEND_PUBLIC_URL ||
      process.env.API_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      (process.env.NODE_ENV === 'production'
        ? 'https://api.souqnaa.com'
        : 'https://dev-api.souqnaa.com'),
    apiBaseUrl:
      process.env.API_BASE_URL ||
      (process.env.RENDER_EXTERNAL_URL
        ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '')}${process.env.API_PREFIX || '/api/v1'}`
        : process.env.NODE_ENV === 'production'
          ? 'https://api.souqnaa.com/api/v1'
          : 'https://dev-api.souqnaa.com/api/v1'),
    webBaseUrl:
      process.env.WEB_BASE_URL ||
      (process.env.NODE_ENV === 'production'
        ? 'https://www.souqnaa.com'
        : 'https://dev.souqnaa.com'),
    adminBaseUrl:
      process.env.ADMIN_BASE_URL ||
      (process.env.NODE_ENV === 'production'
        ? 'https://admin.souqnaa.com'
        : 'https://dev-admin.souqnaa.com'),
    sellerBaseUrl:
      process.env.SELLER_BASE_URL ||
      (process.env.NODE_ENV === 'production'
        ? 'https://seller.souqnaa.com'
        : 'https://dev-seller.souqnaa.com'),

    // Explicit subdomain registries
    production: {
      api: 'https://api.souqnaa.com',
      web: 'https://www.souqnaa.com',
      admin: 'https://admin.souqnaa.com',
      seller: 'https://seller.souqnaa.com',
      assets: 'https://assets.souqnaa.com',
    },
    development: {
      api: 'https://dev-api.souqnaa.com',
      web: 'https://dev.souqnaa.com',
      admin: 'https://dev-admin.souqnaa.com',
      seller: 'https://dev-seller.souqnaa.com',
      assets: 'https://dev-assets.souqnaa.com',
    },
    staging: {
      api: 'https://staging-api.souqnaa.com',
      web: 'https://staging.souqnaa.com',
      admin: 'https://staging-admin.souqnaa.com',
      seller: 'https://staging-seller.souqnaa.com',
      assets: 'https://staging-assets.souqnaa.com',
    },
  },

  cloudflare: {
    enabled: process.env.CLOUDFLARE_PROTECTION_ENABLED === 'true' || process.env.NODE_ENV === 'production',
    hstsEnabled: process.env.CLOUDFLARE_HSTS_ENABLED === 'true' || process.env.NODE_ENV === 'production',
  },

  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/souqna_db?schema=public',
  },

  redis: {
    url: process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || undefined,
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || process.env.REDIS_TOKEN || process.env.UPSTASH_REDIS_TOKEN || undefined,
    tls: process.env.REDIS_TLS === 'true' ||
      ((process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || '').startsWith('rediss://')) ||
      ((process.env.REDIS_HOST || '').includes('upstash.io')),
    keyPrefix: process.env.REDIS_KEY_PREFIX || `souqna:${process.env.NODE_ENV || 'development'}:`,
  },

  jwt: {
    get secret(): string {
      return resolveMandatoryJwtSecret('JWT_SECRET');
    },
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
    get refreshSecret(): string {
      return resolveMandatoryJwtSecret('JWT_REFRESH_SECRET');
    },
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '90d',
  },

  oauth: {
    google: ((): typeof googleOAuth => {
      const webClientId = process.env.GOOGLE_CLIENT_ID_WEB || process.env.GOOGLE_CLIENT_ID || '';
      // Safety guard: reject placeholder values that would silently accept fake tokens
      const isPlaceholder = webClientId.includes('iuuiofake') || webClientId.startsWith('REPLACE_') || webClientId.startsWith('your-') || webClientId.includes('example');
      if (isPlaceholder) {
        console.error('[Config] [CRITICAL] GOOGLE_CLIENT_ID_WEB contains a placeholder value. Google Sign-In will not work until a real Web OAuth client ID from Google Cloud Console is set in environment variables.');
      } else if (!webClientId && process.env.NODE_ENV === 'production') {
        console.error('[Config] [CRITICAL] GOOGLE_CLIENT_ID_WEB is not set. Native Google Sign-In token verification will not validate the audience in production.');
      }
      const resolvedClientId = isPlaceholder ? '' : webClientId;
      return {
        clientId: resolvedClientId,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
        androidClientId: process.env.GOOGLE_ANDROID_CLIENT_ID || process.env.GOOGLE_CLIENT_ID_ANDROID || '',
        androidCustomerClientId: process.env.GOOGLE_CLIENT_ID_ANDROID_CUSTOMER || '',
        androidSellerClientId: process.env.GOOGLE_CLIENT_ID_ANDROID_SELLER || '',
        iosClientId: process.env.GOOGLE_IOS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID_IOS || '',
        iosCustomerClientId: process.env.GOOGLE_CLIENT_ID_IOS_CUSTOMER || '',
        iosSellerClientId: process.env.GOOGLE_CLIENT_ID_IOS_SELLER || '',
        serverClientId: process.env.GOOGLE_SERVER_CLIENT_ID || '',
      };
    })(),
    facebook: {
      appId: process.env.FACEBOOK_APP_ID || '',
      appSecret: process.env.FACEBOOK_APP_SECRET || '',
      clientToken: process.env.FACEBOOK_CLIENT_TOKEN || '',
    },
  },

  storage: {
    provider: (process.env.STORAGE_PROVIDER || 's3') as 'local' | 's3',
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    s3: {
      endpoint: process.env.S3_ENDPOINT || process.env.AWS_S3_ENDPOINT || 'https://49cfa6aa0b990dada1989f72df796a7f.eu.r2.cloudflarestorage.com',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '',
      region: process.env.AWS_REGION || 'auto',
      bucket: process.env.AWS_S3_BUCKET || process.env.R2_BUCKET || 'sogana',
      publicUrl: process.env.S3_PUBLIC_URL || process.env.R2_PUBLIC_URL || 'https://49cfa6aa0b990dada1989f72df796a7f.eu.r2.cloudflarestorage.com/sogana',
    },
  },

  marketplace: {
    currency: process.env.DEFAULT_CURRENCY || 'YER',
    currencySymbol: process.env.DEFAULT_CURRENCY_SYMBOL || '﷼',
    currencyPrecision: parseInt(process.env.DEFAULT_CURRENCY_PRECISION || '2', 10),
    country: process.env.DEFAULT_COUNTRY || 'YE',
    taxJurisdiction: process.env.DEFAULT_TAX_JURISDICTION || 'YEMEN_GENERAL',
    timezone: process.env.DEFAULT_TIMEZONE || 'Asia/Aden',
    baseDeliveryFee: parseFloat(process.env.BASE_DELIVERY_FEE || '400'),
    freeDeliveryThreshold: parseFloat(process.env.FREE_DELIVERY_THRESHOLD || '10000'),
    defaultCommissionRate: parseFloat(process.env.DEFAULT_COMMISSION_RATE || '0.10'),
    maxDeliveryRadiusKm: parseFloat(process.env.MAX_DELIVERY_RADIUS_KM || '50'),
    expressFeeFixed: parseFloat(process.env.EXPRESS_FEE_FIXED || '500'),
    multiVendorPolicy: (process.env.MULTI_VENDOR_POLICY || 'PER_SELLER') as
      'PER_SELLER' | 'MAXIMUM_FEE' | 'COMBINED' | 'FREE_ABOVE_ORDER_VALUE',
  },

  geo: {
    geocodingProvider: process.env.GEOCODING_PROVIDER || 'geoapify',
    routingProvider: process.env.ROUTING_PROVIDER || 'geoapify',
    // Never hardcode or log this key. Derived strictly from environment variables.
    geoapifyApiKey: process.env.GEOAPIFY_API_KEY || process.env.GEOAPIF_API_KEY || '',
    // Tile URL template returned to Flutter for rendering — defaults to open OSM when no key is set
    geoapifyTileUrl: process.env.GEOAPIFY_TILE_URL ||
      process.env.GEOAPIF_TILE_URL ||
      (process.env.GEOAPIFY_API_KEY || process.env.GEOAPIF_API_KEY
        ? `https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}.png?apiKey=${process.env.GEOAPIFY_API_KEY || process.env.GEOAPIF_API_KEY}`
        : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
  },

  rateLimits: {
    chatMessagesPerMinute: parseInt(process.env.CHAT_RATE_LIMIT_MESSAGES_PER_MIN || '60', 10),
    conversationsPerHour: parseInt(process.env.CHAT_RATE_LIMIT_CONVERSATIONS_PER_HOUR || '30', 10),
    uploadsPerHour: parseInt(process.env.CHAT_RATE_LIMIT_UPLOADS_PER_HOUR || '50', 10),
    reportsPerHour: parseInt(process.env.CHAT_RATE_LIMIT_REPORTS_PER_HOUR || '15', 10),
  },

  appVersion: {
    enforcementMode: (process.env.APP_VERSION_ENFORCEMENT_MODE || 'enforcing') as
      'enforcing' | 'observe_only' | 'disabled',
    allowLegacyWithoutVersion: process.env.ALLOW_LEGACY_WITHOUT_VERSION !== 'false',
  },

  appIntegrity: {
    enabled: process.env.APP_INTEGRITY_ENABLED === 'true',
    enforcementMode: (process.env.APP_INTEGRITY_ENFORCEMENT_MODE || 'observe_only') as
      'enforcing' | 'observe_only' | 'disabled',
    challengeTtlSeconds: parseInt(process.env.APP_INTEGRITY_CHALLENGE_TTL || '300', 10),
    googlePlay: {
      enabled: process.env.PLAY_INTEGRITY_ENABLED === 'true',
      packageNames: (process.env.PLAY_INTEGRITY_PACKAGES || 'com.souqnaa.app,com.souqnaa.seller,com.souqnaa.admin').split(','),
      cloudProjectNumber: process.env.PLAY_INTEGRITY_PROJECT_NUMBER || '',
    },
    appleAppAttest: {
      enabled: process.env.APP_ATTEST_ENABLED === 'true',
      appIds: (process.env.APP_ATTEST_APP_IDS || 'com.souqnaa.app,com.souqnaa.seller,com.souqnaa.admin').split(','),
      production: process.env.APP_ATTEST_ENVIRONMENT === 'production',
    },
  },
};
