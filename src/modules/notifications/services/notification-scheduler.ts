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
    if (campaign.target === 'CUSTOMERS') roleFilter = { role: 'CUSTOMER' };
    if (campaign.target === 'SELLERS') roleFilter = { role: 'SELLER' };

    const users = await prisma.user.findMany({
      where: roleFilter,
      select: { id: true, role: true },
    });

    let sentCount = 0;
    const BATCH_SIZE = 50;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        batch.map((u) => {
          const event: DomainNotificationEvent = {
            eventId: randomUUID(),
            idempotencyKey: `broadcast_${campaign.id}_${u.id}`,
            eventType: 'BROADCAST_CAMPAIGN',
            category: NotificationCategory.PROMOTION,
            priority: NotificationPriority.NORMAL,
            recipientId: u.id,
            recipientType: u.role === 'SELLER' ? AppType.SELLER : AppType.CUSTOMER,
            entityType: 'campaign',
            entityId: campaign.id,
            data: {
              titleAr: campaign.titleAr,
              titleEn: campaign.titleEn || campaign.titleAr,
              bodyAr: campaign.bodyAr,
              bodyEn: campaign.bodyEn || campaign.bodyAr,
              campaignId: campaign.id,
              deepLink: u.role === 'SELLER' ? 'souqnaa://seller/marketing' : `souqnaa://campaigns/${campaign.id}`,
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
}

export const notificationScheduler = NotificationScheduler.get();
