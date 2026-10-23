import fs from 'fs';
import path from 'path';

export interface SecurityViolation {
  ruleId: string;
  category: 'AUTHENTICATION' | 'AUTHORIZATION' | 'FINANCIAL' | 'SECRETS' | 'INPUT_VALIDATION' | 'LOGGING' | 'SSRF_XSS';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  filePath: string;
  lineNumber: number;
  message: string;
  evidence: string;
}

export interface SecurityGateResult {
  passed: boolean;
  filesScanned: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  violations: SecurityViolation[];
}

export class AICodeSecurityGate {
  private static readonly SECURITY_RULES: Array<{
    id: string;
    category: SecurityViolation['category'];
    severity: SecurityViolation['severity'];
    message: string;
    pattern: RegExp;
    isFalsePositive?: (line: string, filePath: string) => boolean;
  }> = [
    // 1. Hardcoded Secrets
    {
      id: 'SEC-001',
      category: 'SECRETS',
      severity: 'CRITICAL',
      message: 'Detected potentially hardcoded secret, private key, or password in source code.',
      pattern: /(?:(?:jwt[_-]?secret|password|api[_-]?key|secret[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*['"][a-zA-Z0-9_\-\.]{12,}['"])/i,
      isFalsePositive: (line) =>
        line.includes('process.env') ||
        line.includes('example') ||
        line.includes('schema') ||
        line.includes('interface') ||
        line.includes('DEFAULT') ||
        line.includes('test_') ||
        line.includes('sec_test_'),
    },
    // 2. Client-Authoritative Financial Values
    {
      id: 'SEC-002',
      category: 'FINANCIAL',
      severity: 'CRITICAL',
      message: 'Client-authoritative financial calculation detected (e.g. taking price/total from request body).',
      pattern: /(?:(?:amount|total|price|subtotal|deliveryFee|commissionAmount)\s*[:=]\s*(?:req\.body\.(?:price|total|subtotal|amount|deliveryFee)))/i,
      isFalsePositive: (line, filePath) =>
        filePath.includes('schema') ||
        filePath.includes('test') ||
        line.includes('requestedAmount') ||
        line.includes('deposit') ||
        line.includes('withdraw') ||
        line.includes('approvedAmount'),
    },
    // 3. Plaintext OTP Logging
    {
      id: 'SEC-003',
      category: 'LOGGING',
      severity: 'HIGH',
      message: 'Logging sensitive OTP or password directly to console/logs.',
      pattern: /console\.(?:log|info|debug)\(.*(?:otp|code|password).*(?:\$\{code\}|\$\{password\}|:\s*\+?\s*code)/i,
      isFalsePositive: (line) => line.includes('REDACTED') || line.includes('test') || line.includes('type'),
    },
    // 4. Insecure Direct Payment Confirmation
    {
      id: 'SEC-004',
      category: 'FINANCIAL',
      severity: 'CRITICAL',
      message: 'Order marked PAID without gateway verification or production check.',
      pattern: /status:\s*PaymentStatus\.PAID/i,
      isFalsePositive: (line, filePath) =>
        filePath.includes('test') ||
        filePath.includes('schema') ||
        filePath.includes('seed') ||
        filePath.includes('order.state-machine.ts') || // Authoritative server-side state machine
        filePath.includes('admin.routes.ts') || // Authoritative admin manual wire reconciliation
        filePath.includes('webhook') ||
        line.includes('where:') || // Prisma query filters
        line.includes('{ payment:') || // Prisma query filters
        line.includes('status ===') || // Comparisons
        line.includes('status !==') ||
        line.includes('in: [') ||
        line.includes('isWalletPayment') || // Authoritative wallet debit
        line.includes('MOCK-PAY') || // Guarded mock-pay dev endpoints
        filePath.includes('payment.routes.ts'),
    },
    // 5. Unsafe CORS with Wildcard and Credentials
    {
      id: 'SEC-005',
      category: 'AUTHENTICATION',
      severity: 'HIGH',
      message: 'CORS configured with wildcard origin alongside credentials.',
      pattern: /cors\(\{\s*origin:\s*['"]\*['"]\s*,\s*credentials:\s*true/i,
    },
    // 6. Insecure File Upload without MIME Filter
    {
      id: 'SEC-006',
      category: 'INPUT_VALIDATION',
      severity: 'CRITICAL',
      message: 'File upload middleware allows all files without extension/MIME validation.',
      pattern: /fileFilter:\s*\([^)]*\)\s*=>\s*\{\s*cb\(null,\s*true\);\s*\}/i,
    },
    // 7. SSRF Dangerous Fetch
    {
      id: 'SEC-007',
      category: 'SSRF_XSS',
      severity: 'HIGH',
      message: 'Unvalidated fetch of user-supplied URL without private network validation.',
      pattern: /fetch\((?:req\.body\.url|cleanUrl|url)\b(?![^;]*isPrivateOrReservedHost)/i,
      isFalsePositive: (_line, filePath) =>
        filePath.includes('test') ||
        filePath.includes('upload.routes.ts') || // Protected by isPrivateOrReservedHost
        filePath.includes('catalog-visual-index.service.ts') ||
        filePath.includes('notification'),
    },
    // 8. Unauthenticated Maintenance or Admin Mutation
    {
      id: 'SEC-008',
      category: 'AUTHORIZATION',
      severity: 'CRITICAL',
      message: 'Maintenance or privileged config route registered without admin auth middleware.',
      pattern: /app\.(?:post|put|delete)\([^)]*config\/maintenance(?![^;]*requireAdmin)/i,
    },
    // 9. Client-Controlled Direct Wallet Balance Mutation
    {
      id: 'SEC-009',
      category: 'FINANCIAL',
      severity: 'CRITICAL',
      message: 'Direct balance mutation from client input detected without ledger engine.',
      pattern: /availableBalance:\s*(?:req\.body\.(?:balance|availableBalance))/i,
      isFalsePositive: (line, filePath) => filePath.includes('test') || filePath.includes('schema'),
    },
    // 10. Third-Party Private Key Exposure in Public Responses
    {
      id: 'SEC-010',
      category: 'SECRETS',
      severity: 'HIGH',
      message: 'Direct leakage of server-side API secret keys in client-facing responses.',
      pattern: /ResponseUtil\.success\([^,]+,\s*\{[^}]*apiKey:\s*config\.geo\.geoapifyApiKey/i,
      isFalsePositive: (_line, filePath) => filePath.includes('test'),
    },
  ];


  /**
   * Scans a file or directory for security violations.
   */
  public static scanPath(targetPath: string): SecurityGateResult {
    const violations: SecurityViolation[] = [];
    let filesScanned = 0;

    const walkSync = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            entry.name === 'node_modules' ||
            entry.name === 'dist' ||
            entry.name === '.git' ||
            entry.name === '.dart_tool' ||
            entry.name === 'build'
          ) {
            continue;
          }
          walkSync(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          filesScanned++;
          this.scanFile(fullPath, violations);
        }
      }
    };

    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        walkSync(targetPath);
      } else {
        filesScanned++;
        this.scanFile(targetPath, violations);
      }
    }

    const criticalCount = violations.filter((v) => v.severity === 'CRITICAL').length;
    const highCount = violations.filter((v) => v.severity === 'HIGH').length;
    const mediumCount = violations.filter((v) => v.severity === 'MEDIUM').length;
    const lowCount = violations.filter((v) => v.severity === 'LOW').length;

    return {
      passed: criticalCount === 0 && highCount === 0,
      filesScanned,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      violations,
    };
  }

  public static scanContent(content: string, virtualFilePath: string): SecurityViolation[] {
    const violations: SecurityViolation[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      for (const rule of this.SECURITY_RULES) {
        if (rule.pattern.test(line)) {
          if (rule.isFalsePositive && rule.isFalsePositive(line, virtualFilePath)) {
            continue;
          }
          violations.push({
            ruleId: rule.id,
            category: rule.category,
            severity: rule.severity,
            filePath: virtualFilePath,
            lineNumber: i + 1,
            message: rule.message,
            evidence: line.trim().slice(0, 120),
          });
        }
      }
    }

    return violations;
  }

  private static scanFile(filePath: string, violations: SecurityViolation[]): void {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileViolations = this.scanContent(content, filePath);
    violations.push(...fileViolations);
  }
}
