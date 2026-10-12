import { placementService } from '../../modules/promotions/services/placement.service';
import { campaignService } from '../../modules/promotions/services/campaign.service';

export class CampaignBannerScheduler {
  private static timer: NodeJS.Timeout | null = null;

  static async init() {
    try {
      // Seed default placements on boot
      await placementService.seedDefaultPlacements();
      // Initial status sync
      await campaignService.syncCampaignStatuses();
      console.log('[CampaignBanner] Initialized default placements & synced campaign statuses.');
    } catch (err: any) {
      console.error('[CampaignBanner] Failed to initialize default placements:', err.message);
    }
  }

  static start(intervalMs = 60 * 1000) {
    this.stop();
    this.timer = setInterval(async () => {
      try {
        await campaignService.syncCampaignStatuses();
      } catch (err: any) {
        console.warn('[CampaignBanner] Error syncing campaign statuses:', err.message);
      }
    }, intervalMs);
  }

  static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
