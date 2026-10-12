import path from 'path';
import { AICodeSecurityGate } from '../src/services/security/ai-code-security-gate.service';

function main() {
  console.log('============================================================');
  console.log('🛡️  SOUQNA — AI-CODE SECURITY GATE & AUDIT ENGINE');
  console.log('============================================================\n');

  const srcDir = path.resolve(__dirname, '../src');
  console.log(`Scanning directory: ${srcDir} ...\n`);

  const result = AICodeSecurityGate.scanPath(srcDir);

  console.log(`Files Scanned: ${result.filesScanned}`);
  console.log(`Critical Violations: ${result.criticalCount}`);
  console.log(`High Violations    : ${result.highCount}`);
  console.log(`Medium Violations  : ${result.mediumCount}`);
  console.log(`Low Violations     : ${result.lowCount}\n`);

  if (result.violations.length > 0) {
    console.log('--- DETECTED VIOLATIONS ---');
    for (const v of result.violations) {
      console.log(`[${v.severity}] [${v.ruleId}] ${v.category}: ${v.message}`);
      console.log(`  File: ${v.filePath}:${v.lineNumber}`);
      console.log(`  Evidence: ${v.evidence}\n`);
    }
  }

  if (result.passed) {
    console.log('✅ AI-CODE SECURITY GATE PASSED: ZERO CRITICAL / HIGH VULNERABILITIES DETECTED.\n');
    process.exit(0);
  } else {
    console.error('❌ AI-CODE SECURITY GATE FAILED: CRITICAL/HIGH VULNERABILITIES MUST BE RESOLVED BEFORE MERGE.\n');
    process.exit(1);
  }
}

main();
