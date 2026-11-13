import { prisma } from '../src/database/prisma';
import { redis } from '../src/database/redis';
import { remoteConfigService } from '../src/modules/remote-config/remote-config.service';
import { APPROVED_CUSTOMER_APP_ICONS } from '../src/modules/remote-config/feature-flags.defaults';
import assert from 'assert';

async function runBrandingIconTests() {
  console.log('🧪 Starting Customer App Icon Isolated Test Suite...\n');

  const adminUser = { id: 'test-admin-id', email: 'admin@souqnaa.ye' };

  // 1. Initial State & Approved Icons List
  console.log('1. Checking approved icon registry...');
  assert(APPROVED_CUSTOMER_APP_ICONS.length === 5, 'APPROVED_CUSTOMER_APP_ICONS must contain 5 variants');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('default'), 'Contains default');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('orange'), 'Contains orange');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('modern'), 'Contains modern');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('minimal'), 'Contains minimal');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('seasonal'), 'Contains seasonal');
  console.log('  ✓ PASS: Approved icons registry contains default, orange, modern, minimal, seasonal');

  // 2. Fetch current branding config
  console.log('\n2. Fetching current branding config...');
  const initialBranding = await remoteConfigService.getBrandingConfig();
  console.log(`  Current customerAppIcon: ${initialBranding.customerAppIcon}`);
  assert(typeof initialBranding.customerAppIcon === 'string', 'customerAppIcon must be a string');
  console.log('  ✓ PASS: getBrandingConfig returns valid customerAppIcon');

  // 3. Test updating customerAppIcon to orange
  console.log('\n3. Testing update to "orange"...');
  const updatedOrange = await remoteConfigService.updateBrandingConfig({
    customerAppIcon: 'orange',
  }, adminUser);
  assert.strictEqual(updatedOrange.customerAppIcon, 'orange', 'customerAppIcon updated to orange in returned object');

  // Verify persistence in PostgreSQL SystemSetting
  const settingRecord = await prisma.systemSetting.findUnique({
    where: { key: 'customer_app_icon' },
  });
  assert(settingRecord !== null, 'customer_app_icon row exists in SystemSetting table');
  assert.strictEqual(settingRecord?.value, 'orange', 'customer_app_icon is persisted as "orange" in database');
  console.log('  ✓ PASS: Database persistence verified (SystemSetting key: customer_app_icon = "orange")');

  // Verify resolved config serves orange
  const resolvedOrange = await remoteConfigService.getResolvedConfig({ platform: 'android' });
  assert.strictEqual(resolvedOrange.branding.customerAppIcon, 'orange', 'getResolvedConfig serves customerAppIcon: "orange"');
  console.log('  ✓ PASS: getResolvedConfig serves customerAppIcon: "orange"');

  // 4. Verify Audit Log for customer_app_icon
  console.log('\n4. Verifying FeatureFlagAuditLog...');
  const auditLog = await prisma.featureFlagAuditLog.findFirst({
    where: { featureKey: 'customer_app_icon' },
    orderBy: { createdAt: 'desc' },
  });
  assert(auditLog !== null, 'FeatureFlagAuditLog recorded for customer_app_icon');
  assert.strictEqual(auditLog?.action, 'UPDATE', 'Audit log action is UPDATE');
  assert.strictEqual(auditLog?.newValue, 'orange', 'Audit log newValue matches "orange"');
  assert.strictEqual(auditLog?.changedBy, adminUser.email, 'Audit log author matches admin email');
  console.log('  ✓ PASS: FeatureFlagAuditLog recorded with author and new value');

  // 5. Test updating to all approved variants
  console.log('\n5. Testing all approved variants...');
  for (const variant of ['modern', 'minimal', 'seasonal'] as const) {
    const res = await remoteConfigService.updateBrandingConfig({ customerAppIcon: variant }, adminUser);
    assert.strictEqual(res.customerAppIcon, variant, `customerAppIcon updated to ${variant}`);
    const dbRec = await prisma.systemSetting.findUnique({ where: { key: 'customer_app_icon' } });
    assert.strictEqual(dbRec?.value, variant, `Database matches ${variant}`);
    console.log(`  ✓ PASS: Variant "${variant}" successfully persisted`);
  }

  // 6. Test invalid icon identifier rejection
  console.log('\n6. Testing validation of invalid icon identifiers...');
  let rejected = false;
  try {
    await remoteConfigService.updateBrandingConfig({
      customerAppIcon: 'invalid_malicious_icon_value',
    }, adminUser);
  } catch (err: any) {
    rejected = true;
    assert.strictEqual(err.statusCode, 400, 'Error status code must be 400');
    assert(err.message.includes('معرّف أيقونة التطبيق غير معتمد'), 'Error message informs of unapproved icon');
  }
  assert(rejected, 'updateBrandingConfig must throw 400 for unapproved icon identifier');
  console.log('  ✓ PASS: Unapproved icon value rejected with HTTP 400');

  // 7. Reset back to default
  console.log('\n7. Testing reset to default...');
  const resetBranding = await remoteConfigService.updateBrandingConfig({
    customerAppIcon: 'default',
  }, adminUser);
  assert.strictEqual(resetBranding.customerAppIcon, 'default', 'customerAppIcon reset to default');
  const defaultRec = await prisma.systemSetting.findUnique({ where: { key: 'customer_app_icon' } });
  assert.strictEqual(defaultRec?.value, 'default', 'Database reset to default');
  console.log('  ✓ PASS: Reset to default verified');

  console.log('\n========================================');
  console.log('🎉 All Customer App Icon tests PASSED!');
  console.log('========================================\n');
}

runBrandingIconTests()
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
