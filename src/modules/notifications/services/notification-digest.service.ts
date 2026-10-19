import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { notificationPreferenceService } from './notification-preference.service';
import { fcmPushProvider } from '../providers/push.provider';
import { notificationTokenService } from './notification-token.service';
import { NotificationCategory, NotificationPriority, AppType } from '../notification.types';

export class NotificationDigestService {
  private static instance: NotificationDigestService;
  private isProcessing = false;

  static get(): NotificationDigestService {
    if (!NotificationDigestService.instance) {
      NotificationDigestService.instance = new NotificationDigestService();
    }
    return NotificationDigestService.instance;
  }

  /**
   * Processes routine P2 notification aggregation into 30-minute digests (§3, §5, §6).
   */
  async processRoutineDigests(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    let digestsSent = 0;
    try {
      // 1. Get all active admin users
      const admins = await prisma.user.findMany({
        where: { role: 'ADMIN', isActive: true },
        select: { id: true, email: true },
      });

      const now = Date.now();

      for (const admin of admins) {
        try {
          const prefs = await notificationPreferenceService.getAdminPreferences(admin.id);
          if (!prefs.p2DigestEnabled || prefs.p2InstantPush) {
            continue;
          }

          const intervalMinutes = prefs.p2DigestIntervalMinutes || 30;
          const intervalMs = intervalMinutes * 60 * 1000;
          const lastDigestKey = `admin:last_digest:${admin.id}`;
          const lastDigestTs = Number(await redis.get(lastDigestKey)) || 0;

          if (now - lastDigestTs < intervalMs) {
            continue; // Not yet time for next digest
          }

          // Fetch un-summarized P2 routine notifications from the last interval
          const windowStart = new Date(now - intervalMs * 2);
          const pendingItems = await prisma.notification.findMany({
            where: {
              userId: admin.id,
              recipientType: 'ADMIN',
              priority: 'P2',
              createdAt: { gte: windowStart },
              OR: [
                { metadata: null },
                { metadata: { not: { contains: '"digestSent":true' } } },
              ],
            },
            take: 50,
            orderBy: { createdAt: 'desc' },
          });

          if (pendingItems.length < 2) {
            // No aggregation needed if fewer than 2 items
            continue;
          }

          // Build summary counts by category
          const categoryCounts: Record<string, number> = {};
          for (const item of pendingItems) {
            const cat = item.category || 'SYSTEM';
            categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
          }

          const breakdownPartsAr: string[] = [];
          const breakdownPartsEn: string[] = [];

          if (categoryCounts['SELLER']) {
            breakdownPartsAr.push(`${categoryCounts['SELLER']} طلب/تنبيه تجار`);
            breakdownPartsEn.push(`${categoryCounts['SELLER']} seller requests`);
          }
          if (categoryCounts['ORDER']) {
            breakdownPartsAr.push(`${categoryCounts['ORDER']} نشاط طلبات`);
            breakdownPartsEn.push(`${categoryCounts['ORDER']} order updates`);
          }
          if (categoryCounts['PAYMENT'] || categoryCounts['WALLET']) {
            const count = (categoryCounts['PAYMENT'] || 0) + (categoryCounts['WALLET'] || 0);
            breakdownPartsAr.push(`${count} عمليات إيداع/دفع`);
            breakdownPartsEn.push(`${count} payments/deposits`);
          }
          if (categoryCounts['SYSTEM']) {
            breakdownPartsAr.push(`${categoryCounts['SYSTEM']} تقارير نظام`);
            breakdownPartsEn.push(`${categoryCounts['SYSTEM']} system reports`);
          }

          const detailAr = breakdownPartsAr.length > 0 ? breakdownPartsAr.join('، ') : `${pendingItems.length} تنبيهات دورية`;
          const detailEn = breakdownPartsEn.length > 0 ? breakdownPartsEn.join(', ') : `${pendingItems.length} routine alerts`;

          const titleAr = `ملخص العمليات الدورية (${pendingItems.length} تنبيه جديد)`;
          const titleEn = `Routine Operations Digest (${pendingItems.length} alerts)`;
          const bodyAr = `يتضمن ملخص الفترة: ${detailAr}. اضغط لفتح القائمة المفلترة.`;
          const bodyEn = `Summary includes: ${detailEn}. Tap to open filtered admin alerts.`;

          // Mark items as digested
          const itemIds = pendingItems.map((p) => p.id);
          for (const item of pendingItems) {
            let metaObj: any = {};
            try {
              if (item.metadata) metaObj = JSON.parse(item.metadata);
            } catch (_) {}
            metaObj.digestSent = true;
            metaObj.digestAt = new Date().toISOString();

            await prisma.notification.update({
              where: { id: item.id },
              data: { metadata: JSON.stringify(metaObj) },
            });
          }

          // Get active admin device tokens
          const devices = await notificationTokenService.getActiveDevices(admin.id, AppType.ADMIN);
          const fcmTokens = devices.map((d) => d.deviceToken).filter(Boolean);

          if (fcmTokens.length > 0) {
            await fcmPushProvider.send({
              recipientId: admin.id,
              deviceTokens: fcmTokens,
              category: NotificationCategory.ADMIN,
              priority: NotificationPriority.P2_ROUTINE,
              content: {
                titleAr,
                titleEn,
                bodyAr,
                bodyEn,
                deepLink: 'souqnaa://admin/notifications?priority=P2',
              },
              data: {
                eventType: 'ROUTINE_SUMMARY_DIGEST',
                digestItemCount: pendingItems.length,
                soundEnabled: false, // Routine summaries are always silent (§3)
                deepLink: 'souqnaa://admin/notifications?priority=P2',
              },
            });
          }

          await redis.set(lastDigestKey, String(now), intervalMinutes * 120);
          digestsSent++;

          console.log(
            `[NotificationDigestService] Dispatched 30-min routine digest to admin ${admin.id} (${pendingItems.length} items aggregated).`
          );
        } catch (err: any) {
          console.error(`[NotificationDigestService] Error generating digest for admin ${admin.id}:`, err.message);
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return digestsSent;
  }
}

export const notificationDigestService = NotificationDigestService.get();
