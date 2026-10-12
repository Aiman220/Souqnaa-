import { RewardsExpirationService } from '../../modules/rewards/services/rewards-expiration.service';

export class RewardsScheduler {
  private static timer: NodeJS.Timeout | null = null;
  private static lastWarningDate = '';

  static start(intervalMs = 60 * 60 * 1000): void {
    if (this.timer) return;

    console.log('[RewardsScheduler] Starting background SOUQNAA Rewards & Expiration worker...');
    this.runCycle();

    this.timer = setInterval(() => {
      this.runCycle();
    }, intervalMs);
  }

  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[RewardsScheduler] Stopped background SOUQNAA Rewards worker.');
    }
  }

  private static async runCycle(): Promise<void> {
    try {
      // 1. Expire overdue coin lots (§84)
      const expireResult = await RewardsExpirationService.expireCoins();
      if (expireResult.expiredLotsCount > 0) {
        console.log(
          `[RewardsScheduler] Expired ${expireResult.expiredLotsCount} coin lot(s), total ${expireResult.totalCoinsExpired} coins.`
        );
      }

      // 2. Send Expiration Warnings once per calendar day in Asia/Aden timezone (§10)
      const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden' }).format(new Date());
      if (this.lastWarningDate !== todayDate) {
        const warnings = await RewardsExpirationService.sendExpirationWarnings();
        if (warnings > 0) {
          console.log(`[RewardsScheduler] Sent ${warnings} coin expiration warning(s).`);
        }
        this.lastWarningDate = todayDate;
      }

      // 3. Periodic balance reconciliation (§85)
      const reconResult = await RewardsExpirationService.reconcileBalances();
      if (reconResult.fixedCount > 0) {
        console.warn(
          `[RewardsScheduler] Reconciled ${reconResult.reconciledCount} accounts. Fixed ${reconResult.fixedCount} drifted account(s).`
        );
      }
    } catch (err) {
      console.error('[RewardsScheduler] Error during scheduled cycle:', err);
    }
  }
}
