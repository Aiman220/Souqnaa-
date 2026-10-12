import { randomUUID } from 'crypto';
import { prisma } from '../../../database/prisma';
import { NotificationType } from '@prisma/client';
import { SocketService } from '../../../services/websocket/socket.service';
import { notificationDispatcher } from '../../notifications/services/notification-dispatcher';
import {
  DomainNotificationEvent,
  NotificationCategory,
  NotificationPriority,
  AppType,
} from '../../notifications/notification.types';

export class RewardsNotificationService {
  private static async createAndEmit(params: {
    userId: string;
    titleAr: string;
    titleEn: string;
    bodyAr: string;
    bodyEn: string;
    type: NotificationType;
    data?: Record<string, any>;
  }) {
    try {
      const event: DomainNotificationEvent = {
        eventId: randomUUID(),
        idempotencyKey: `rewards_${params.userId}_${params.type}_${Date.now()}`,
        eventType: params.type,
        category: NotificationCategory.REWARDS,
        priority: NotificationPriority.NORMAL,
        recipientId: params.userId,
        recipientType: AppType.CUSTOMER,
        entityType: 'rewards',
        entityId: 'coins',
        data: {
          titleAr: params.titleAr,
          titleEn: params.titleEn,
          bodyAr: params.bodyAr,
          bodyEn: params.bodyEn,
          ...(params.data || {}),
        },
        bypassQuietHours: false,
        bypassRateLimit: false,
        createdAt: new Date(),
      };

      const result = await notificationDispatcher.dispatch(event);

      // Emit real-time socket event if user is connected
      const socket = SocketService.get();
      if (socket) {
        socket.emitToUser(params.userId, 'rewards:updated', {
          type: params.type,
          data: params.data,
        });
      }

      return result.notificationId;
    } catch (e) {
      console.error('[RewardsNotificationService] Failed to dispatch reward notification:', e);
      return null;
    }
  }

  static async notifyCoinsEarned(params: {
    customerId: string;
    coins: number;
    reasonAr: string;
    reasonEn: string;
    referenceId?: string;
  }) {
    return this.createAndEmit({
      userId: params.customerId,
      titleAr: '🎉 عملات سوقناا جديدة!',
      titleEn: '🎉 SOUQNAA Coins Earned!',
      bodyAr: `حصلت على ${params.coins} عملة من عملات سوقناا ${params.reasonAr}`,
      bodyEn: `You earned ${params.coins} SOUQNAA Coins ${params.reasonEn}`,
      type: NotificationType.REWARD_COINS_EARNED,
      data: { coins: params.coins, referenceId: params.referenceId },
    });
  }

  static async notifyCoinsRedeemed(params: {
    customerId: string;
    coins: number;
    orderNumber: string;
    discountAmount: number;
  }) {
    return this.createAndEmit({
      userId: params.customerId,
      titleAr: 'تم استخدام عملات سوقناا',
      titleEn: 'SOUQNAA Coins Redeemed',
      bodyAr: `تم خصم ${params.coins} عملة مقابل خصم ${params.discountAmount} ر.ي في الطلب #${params.orderNumber}`,
      bodyEn: `Redeemed ${params.coins} coins for ${params.discountAmount} YER discount on order #${params.orderNumber}`,
      type: NotificationType.REWARD_COINS_REDEEMED,
      data: { coins: params.coins, orderNumber: params.orderNumber, discountAmount: params.discountAmount },
    });
  }

  static async notifyCheckinClaimed(params: {
    customerId: string;
    coins: number;
    streak: number;
  }) {
    return this.createAndEmit({
      userId: params.customerId,
      titleAr: 'تسجيل دخول ناجح! 🌟',
      titleEn: 'Daily Check-in Claimed! 🌟',
      bodyAr: `حصلت على ${params.coins} عملة اليوم! واصل سلسلة تسجيل الدخول (${params.streak} أيام)`,
      bodyEn: `You claimed ${params.coins} coins today! Keep your streak going (${params.streak} days)`,
      type: NotificationType.REWARD_DAILY_CHECKIN,
      data: { coins: params.coins, streak: params.streak },
    });
  }

  static async notifyMissionCompleted(params: {
    customerId: string;
    missionTitleAr: string;
    missionTitleEn: string;
    rewardCoins: number;
  }) {
    return this.createAndEmit({
      userId: params.customerId,
      titleAr: 'مهمة مكتملة! 🎯',
      titleEn: 'Mission Completed! 🎯',
      bodyAr: `تهانينا! أكملت مهمة "${params.missionTitleAr}". افتح مركز المكافآت لاستلام ${params.rewardCoins} عملة!`,
      bodyEn: `Congrats! You completed "${params.missionTitleEn}". Open Rewards Center to claim ${params.rewardCoins} coins!`,
      type: NotificationType.REWARD_MISSION_COMPLETED,
      data: { rewardCoins: params.rewardCoins },
    });
  }

  static async notifyReferralReward(params: {
    customerId: string;
    coins: number;
    isReferrer: boolean;
  }) {
    return this.createAndEmit({
      userId: params.customerId,
      titleAr: params.isReferrer ? 'مكافأة دعوة صديق! 🎁' : 'مكافأة كود الدعوة الترحيبية! 🎁',
      titleEn: params.isReferrer ? 'Referral Reward Earned! 🎁' : 'Welcome Referral Bonus! 🎁',
      bodyAr: params.isReferrer
        ? `حصلت على ${params.coins} عملة بعد إتمام صديقك لأول طلب له!`
        : `حصلت على ${params.coins} عملة كمكافأة ترحيبية لاستخدام كود الدعوة!`,
      bodyEn: params.isReferrer
        ? `You received ${params.coins} coins because your invited friend completed their first order!`
        : `You received ${params.coins} welcome coins for using a referral code!`,
      type: NotificationType.REWARD_REFERRAL_BONUS,
      data: { coins: params.coins, isReferrer: params.isReferrer },
    });
  }

  static async notifyCoinsExpiringSoon(params: {
    customerId: string;
    coins: number;
    daysRemaining: number;
  }) {
    return this.createAndEmit({
      userId: params.customerId,
      titleAr: '⏰ عملاتك ستنتهي قريباً',
      titleEn: '⏰ Your Coins Are Expiring Soon',
      bodyAr: `تنبيه: ${params.coins} عملة من عملات سوقناا ستنتهي خلال ${params.daysRemaining} ${params.daysRemaining === 1 ? 'يوم' : 'أيام'}. استخدمها في طلبك القادم!`,
      bodyEn: `Notice: ${params.coins} SOUQNAA Coins will expire in ${params.daysRemaining} days. Use them on your next order!`,
      type: NotificationType.REWARD_COINS_EXPIRING,
      data: { coins: params.coins, daysRemaining: params.daysRemaining },
    });
  }

  static async notifyCoinsReversed(params: {
    customerId: string;
    coins: number;
    reasonAr: string;
    reasonEn: string;
  }) {
    return this.createAndEmit({
      userId: params.customerId,
      titleAr: 'تعديل في رصيد العملات',
      titleEn: 'Coin Balance Adjustment',
      bodyAr: `تم خصم ${params.coins} عملة ${params.reasonAr}`,
      bodyEn: `Deducted ${params.coins} coins ${params.reasonEn}`,
      type: NotificationType.REWARD_COINS_REVERSED,
      data: { coins: params.coins },
    });
  }

  static async notifyCoinsExpired(params: {
    customerId: string;
    coins: number;
  }) {
    return this.createAndEmit({
      userId: params.customerId,
      titleAr: 'انتهاء صلاحية عملات',
      titleEn: 'Coins Expired',
      bodyAr: `انتهت صلاحية ${params.coins} عملة من عملات سوقناا لعدم استخدامها خلال المدة المحددة`,
      bodyEn: `${params.coins} SOUQNAA Coins have expired due to inactivity`,
      type: NotificationType.REWARD_COINS_EXPIRED,
      data: { coins: params.coins },
    });
  }
}
