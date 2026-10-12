import { prisma } from '../src/database/prisma';
import { DEFAULT_WALLET_PROVIDERS } from '../src/modules/remote-config/feature-flags.defaults';
import { remoteConfigService } from '../src/modules/remote-config/remote-config.service';

async function updateAllWalletProviders() {
  console.log('Seeding all 12 Yemeni digital wallet providers into database...');

  const flag = await prisma.featureFlag.findUnique({
    where: { key: 'electronic_wallet_providers' },
  });

  if (!flag) {
    console.error('electronic_wallet_providers flag not found in database!');
    return;
  }

  let currentMeta: Record<string, any> = {};
  try {
    currentMeta = typeof flag.metadata === 'string' ? JSON.parse(flag.metadata) : (flag.metadata || {});
  } catch (_) {}

  const mergedProviders = {
    ...DEFAULT_WALLET_PROVIDERS,
    ...(currentMeta.providers || {}),
  };

  // Ensure all 12 providers are present and properly structured
  for (const [code, prov] of Object.entries(DEFAULT_WALLET_PROVIDERS)) {
    if (!mergedProviders[code]) {
      mergedProviders[code] = prov;
    } else {
      mergedProviders[code] = {
        ...prov,
        ...mergedProviders[code],
      };
    }
  }

  currentMeta.providers = mergedProviders;

  await prisma.featureFlag.update({
    where: { key: 'electronic_wallet_providers' },
    data: {
      metadata: JSON.stringify(currentMeta),
      descriptionAr: 'التحكم العام والتفصيلي بجميع المحافظ الإلكترونية اليمنية (12 محفظة: حاسب، جوالي، جيب، ون كاش، فلوسك، كاش، محفظة اليمن، سبأ كاش، بيس، إيزي، شامل موني، موبيل موني)',
      descriptionEn: 'Comprehensive control over all 12 Yemeni digital wallet transfer channels',
    },
  });

  remoteConfigService.invalidateCache();
  console.log('✓ Successfully updated database with all 12 wallet providers:');
  const count = Object.keys(mergedProviders).length;
  console.log(`Total wallet providers: ${count}`);
  for (const [code, prov] of Object.entries(mergedProviders)) {
    const p = prov as any;
    console.log(`  - [${p.order}] ${code}: ${p.nameAr} (${p.enabled ? 'ON' : 'OFF'})`);
  }

  await prisma.$disconnect();
}

updateAllWalletProviders();
