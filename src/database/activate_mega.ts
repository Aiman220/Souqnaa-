import { prisma } from './prisma';
import { bannerCacheService } from '../modules/promotions/services/banner-cache.service';

async function main() {
  console.log('Activating Mega Campaign and all its banners...');
  await prisma.campaign.updateMany({
    where: {
      status: 'PAUSED',
    },
    data: {
      status: 'ACTIVE',
    },
  });

  await prisma.promotionalBanner.updateMany({
    where: {
      status: 'PAUSED',
    },
    data: {
      status: 'APPROVED',
      isActive: true,
    },
  });

  await bannerCacheService.invalidateAllBanners();
  console.log('Done! All campaigns and banners activated and cache invalidated.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
