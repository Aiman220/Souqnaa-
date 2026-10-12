#!/usr/bin/env node
/**
 * SOUQNA — FIRST SUPER_ADMIN SECURE BOOTSTRAP CLI
 * 
 * Usage:
 *   Interactive: npm run bootstrap:admin
 *   Headless CI: BOOTSTRAP_ADMIN_EMAIL=admin@example.com BOOTSTRAP_ADMIN_PASSWORD='...' npm run bootstrap:admin
 *   Recovery:    npm run bootstrap:admin -- --recovery --recovery-key <KEY>
 */

import 'dotenv/config';
import readline from 'readline';
import { AdminBootstrapService } from '../src/modules/admin/admin-bootstrap.service';

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function askHiddenQuestion(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const stdin = process.stdin;
    process.stdout.write(query);

    let password = '';
    const onData = (char: Buffer) => {
      const str = char.toString('utf-8');
      switch (str) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          process.stdout.write('\n');
          rl.close();
          resolve(password.trim());
          break;
        case '\u0003': // Ctrl+C
          process.stdout.write('\n');
          process.exit(1);
          break;
        case '\b':
        case '\x7f':
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          password += str;
          process.stdout.write('*');
          break;
      }
    };

    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    } else {
      // Non-TTY fallback
      rl.question('', (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    }
  });
}

async function main() {
  console.log('============================================================');
  console.log('🛡️  سوقناا — SOUQNAA FIRST SUPER_ADMIN BOOTSTRAP');
  console.log('============================================================\n');

  const args = process.argv.slice(2);
  const isRecovery = args.includes('--recovery');
  let recoveryKey = process.env.BOOTSTRAP_RECOVERY_KEY || '';

  const recoveryKeyArgIndex = args.indexOf('--recovery-key');
  if (recoveryKeyArgIndex !== -1 && args[recoveryKeyArgIndex + 1]) {
    recoveryKey = args[recoveryKeyArgIndex + 1];
  }

  // Check if bootstrap is already complete
  try {
    const isDone = await AdminBootstrapService.isBootstrapCompleted();
    if (isDone && !isRecovery) {
      console.log('⚠️  انتباه: تمت تهيئة المدير الأول مسبقاً في النظام.');
      console.log('    لحماية النظام، تم حظر تكرار التهيئة.');
      console.log('    إذا كنت بحاجة لاسترداد الحساب أو إعادة التهيئة، استخدم خيار:');
      console.log('    npm run bootstrap:admin -- --recovery --recovery-key <KEY>\n');
      process.exit(0);
    }
  } catch (err: any) {
    console.error('خطأ أثناء فحص حالة النظام:', err.message);
  }

  let email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || '';
  let password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  const fullName = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || '';
  let firstName = process.env.BOOTSTRAP_ADMIN_FIRST_NAME?.trim() || (fullName ? fullName.split(' ')[0] : '');
  let lastName = process.env.BOOTSTRAP_ADMIN_LAST_NAME?.trim() || (fullName ? fullName.split(' ').slice(1).join(' ') : '');

  // Interactive input if not provided via environment
  if (!email) {
    email = await askQuestion('أدخل البريد الإلكتروني للمدير العام: ');
  }

  if (!firstName) {
    firstName = await askQuestion('الاسم الأول: ') || 'مدير';
  }

  if (!lastName) {
    lastName = await askQuestion('اسم العائلة: ') || 'النظام';
  }

  if (!password) {
    password = await askHiddenQuestion('أدخل كلمة المرور (مخفية ومحمية): ');
    const confirm = await askHiddenQuestion('تأكيد كلمة المرور: ');

    if (password !== confirm) {
      console.error('\n❌ خطأ: كلمتا المرور غير متطابقتين.');
      process.exit(1);
    }
  }

  if (isRecovery && !recoveryKey) {
    recoveryKey = await askHiddenQuestion('أدخل مفتاح الاسترداد المصرح به (Recovery Key): ');
  }

  console.log('\nجاري التحقق والتهيئة الآمنة في قاعدة البيانات...');

  try {
    const result = await AdminBootstrapService.bootstrapFirstAdmin({
      email,
      password,
      firstName,
      lastName,
      recoveryMode: isRecovery,
      recoveryKey: recoveryKey || undefined,
    });

    console.log('\n============================================================');
    console.log('✅ تم إكمال تهيئة المدير العام بنجاح (BOOTSTRAP COMPLETE)');
    console.log('============================================================');
    console.log(`• المعرف الفريد (ID) : ${result.adminId}`);
    console.log(`• البريد الإلكتروني : ${result.email}`);
    console.log(`• الدور الوظيفي     : ${result.role}`);
    console.log(`• حالة الحساب      : نشط وموثق (Active & Verified)`);
    console.log(`• وقت الإجراء       : ${result.createdAt.toISOString()}`);
    if (result.recovered) {
      console.log(`• وضع الاسترداد     : تم تفعيل الاسترداد المصرح به`);
    }
    console.log('============================================================');
    console.log('🔒 تنبيه أمني: لم ولن تتم طباعة كلمة المرور أو رمز الدخول في السجلات.');
    console.log('   يرجى تسجيل الدخول عبر بوابة الإدارة: /login\n');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ فشلت عملية التهيئة:');
    console.error(err.message || err);
    console.error('');
    process.exit(1);
  }
}

main();
