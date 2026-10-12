import { prisma } from './prisma';
import { bannerCacheService } from '../modules/promotions/services/banner-cache.service';

async function main() {
  console.log('Fixing all campaign schedules to 00:00 - 23:59 full day...');
  await prisma.campaignSchedule.updateMany({
    data: {
      scheduleType: 'ONCE',
      startTimeOfDay: '00:00',
      endTimeOfDay: '23:59',
    },
  });

  console.log('Activating all campaigns and banners...');
  await prisma.campaign.updateMany({
    data: {
      status: 'ACTIVE',
    },
  });

  await prisma.promotionalBanner.updateMany({
    data: {
      status: 'APPROVED',
      isActive: true,
    },
  });

  await bannerCacheService.invalidateAllBanners();
  console.log('Done! All schedules updated to full day and cache invalidated.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
