import { prisma } from '../src/database/prisma';
import { DEFAULT_PLATFORM_WALLETS } from '../src/modules/remote-config/feature-flags.defaults';
import { remoteConfigService } from '../src/modules/remote-config/remote-config.service';

async function updatePlatformWalletAccounts() {
  console.log('Seeding official platform wallet accounts into PostgreSQL SystemSetting...');

  const setting = await prisma.systemSetting.upsert({
    where: { key: 'platform_wallet_accounts' },
    create: {
      key: 'platform_wallet_accounts',
      value: JSON.stringify(DEFAULT_PLATFORM_WALLETS),
      type: 'json',
      group: 'remote_config',
    },
    update: {
      value: JSON.stringify(DEFAULT_PLATFORM_WALLETS),
    },
  });

  remoteConfigService.invalidateCache();

  console.log('✓ Successfully saved platform wallet accounts to PostgreSQL:');
  console.log(`Key: ${setting.key}, UpdatedAt: ${setting.updatedAt}`);
  for (const acc of DEFAULT_PLATFORM_WALLETS) {
    console.log(`  - [${acc.order}] ${acc.provider}: ${acc.nameAr} | Account: ${acc.accountNumber} | Phone: ${acc.phoneNumber} | Holder: ${acc.holderName}`);
  }

  await prisma.$disconnect();
}

updatePlatformWalletAccounts().catch(err => {
  console.error('Error seeding platform wallets:', err);
  process.exit(1);
});
