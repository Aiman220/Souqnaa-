import { prisma } from '../src/database/prisma';

async function main() {
  const promoCount = await prisma.promotionalBanner.count();
  console.log('PromotionalBanner count:', promoCount);
  const promoAll = await prisma.promotionalBanner.findMany({
    include: { campaign: true, placement: true }
  });
  console.log('PromotionalBanner rows:', JSON.stringify(promoAll, null, 2));

  // Check legacy banner table if any
  const legacyCount = await prisma.banner.count();
  console.log('Legacy Banner table count:', legacyCount);
}

main().catch(console.error).finally(() => prisma.$disconnect());
