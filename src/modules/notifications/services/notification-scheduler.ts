import { prisma } from '../../../database/prisma';
import {
  DomainNotificationEvent,
  NotificationCategory,
  NotificationPriority,
  AppType,
} from '../notification.types';
import { notificationDispatcher } from './notification-dispatcher';
import { randomUUID } from 'crypto';

import { notificationDigestService } from './notification-digest.service';

export class NotificationScheduler {
  private static instance: NotificationScheduler;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  static get(): NotificationScheduler {
    if (!NotificationScheduler.instance) {
      NotificationScheduler.instance = new NotificationScheduler();
    }
    return NotificationScheduler.instance;
  }

  private lastRetentionCheck = 0;
  private RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  start(intervalMs = 30000): void {
    if (this.intervalTimer) return;
    this.intervalTimer = setInterval(() => {
      this.processScheduledCampaigns().catch((err) => {
        console.error('[NotificationScheduler] Worker execution error:', err);
      });
      // Routine P2 admin digest aggregation (§3, §5, §6)
      notificationDigestService.processRoutineDigests().catch((err) => {
        console.error('[NotificationScheduler] Digest processing error:', err);
      });
      // Routine dispute SLA deadline monitor (36h warning & 48h auto-escalate) (§Phase 5)
      import('../../disputes/dispute.service').then(({ DisputeService }) => {
        DisputeService.checkDisputeDeadlines().catch((err) => {
          console.error('[NotificationScheduler] Dispute deadline check error:', err);
        });
      }).catch(() => {});
      // Safe configurable retention cleaner (§10)
      const now = Date.now();
      if (now - this.lastRetentionCheck > this.RETENTION_INTERVAL_MS) {
        this.lastRetentionCheck = now;
        this.applyRetentionPolicy().catch((err) => {
          console.error('[NotificationScheduler] Retention cleaner error:', err);
        });
      }
    }, intervalMs);
    console.log('[NotificationScheduler] Started scheduled notification worker cycle.');
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Process due scheduled campaigns in batches.
   */
  async processScheduledCampaigns(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const now = new Date();
      const dueCampaigns = await prisma.broadcastCampaign.findMany({
        where: {
          status: 'SCHEDULED',
          scheduledAt: { lte: now },
        },
        take: 5,
      });

      for (const campaign of dueCampaigns) {
        await this.executeBroadcastCampaign(campaign);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Executes audience broadcast in manageable chunks.
   */
  async executeBroadcastCampaign(campaign: {
    id: string;
    titleAr: string;
    titleEn?: string | null;
    bodyAr: string;
    bodyEn?: string | null;
    target: string;
  }): Promise<number> {
    console.log(`[NotificationScheduler] Executing broadcast campaign: ${campaign.id} (${campaign.titleAr})`);

    let roleFilter: any = {};
    if (campaign.target === 'CUSTOMERS') {
      roleFilter = { role: 'CUSTOMER' };
    } else if (campaign.target === 'SELLERS') {
      roleFilter = { role: 'SELLER' };
    } else {
      // 'ALL' broadcast targets customers and sellers. Admins are excluded from consumer/store promotions.
      roleFilter = { role: { in: ['CUSTOMER', 'SELLER'] } };
    }

    const users = await prisma.user.findMany({
      where: roleFilter,
      select: { id: true, role: true },
    });

    let sentCount = 0;
    const BATCH_SIZE = 50;

    const customerDeepLink = 'souqnaa://home';
    const sellerDeepLink = 'souqnaa://seller/marketing';

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        batch.map((u) => {
          const isSellerUser = u.role === 'SELLER';
          const targetDeepLink = isSellerUser ? sellerDeepLink : customerDeepLink;
          const event: DomainNotificationEvent = {
            eventId: randomUUID(),
            idempotencyKey: `broadcast_${campaign.id}_${u.id}`,
            eventType: 'BROADCAST_CAMPAIGN',
            category: NotificationCategory.PROMOTION,
            priority: NotificationPriority.NORMAL,
            recipientId: u.id,
            recipientType: isSellerUser ? AppType.SELLER : AppType.CUSTOMER,
            entityType: 'BROADCAST_CAMPAIGN',
            entityId: campaign.id,
            data: {
              titleAr: campaign.titleAr,
              titleEn: campaign.titleEn || campaign.titleAr,
              bodyAr: campaign.bodyAr,
              bodyEn: campaign.bodyEn || campaign.bodyAr,
              campaignId: campaign.id,
              deepLink: targetDeepLink,
            },
            bypassQuietHours: false,
            bypassRateLimit: true, // Admin mass broadcasts bypass individual rate limit
            createdAt: new Date(),
          };
          return notificationDispatcher.dispatch(event);
        })
      );
      sentCount += batch.length;
    }

    try {
      await prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: {
          status: 'SENT',
          sentCount,
          updatedAt: new Date(),
        },
      });
    } catch (_) {}

    console.log(`[NotificationScheduler] Broadcast campaign ${campaign.id} completed. Sent to ${sentCount} users.`);
    return sentCount;
  }

  /**
   * Applies configurable retention policy (§10).
   * Safe cleanup of ephemeral marketing and system notifications older than retentionDays.
   * STRICT GUARANTEE: Never automatically deletes ORDER, PAYMENT, REFUND, DISPUTE, WALLET, or SECURITY history!
   */
  async applyRetentionPolicy(retentionDays = parseInt(process.env.NOTIFICATION_RETENTION_DAYS || '90', 10)): Promise<number> {
    const days = Math.max(7, retentionDays);
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const ephemeralCategories = [
      'PROMOTION',
      'FLASH_SALE',
      'MEGA_CAMPAIGN',
      'PRICE_ALERT',
      'STOCK_ALERT',
      'SYSTEM',
      'BROADCAST_CAMPAIGN',
    ];

    const protectedCategories = [
      'ORDER',
      'PAYMENT',
      'REFUND',
      'DISPUTE',
      'WALLET',
      'SECURITY',
    ];

    try {
      const deleted = await prisma.notification.deleteMany({
        where: {
          createdAt: { lt: cutoffDate },
          isRead: true, // Only purge already read notifications
          category: { in: ephemeralCategories, notIn: protectedCategories },
        },
      });

      if (deleted.count > 0) {
        console.log(`[NotificationScheduler] [retention_pruned] Pruned ${deleted.count} read ephemeral notifications older than ${days} days.`);
      }
      return deleted.count;
    } catch (err) {
      console.error('[NotificationScheduler] Retention policy cleanup error:', err);
      return 0;
    }
  }
}

export const notificationScheduler = NotificationScheduler.get();
