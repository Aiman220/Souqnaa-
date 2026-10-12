import { flashSaleService } from '../../modules/flash-sales/flash-sale.service';

export class FlashSaleScheduler {
  private static timer: NodeJS.Timeout | null = null;
  private static cycleCounter = 0;

  static start(intervalMs = 30 * 1000): void {
    if (this.timer) return;

    console.log('[FlashSaleScheduler] Starting background Flash Sale worker...');
    this.runCycle();

    this.timer = setInterval(() => {
      this.runCycle();
    }, intervalMs);
  }

  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[FlashSaleScheduler] Stopped background Flash Sale worker.');
    }
  }

  private static async runCycle(): Promise<void> {
    try {
      this.cycleCounter++;

      // 1. Activate scheduled campaigns that reached their startAt
      const activated = await flashSaleService.activateScheduledCampaigns();
      if (activated > 0) {
        console.log(`[FlashSaleScheduler] Activated ${activated} scheduled campaign(s).`);
      }

      // 2. End active campaigns that reached their endAt
      const ended = await flashSaleService.endExpiredCampaigns();
      if (ended > 0) {
        console.log(`[FlashSaleScheduler] Ended ${ended} expired campaign(s).`);
      }

      // 3. Expire stale reservations and release reserved stock
      const expiredReservations = await flashSaleService.expireStaleReservations();
      if (expiredReservations > 0) {
        console.log(`[FlashSaleScheduler] Released ${expiredReservations} expired reservation(s).`);
      }

      // 4. Periodically reconcile inventory to eliminate drift (every 5 cycles ~ 2.5 minutes)
      if (this.cycleCounter % 5 === 0) {
        const reconciliation = await flashSaleService.reconcileInventory();
        if (reconciliation.discrepanciesFound > 0) {
          console.warn(
            `[FlashSaleScheduler] Reconciled inventory: corrected ${reconciliation.corrected}/${reconciliation.discrepanciesFound} discrepancies.`
          );
        }
      }
    } catch (err) {
      console.error('[FlashSaleScheduler] Error during scheduled cycle:', err);
    }
  }
}
