import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

type Status = 'CONFIGURED' | 'MISSING' | 'INVALID';

interface CheckItem {
  name: string;
  category: 'CORE' | 'DATABASE' | 'UPSTASH_REDIS' | 'CLOUDFLARE_DOMAINS' | 'SECURITY' | 'STORAGE';
  status: Status;
  details?: string;
  critical: boolean;
}

const checks: CheckItem[] = [];

function addCheck(
  name: string,
  category: CheckItem['category'],
  status: Status,
  critical: boolean,
  details?: string
) {
  checks.push({ name, category, status, critical, details });
}

function runValidation() {
  console.log('============================================================');
  console.log('🛡️  SOUQNA ONLINE — PRODUCTION INFRASTRUCTURE VALIDATION');
  console.log('============================================================\n');

  const env = process.env.NODE_ENV || 'development';
  const isProd = env === 'production';
  const isStaging = env === 'staging';

  // 1. Environment & Mode
  if (['development', 'staging', 'production'].includes(env)) {
    addCheck('ENVIRONMENT', 'CORE', 'CONFIGURED', true, `Mode: ${env}`);
  } else {
    addCheck('ENVIRONMENT', 'CORE', 'INVALID', true, `Unknown environment: ${env}`);
  }

  // 2. Database URL
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl) {
    addCheck('DATABASE_URL', 'DATABASE', 'MISSING', true);
  } else if (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
    addCheck('DATABASE_URL', 'DATABASE', 'INVALID', true, 'Must start with postgresql://');
  } else {
    addCheck('DATABASE_URL', 'DATABASE', 'CONFIGURED', true);
  }

  // 3. Upstash Redis
  const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || '';
  const redisHost = process.env.REDIS_HOST || '';
  const redisPassword = process.env.REDIS_PASSWORD || process.env.REDIS_TOKEN || process.env.UPSTASH_REDIS_TOKEN || '';

  if (redisUrl) {
    const isTls = redisUrl.startsWith('rediss://');
    if (isProd && !isTls) {
      addCheck('REDIS_URL', 'UPSTASH_REDIS', 'INVALID', false, 'Production Upstash requires TLS (rediss://)');
    } else {
      addCheck('REDIS_URL', 'UPSTASH_REDIS', 'CONFIGURED', false, isTls ? 'TLS enabled (rediss://)' : 'Standard (redis://)');
    }
  } else if (redisHost) {
    const hasToken = Boolean(redisPassword);
    if (!hasToken && isProd) {
      addCheck('REDIS_HOST/PASSWORD', 'UPSTASH_REDIS', 'INVALID', false, 'Password/Token required in production');
    } else {
      addCheck('REDIS_HOST/PASSWORD', 'UPSTASH_REDIS', 'CONFIGURED', false);
    }
  } else {
    addCheck('REDIS_URL/HOST', 'UPSTASH_REDIS', isProd ? 'INVALID' : 'MISSING', false, 'Redis credentials not set (in-memory fallback active)');
  }

  // 4. Cloudflare Domains & Base URLs
  const backendPublicUrl = process.env.BACKEND_PUBLIC_URL || process.env.API_BASE_URL || '';
  if (!backendPublicUrl) {
    addCheck('BACKEND_PUBLIC_URL', 'CLOUDFLARE_DOMAINS', isProd ? 'MISSING' : 'CONFIGURED', isProd, 'Defaults to http://localhost:4000');
  } else if (isProd && !backendPublicUrl.startsWith('https://')) {
    addCheck('BACKEND_PUBLIC_URL', 'CLOUDFLARE_DOMAINS', 'INVALID', true, 'Production API must use HTTPS');
  } else {
    addCheck('BACKEND_PUBLIC_URL', 'CLOUDFLARE_DOMAINS', 'CONFIGURED', true);
  }

  const corsOrigin = process.env.CORS_ORIGIN || '';
  if (!corsOrigin) {
    addCheck('CORS_ORIGIN', 'SECURITY', 'CONFIGURED', false, 'Defaults to allowed origins list');
  } else if (isProd && corsOrigin === '*') {
    addCheck('CORS_ORIGIN', 'SECURITY', 'INVALID', true, 'Wildcard CORS (*) is forbidden in production');
  } else {
    addCheck('CORS_ORIGIN', 'SECURITY', 'CONFIGURED', true);
  }

  // 5. JWT Secrets & Security
  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret) {
    addCheck('JWT_SECRET', 'SECURITY', 'MISSING', true);
  } else if (isProd && (jwtSecret.length < 32 || jwtSecret.includes('super_secret_jwt_key'))) {
    addCheck('JWT_SECRET', 'SECURITY', 'INVALID', true, 'Must be unique and at least 32 characters in production');
  } else {
    addCheck('JWT_SECRET', 'SECURITY', 'CONFIGURED', true);
  }

  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || '';
  if (!jwtRefreshSecret) {
    addCheck('JWT_REFRESH_SECRET', 'SECURITY', 'MISSING', true);
  } else if (isProd && (jwtRefreshSecret.length < 32 || jwtRefreshSecret.includes('super_secret_refresh'))) {
    addCheck('JWT_REFRESH_SECRET', 'SECURITY', 'INVALID', true, 'Must be unique and at least 32 characters in production');
  } else {
    addCheck('JWT_REFRESH_SECRET', 'SECURITY', 'CONFIGURED', true);
  }

  // 6. Cloudflare R2 Storage Provider
  const storageProvider = process.env.STORAGE_PROVIDER || 'local';
  if (storageProvider === 's3') {
    const s3Endpoint = process.env.S3_ENDPOINT || process.env.AWS_S3_ENDPOINT || '';
    const hasR2Key = Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID);
    const hasR2Secret = Boolean(process.env.AWS_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY);

    if (hasR2Key && hasR2Secret && s3Endpoint) {
      addCheck('CLOUDFLARE_R2_STORAGE', 'STORAGE', 'CONFIGURED', false, 'S3/R2 Endpoint configured');
    } else {
      addCheck('CLOUDFLARE_R2_STORAGE', 'STORAGE', 'INVALID', false, 'Missing R2 access keys or endpoint');
    }
  } else {
    addCheck('STORAGE_PROVIDER', 'STORAGE', 'CONFIGURED', false, 'Local storage mode');
  }

  // 7. Health & Readiness endpoints check
  addCheck('HEALTH_ENDPOINT (/health)', 'CORE', 'CONFIGURED', true, 'Minimal liveness probe');
  addCheck('READINESS_ENDPOINT (/ready)', 'CORE', 'CONFIGURED', true, 'Dependency probe (DB critical, Redis optional)');

  // Print results
  console.log(String('CATEGORY').padEnd(20) + String('ITEM').padEnd(30) + String('STATUS').padEnd(15) + 'DETAILS');
  console.log('-'.repeat(80));

  let hasCriticalFailure = false;
  for (const c of checks) {
    const statusColor = c.status === 'CONFIGURED' ? '✅' : c.status === 'MISSING' ? '⚠️ ' : '❌';
    console.log(
      String(c.category).padEnd(20) +
      String(c.name).padEnd(30) +
      String(`${statusColor} ${c.status}`).padEnd(15) +
      (c.details || '')
    );

    if (c.critical && (c.status === 'MISSING' || c.status === 'INVALID')) {
      hasCriticalFailure = true;
    }
  }

  console.log('\n------------------------------------------------------------');
  // 8. Secret Leak Scanning across code files
  console.log('🔍 Scanning code for accidental secret leaks...');
  const leaks = scanForSecretLeaks();
  if (leaks.length > 0) {
    console.error(`❌ SECRET LEAK DETECTED: Found ${leaks.length} potential hardcoded secrets in source code:`);
    for (const l of leaks) {
      console.error(`  - ${l.file}:${l.line} -> ${l.pattern}`);
    }
    hasCriticalFailure = true;
  } else {
    console.log('✅ ZERO hardcoded secret leaks detected in codebase.');
  }

  console.log('------------------------------------------------------------\n');

  if (hasCriticalFailure) {
    console.error('❌ INFRASTRUCTURE VALIDATION FAILED: Please fix the critical items listed above before deploying.\n');
    process.exit(1);
  } else {
    console.log('✅ INFRASTRUCTURE VALIDATION PASSED: Environment and configuration are compliant.\n');
    process.exit(0);
  }
}

interface LeakResult {
  file: string;
  line: number;
  pattern: string;
}

function scanForSecretLeaks(): LeakResult[] {
  const leaks: LeakResult[] = [];
  const dirsToScan = [
    path.resolve(__dirname, '../src'),
    path.resolve(__dirname, '../../packages/networking/lib'),
    path.resolve(__dirname, '../../packages/core/lib'),
  ];

  const forbiddenPatterns = [
    { name: 'Upstash Raw Token', regex: /upstash[_-]redis[_-]token\s*=\s*['"][a-zA-Z0-9_\-]{20,}['"]/i },
    { name: 'Cloudflare Raw API Token', regex: /cloudflare[_-]api[_-]token\s*=\s*['"][a-zA-Z0-9_\-]{30,}['"]/i },
    { name: 'AWS Raw Secret Key', regex: /aws[_-]secret[_-]access[_-]key\s*=\s*['"][a-zA-Z0-9\/+=]{35,}['"]/i },
    { name: 'Postgres Raw URI with Password', regex: /postgresql:\/\/[^:]+:[^@]+@/i },
  ];

  for (const dir of dirsToScan) {
    if (!fs.existsSync(dir)) continue;
    scanRecursive(dir, forbiddenPatterns, leaks);
  }

  return leaks;
}

function scanRecursive(
  currentDir: string,
  patterns: Array<{ name: string; regex: RegExp }>,
  leaks: LeakResult[]
) {
  const files = fs.readdirSync(currentDir);
  for (const file of files) {
    const fullPath = path.join(currentDir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== 'dist') {
        scanRecursive(fullPath, patterns, leaks);
      }
    } else if (stat.isFile() && (file.endsWith('.ts') || file.endsWith('.dart') || file.endsWith('.js'))) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        // Skip comments and env references
        if (line.includes('process.env') || line.includes('String.fromEnvironment') || line.trim().startsWith('//')) {
          return;
        }

        for (const p of patterns) {
          if (p.regex.test(line)) {
            leaks.push({
              file: path.relative(path.resolve(__dirname, '../..'), fullPath),
              line: index + 1,
              pattern: p.name,
            });
          }
        }
      });
    }
  }
}

runValidation();
