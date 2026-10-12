import crypto from 'crypto';
import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import {
  RewardTxType,
  RewardTxSource,
  RewardTxStatus,
  CoinLotStatus,
  RewardFundingSource,
  CoinBalanceSummary,
} from '../rewards.types';
import { RewardsConfigService } from './rewards-config.service';

export interface CreditCoinsParams {
  customerId: string;
  coins: number;
  type: RewardTxType;
  source: RewardTxSource;
  fundingSource?: RewardFundingSource;
  sellerId?: string;
  campaignId?: string;
  missionId?: string;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  descriptionAr: string;
  descriptionEn: string;
  expiresInDays?: number;
  createdBy?: string;
  metadata?: Record<string, any>;
}

export interface DebitCoinsParams {
  customerId: string;
  coins: number;
  type: RewardTxType;
  source: RewardTxSource;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  descriptionAr: string;
  descriptionEn: string;
  createdBy?: string;
  metadata?: Record<string, any>;
  allowNegative?: boolean;
}

export class RewardsLedgerService {
  /**
   * Generates a collision-resistant SOUQNAA customer referral code (e.g. SQN-A8F4K2).
   */
  static generateReferralCode(): string {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = 'SQN-';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(crypto.randomInt(0, chars.length));
    }
    return code;
  }

  /**
   * Retrieves or initializes a customer's RewardAccount with a unique referral code.
   */
  static async getOrCreateAccount(customerId: string, tx: any = prisma) {
    let account = await tx.rewardAccount.findUnique({
      where: { customerId },
    });

    if (!account) {
      // Generate unique referral code with retry logic
      let referralCode = this.generateReferralCode();
      let attempts = 0;
      while (attempts < 5) {
        const existing = await tx.rewardAccount.findUnique({ where: { referralCode } });
        if (!existing) break;
        referralCode = this.generateReferralCode();
        attempts++;
      }

      account = await tx.rewardAccount.create({
        data: {
          customerId,
          referralCode,
          availableCoins: 0,
          pendingCoins: 0,
          expiringSoonCoins: 0,
          lifetimeEarned: 0,
          lifetimeRedeemed: 0,
          lifetimeExpired: 0,
        },
      });
    }

    return account;
  }

  /**
   * Computes the authoritative balance from the immutable CoinTransaction ledger.
   * Auto-heals materialized RewardAccount if drift is detected.
   */
  static async getAuthoritativeBalance(customerId: string, tx: any = prisma): Promise<number> {
    const account = await this.getOrCreateAccount(customerId, tx);

    const aggregates = await tx.coinTransaction.aggregate({
      where: {
        accountId: account.id,
        status: RewardTxStatus.COMPLETED,
      },
      _sum: {
        coins: true,
      },
    });

    const authoritativeBalance = aggregates._sum.coins || 0;

    // Auto-heal materialized cached balance if drifted
    if (account.availableCoins !== authoritativeBalance) {
      await tx.rewardAccount.update({
        where: { id: account.id },
        data: { availableCoins: authoritativeBalance },
      });
      account.availableCoins = authoritativeBalance;
    }

    return authoritativeBalance;
  }

  /**
   * Returns a complete balance summary with expiring coins breakdown and daily check-in readiness.
   */
  static async getBalanceSummary(customerId: string): Promise<CoinBalanceSummary> {
    const account = await this.getOrCreateAccount(customerId);
    const rules = await RewardsConfigService.getRules();
    const authoritativeBalance = await this.getAuthoritativeBalance(customerId);

    // Compute expiring soon coins (if expiration feature enabled)
    const isExpirationEnabled = await RewardsConfigService.isEnabled('rewards_coin_expiration.enabled');
    let expiringSoonCoins = 0;
    let expiringSoonDate: string | null = null;

    const now = new Date();

    if (isExpirationEnabled && (rules.warningDays || 0) > 0) {
      const warningHorizon = new Date();
      warningHorizon.setDate(warningHorizon.getDate() + (rules.warningDays || 7));

      const expiringLots = await prisma.coinLot.findMany({
        where: {
          customerId,
          status: CoinLotStatus.ACTIVE,
          remainingCoins: { gt: 0 },
          expiresAt: {
            gt: now,
            lte: warningHorizon,
          },
        },
        orderBy: { expiresAt: 'asc' },
      });

      expiringSoonCoins = expiringLots.reduce((sum, lot) => sum + lot.remainingCoins, 0);
      expiringSoonDate = expiringLots.length > 0 ? expiringLots[0].expiresAt.toISOString() : null;
    }

    // Check check-in eligibility for today (Asia/Aden timezone: UTC+3)
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden' }).format(now);
    const canCheckInToday = account.lastCheckInDate !== todayStr;

    // Currency equivalent in YER (redemptionRatio: e.g. 100 coins = 1 YER)
    const currencyEquivalent = parseFloat(
      (authoritativeBalance / (rules.redemptionRatio || 100)).toFixed(2)
    );

    return {
      customerId,
      availableCoins: authoritativeBalance,
      pendingCoins: account.pendingCoins,
      expiringSoonCoins,
      expiringSoonDate,
      lifetimeEarned: account.lifetimeEarned,
      lifetimeRedeemed: account.lifetimeRedeemed,
      lifetimeExpired: account.lifetimeExpired,
      referralCode: account.referralCode || '',
      currentStreak: account.currentStreak,
      longestStreak: account.longestStreak,
      lastCheckInDate: account.lastCheckInDate,
      canCheckInToday,
      currencyEquivalent,
      currencyCode: 'YER',
      riskFlag: account.riskFlag,
    };
  }

  /**
   * Credits coins to a customer.
   * Atomically creates CoinLot, updates CoinTransaction ledger, and updates RewardAccount materialized stats.
   * Fully supports idempotency.
   */
  static async creditCoins(params: CreditCoinsParams, externalTx?: any) {
    const execute = async (tx: any) => {
      // 1. Idempotency check (§58)
      if (params.idempotencyKey) {
        const existingTx = await tx.coinTransaction.findUnique({
          where: { idempotencyKey: params.idempotencyKey },
        });
        if (existingTx) {
          return { transaction: existingTx, isDuplicate: true };
        }
      }

      if (params.coins <= 0) {
        throw new AppError('عدد العملات المكتسبة يجب أن يكون أكبر من الصفر', 400);
      }

      const account = await this.getOrCreateAccount(params.customerId, tx);
      const balanceBefore = account.availableCoins;
      const balanceAfter = balanceBefore + params.coins;

      const rules = await RewardsConfigService.getRules();
      const isExpirationEnabled = await RewardsConfigService.isEnabled('rewards_coin_expiration.enabled');
      const expirationDays = params.expiresInDays ?? rules.defaultExpirationDays;
      let expiresAt: Date;
      if (!isExpirationEnabled || expirationDays <= 0) {
        expiresAt = new Date('2099-12-31T23:59:59.999Z');
      } else {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + expirationDays);
      }

      // 2. Create authoritative CoinTransaction ledger record
      const transaction = await tx.coinTransaction.create({
        data: {
          accountId: account.id,
          customerId: params.customerId,
          type: params.type,
          source: params.source,
          fundingSource: params.fundingSource ?? RewardFundingSource.PLATFORM,
          sellerId: params.sellerId,
          campaignId: params.campaignId,
          missionId: params.missionId,
          coins: params.coins,
          balanceBefore,
          balanceAfter,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          idempotencyKey: params.idempotencyKey,
          status: RewardTxStatus.COMPLETED,
          descriptionAr: params.descriptionAr,
          descriptionEn: params.descriptionEn,
          expiresAt,
          createdBy: params.createdBy ?? 'SYSTEM',
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        },
      });

      // 3. Create individual CoinLot for FIFO expiration management (§8, §9)
      await tx.coinLot.create({
        data: {
          accountId: account.id,
          customerId: params.customerId,
          initialCoins: params.coins,
          remainingCoins: params.coins,
          status: CoinLotStatus.ACTIVE,
          fundingSource: params.fundingSource ?? RewardFundingSource.PLATFORM,
          sellerId: params.sellerId,
          campaignId: params.campaignId,
          transactionId: transaction.id,
          expiresAt,
        },
      });

      // 4. Update materialized balances and lifetime stats on RewardAccount
      await tx.rewardAccount.update({
        where: { id: account.id },
        data: {
          availableCoins: balanceAfter,
          lifetimeEarned: { increment: params.coins },
        },
      });

      return { transaction, isDuplicate: false };
    };

    return externalTx ? execute(externalTx) : prisma.$transaction(execute);
  }

  /**
   * Debits coins using exact FIFO lot allocation (§8, §18).
   * Oldest-expiring eligible coins are depleted first.
   * Atomically prevents double-spending and unauthorized negative balances.
   */
  static async debitCoinsFIFO(params: DebitCoinsParams, externalTx?: any) {
    const execute = async (tx: any) => {
      // 1. Idempotency check (§58)
      if (params.idempotencyKey) {
        const existingTx = await tx.coinTransaction.findUnique({
          where: { idempotencyKey: params.idempotencyKey },
        });
        if (existingTx) {
          return { transaction: existingTx, isDuplicate: true };
        }
      }

      if (params.coins <= 0) {
        throw new AppError('عدد العملات المراد خصمها يجب أن يكون أكبر من الصفر', 400);
      }

      const account = await this.getOrCreateAccount(params.customerId, tx);
      const balanceBefore = account.availableCoins;

      const rules = await RewardsConfigService.getRules();
      const allowNegative = params.allowNegative || rules.negativeBalanceAllowed;

      if (!allowNegative && balanceBefore < params.coins) {
        throw new AppError(
          `رصيد العملات غير كافٍ. المتاح: ${balanceBefore}، المطلوب: ${params.coins}`,
          400,
          'INSUFFICIENT_COINS'
        );
      }

      const balanceAfter = balanceBefore - params.coins;

      // 2. FIFO Lot Depletion: Find active lots sorted ascending by expiration date (§8)
      const activeLots = await tx.coinLot.findMany({
        where: {
          customerId: params.customerId,
          status: CoinLotStatus.ACTIVE,
          remainingCoins: { gt: 0 },
        },
        orderBy: { expiresAt: 'asc' },
      });

      let remainingToDeduct = params.coins;
      for (const lot of activeLots) {
        if (remainingToDeduct <= 0) break;

        const deduction = Math.min(lot.remainingCoins, remainingToDeduct);
        const newRemaining = lot.remainingCoins - deduction;
        const newStatus = newRemaining === 0 ? CoinLotStatus.DEPLETED : CoinLotStatus.ACTIVE;

        await tx.coinLot.update({
          where: { id: lot.id },
          data: {
            remainingCoins: newRemaining,
            status: newStatus,
          },
        });

        remainingToDeduct -= deduction;
      }

      // 3. Create negative CoinTransaction record in immutable ledger
      const transaction = await tx.coinTransaction.create({
        data: {
          accountId: account.id,
          customerId: params.customerId,
          type: params.type,
          source: params.source,
          coins: -params.coins, // Negative for debit/redemption/expiration/reversal
          balanceBefore,
          balanceAfter,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          idempotencyKey: params.idempotencyKey,
          status: RewardTxStatus.COMPLETED,
          descriptionAr: params.descriptionAr,
          descriptionEn: params.descriptionEn,
          createdBy: params.createdBy ?? 'SYSTEM',
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        },
      });

      // 4. Update materialized balances and lifetime redeemed on RewardAccount
      await tx.rewardAccount.update({
        where: { id: account.id },
        data: {
          availableCoins: balanceAfter,
          lifetimeRedeemed:
            params.type === RewardTxType.REDEEM
              ? { increment: params.coins }
              : undefined,
          lifetimeExpired:
            params.type === RewardTxType.EXPIRE
              ? { increment: params.coins }
              : undefined,
        },
      });

      return { transaction, isDuplicate: false };
    };

    return externalTx ? execute(externalTx) : prisma.$transaction(execute);
  }
}
