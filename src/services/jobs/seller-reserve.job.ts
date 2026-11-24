import { SellerReserveService } from '../../modules/commission/seller-reserve.service';
import { SellerReconciliationService } from '../../modules/commission/seller-reconciliation.service';
import { redisService } from '../../database/redis';

/**
 * SOUQNAA Marketplace — Seller Reserve Lifecycle & Financial Reconciliation Worker
 * Automatically releases mature 30-day reserves into seller balances,
 * executes automated debt recovery, and periodically runs invariant checks.
 */
export class SellerReserveScheduler {
  private static timer: NodeJS.Timeout | null = null;
  private static cycleCounter = 0;
  private static isCycleRunning = false;

  static start(intervalMs = 60 * 60 * 1000): void { // Hourly check
    if (this.timer) return;

    console.log('[SellerReserveScheduler] Starting background Seller Reserve & Reconciliation worker...');
    this.runCycle();

    this.timer = setInterval(() => {
      this.runCycle();
    }, intervalMs);
  }

  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[SellerReserveScheduler] Stopped background Seller Reserve worker.');
    }
  }

  private static async runCycle(): Promise<void> {
    if (this.isCycleRunning) {
      console.warn('[SellerReserveScheduler] Previous cycle is still running. Skipping to prevent race conditions.');
      return;
    }

    // RESV-003: Distributed lock across multi-instance worker processes
    let lockToken: string | null = null;
    try {
      const lock = await redisService.acquireLock('seller:reserve:job:cycle', 300);
      if (!lock.acquired) {
        console.warn('[SellerReserveScheduler] Cycle is already active on another node. Skipping.');
        return;
      }
      lockToken = lock.token;
    } catch (lockErr) {
      console.warn('[SellerReserveScheduler] Redis lock error, proceeding with local mutex:', lockErr);
    }

    this.isCycleRunning = true;
    try {
      this.cycleCounter++;

      // 1. Process mature reserve releases (30-day holding period elapsed)
      const releaseResult = await SellerReserveService.processEligibleReserveReleases('SYSTEM_SCHEDULER');
      if (releaseResult.processedCount > 0) {
        console.log(
          `[SellerReserveScheduler] Processed ${releaseResult.processedCount} mature reserve allocation(s). Released: ${releaseResult.releasedAmount} YER, Applied to debt: ${releaseResult.appliedToDebtAmount} YER.`
        );
      }

      // 2. Periodically verify double-entry ledger invariants (every 24 hours ~ 24 cycles)
      if (this.cycleCounter % 24 === 0) {
        console.log('[SellerReserveScheduler] Running automated daily financial invariant reconciliation...');
        const reconciliation = await SellerReconciliationService.runReconciliation('SYSTEM_DAILY_AUDIT');
        if (reconciliation.totalDiscrepancies > 0) {
          console.warn(
            `[SellerReserveScheduler] Reconciliation detected ${reconciliation.totalDiscrepancies} invariant discrepancy(s)! Status: ${reconciliation.status}`
          );
        } else {
          console.log(`[SellerReserveScheduler] Daily reconciliation passed with 0 discrepancies (Status: ${reconciliation.status}).`);
        }
      }
    } catch (err) {
      console.error('[SellerReserveScheduler] Error during scheduled reserve cycle:', err);
    } finally {
      this.isCycleRunning = false;
      if (lockToken) {
        try {
          await redisService.releaseLock('seller:reserve:job:cycle', lockToken);
        } catch (_) {}
      }
    }
  }
}
