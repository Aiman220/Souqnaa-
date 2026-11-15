import { launcherCampaignService } from '../../modules/remote-config/launcher-campaign.service';
import { remoteConfigService } from '../../modules/remote-config/remote-config.service';

export class LauncherCampaignScheduler {
  private static timer: NodeJS.Timeout | null = null;
  private static isRunning = false;

  static async init() {
    try {
      await this.runReconciliation();
      console.log('[LauncherCampaignScheduler] Initialized and performed boot reconciliation.');
    } catch (err: any) {
      console.error('[LauncherCampaignScheduler] Init error:', err.message);
    }
  }

  static start(intervalMs = 60 * 1000) {
    this.stop();
    this.timer = setInterval(async () => {
      await this.runReconciliation();
    }, intervalMs);
  }

  static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  static async runReconciliation() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const result = await launcherCampaignService.reconcileAllCampaignSchedules();
      if (result.reconciledCount > 0) {
        console.log(
          `[LauncherCampaignScheduler] Reconciled ${result.reconciledCount} expired campaign(s): ${result.changed.join(', ')}`
        );
        remoteConfigService.invalidateCache();
        remoteConfigService.broadcastConfigUpdate({
          action: 'RECONCILE_EXPIRED_CAMPAIGNS',
          reconciled: result.changed,
        });
      }
    } catch (err: any) {
      console.warn('[LauncherCampaignScheduler] Reconciliation warning:', err.message);
    } finally {
      this.isRunning = false;
    }
  }
}
