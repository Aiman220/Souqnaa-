import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import {
  RewardTxType,
  RewardTxSource,
  CoinLotStatus,
  RewardTxStatus,
} from '../rewards.types';
import { RewardsConfigService } from './rewards-config.service';
import { RewardsNotificationService } from './rewards-notification.service';

export class RewardsExpirationService {
  /**
   * Authoritative Coin Expiration Scheduled Job (§84).
   * Finds all overdue active coin lots, marks them EXPIRED, updates balance, and logs in ledger.
   */
  static async expireCoins(): Promise<{ expiredLotsCount: number; totalCoinsExpired: number }> {
    const isExpirationEnabled = await RewardsConfigService.isEnabled('rewards_coin_expiration.enabled');
    if (!isExpirationEnabled) {
      return { expiredLotsCount: 0, totalCoinsExpired: 0 };
    }

    const now = new Date();
    const expiredLots = await prisma.coinLot.findMany({
      where: {
        status: CoinLotStatus.ACTIVE,
        remainingCoins: { gt: 0 },
        expiresAt: { lt: now },
      },
      include: { account: true },
      take: 500, // Batch processing
    });

    let totalCoinsExpired = 0;
    let expiredLotsCount = 0;

    for (const lot of expiredLots) {
      await prisma.$transaction(async (tx) => {
        // Re-check lot status within transaction
        const currentLot = await tx.coinLot.findUnique({ where: { id: lot.id } });
        if (!currentLot || currentLot.status !== CoinLotStatus.ACTIVE || currentLot.remainingCoins <= 0) {
          return;
        }

        const coinsToExpire = currentLot.remainingCoins;
        const idempotencyKey = `expireLot:${lot.id}`;

        // 1. Mark Lot EXPIRED
        await tx.coinLot.update({
          where: { id: lot.id },
          data: {
            status: CoinLotStatus.EXPIRED,
            remainingCoins: 0,
          },
        });

        // 2. Fetch fresh balance
        const account = await tx.rewardAccount.findUnique({
          where: { id: lot.accountId },
        });

        const balanceBefore = account?.availableCoins || 0;
        const balanceAfter = Math.max(0, balanceBefore - coinsToExpire);

        // 3. Create immutable EXPIRE transaction
        await tx.coinTransaction.create({
          data: {
            accountId: lot.accountId,
            customerId: lot.customerId,
            type: RewardTxType.EXPIRE,
            source: RewardTxSource.SYSTEM,
            coins: -coinsToExpire,
            balanceBefore,
            balanceAfter,
            referenceType: 'COIN_LOT',
            referenceId: lot.id,
            idempotencyKey,
            status: RewardTxStatus.COMPLETED,
            descriptionAr: `انتهاء صلاحية ${coinsToExpire} عملة من عملات سوقناا`,
            descriptionEn: `Expiration of ${coinsToExpire} SOUQNAA Coins`,
            createdBy: 'SYSTEM',
          },
        });

        // 4. Update materialized account balance & lifetimeExpired
        await tx.rewardAccount.update({
          where: { id: lot.accountId },
          data: {
            availableCoins: balanceAfter,
            lifetimeExpired: { increment: coinsToExpire },
          },
        });

        totalCoinsExpired += coinsToExpire;
        expiredLotsCount++;

        // Notify user about expired coins
        await RewardsNotificationService.notifyCoinsExpired({
          customerId: lot.customerId,
          coins: coinsToExpire,
        });
      });
    }

    return { expiredLotsCount, totalCoinsExpired };
  }

  /**
   * Expiration Warning Notifications Scheduled Job (§10).
   * Identifies coins expiring in 7, 3, or 1 days, and notifies customers without spamming.
   */
  static async sendExpirationWarnings(): Promise<number> {
    const isExpirationEnabled = await RewardsConfigService.isEnabled('rewards_coin_expiration.enabled');
    if (!isExpirationEnabled) return 0;

    const rules = await RewardsConfigService.getRules();
    const warningDaysList = [rules.warningDays || 7, 3, 1];
    let warningsSent = 0;

    for (const days of warningDaysList) {
      const startRange = new Date();
      startRange.setDate(startRange.getDate() + days - 1);
      const endRange = new Date();
      endRange.setDate(endRange.getDate() + days);

      const lotsExpiring = await prisma.coinLot.findMany({
        where: {
          status: CoinLotStatus.ACTIVE,
          remainingCoins: { gt: 0 },
          expiresAt: {
            gte: startRange,
            lt: endRange,
          },
        },
      });

      // Group expiring coins by customer
      const customerMap = new Map<string, number>();
      for (const lot of lotsExpiring) {
        const current = customerMap.get(lot.customerId) || 0;
        customerMap.set(lot.customerId, current + lot.remainingCoins);
      }

      for (const [customerId, coins] of customerMap.entries()) {
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden' }).format(new Date());
        const dedupKey = `rewards:exp_warn:${customerId}:${days}:${todayStr}`;

        // Anti-spam check: send max once per warning threshold per day
        const alreadySent = await redis.get(dedupKey);
        if (alreadySent) continue;

        await RewardsNotificationService.notifyCoinsExpiringSoon({
          customerId,
          coins,
          daysRemaining: days,
        });

        await redis.set(dedupKey, '1', 86400); // 24-hour TTL
        warningsSent++;
      }
    }

    return warningsSent;
  }

  /**
   * Scheduled Reward Reconciliation Job (§85).
   * Compares ledger balance against materialized customer balance and heals any drift with an audit log.
   */
  static async reconcileBalances(): Promise<{ reconciledCount: number; fixedCount: number }> {
    const accounts = await prisma.rewardAccount.findMany({
      take: 1000,
    });

    let reconciledCount = 0;
    let fixedCount = 0;

    for (const account of accounts) {
      const aggregates = await prisma.coinTransaction.aggregate({
        where: {
          accountId: account.id,
          status: RewardTxStatus.COMPLETED,
        },
        _sum: { coins: true },
      });

      const ledgerBalance = aggregates._sum.coins || 0;
      reconciledCount++;

      if (account.availableCoins !== ledgerBalance) {
        await prisma.$transaction(async (tx) => {
          await tx.rewardAccount.update({
            where: { id: account.id },
            data: { availableCoins: ledgerBalance },
          });

          await tx.rewardAuditLog.create({
            data: {
              adminId: 'SYSTEM',
              action: 'BALANCE_RECONCILIATION',
              resource: 'reward_account',
              targetCustomerId: account.customerId,
              details: JSON.stringify({
                driftDetected: true,
                materializedBefore: account.availableCoins,
                authoritativeLedger: ledgerBalance,
              }),
            },
          });
        });
        fixedCount++;
      }
    }

    return { reconciledCount, fixedCount };
  }
}
