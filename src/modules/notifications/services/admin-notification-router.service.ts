import { AdminRbacService, SystemRole } from '../../admin/admin-rbac.service';
import {
  DomainNotificationEvent,
  NotificationCategory,
  NotificationPriority,
  AppType,
  normalizePriority,
} from '../notification.types';
import { NotificationEventFactory } from '../events/domain-events';
import { notificationDispatcher } from './notification-dispatcher';
import { notificationPreferenceService } from './notification-preference.service';

export interface RouteAdminAlertOptions {
  eventType: string;
  category?: NotificationCategory;
  priority?: NotificationPriority | string;
  titleAr: string;
  titleEn: string;
  messageAr: string;
  messageEn: string;
  referenceId?: string;
  incidentId?: string;
  isResolved?: boolean;
  requiredPermission?: string;
  requiredRole?: string;
  data?: Record<string, any>;
}

export class AdminNotificationRouterService {
  private static instance: AdminNotificationRouterService;

  static get(): AdminNotificationRouterService {
    if (!AdminNotificationRouterService.instance) {
      AdminNotificationRouterService.instance = new AdminNotificationRouterService();
    }
    return AdminNotificationRouterService.instance;
  }

  /**
   * Resolves the required system permission based on the event type and category.
   */
  public resolveRequiredPermission(eventType: string, category?: NotificationCategory): string {
    const et = eventType.toUpperCase();
    const cat = category ? category.toString().toUpperCase() : '';

    // Security & Data Integrity
    if (
      et.includes('SECURITY') ||
      et.includes('DATA_INTEGRITY') ||
      et.includes('OUTAGE') ||
      cat === 'SECURITY'
    ) {
      return 'settings:manage'; // Super Admins / Platform Ops
    }

    // Finance, Settlements & Wallet transfers
    if (
      et.includes('SETTLEMENT') ||
      et.includes('DEBT') ||
      et.includes('WITHDRAWAL') ||
      et.includes('DEPOSIT') ||
      cat === 'FINANCE' ||
      cat === 'PAYMENT' ||
      cat === 'WALLET'
    ) {
      return 'finance:view';
    }

    // Refunds & Customer Disputes
    if (et.includes('DISPUTE') || et.includes('REFUND') || cat === 'REFUND') {
      return 'disputes:resolve';
    }

    // Sellers & Onboarding
    if (et.includes('SELLER') || cat === 'SELLER') {
      return 'sellers:approve';
    }

    // Orders & Logistics
    if (et.includes('ORDER') || cat === 'ORDER' || cat === 'DELIVERY') {
      return 'orders:view';
    }

    // Default to general platform settings/ops
    return 'dashboard:view';
  }

  /**
   * Intelligently routes and dispatches an admin alert to all and only authorized administrators.
   * Enforces RBAC permissions and respects individual category subscriptions.
   */
  async routeAndDispatch(options: RouteAdminAlertOptions): Promise<{
    recipientsCount: number;
    recipientIds: string[];
  }> {
    const requiredPermission =
      options.requiredPermission ||
      this.resolveRequiredPermission(options.eventType, options.category);

    // 1. Authoritative RBAC check: get all active admin user IDs possessing this permission
    const authorizedAdminIds = await AdminRbacService.getAdminUserIdsWithPermission(requiredPermission);

    if (authorizedAdminIds.length === 0) {
      console.warn(
        `[AdminNotificationRouter] No active administrator possesses permission "${requiredPermission}" for event "${options.eventType}".`
      );
      return { recipientsCount: 0, recipientIds: [] };
    }

    const priority = normalizePriority(options.priority || 'P1');
    const targetedAdminIds: string[] = [];

    // 2. Evaluate recipient-level preferences and subscriptions
    for (const adminId of authorizedAdminIds) {
      // P0 critical incidents always reach every authorized admin (cannot be muted/unsubscribed)
      if (priority !== 'P0') {
        const adminPrefs = await notificationPreferenceService.getAdminPreferences(adminId);

        // Check if admin has temporarily muted notifications
        if (adminPrefs.mutedUntil) {
          const muteExpiry = new Date(adminPrefs.mutedUntil);
          if (muteExpiry > new Date()) {
            console.log(`[AdminNotificationRouter] Admin ${adminId} notification muted until ${adminPrefs.mutedUntil}`);
            continue;
          }
        }

        // Check category subscription (if event has a specific category)
        const eventCategory = options.category || NotificationCategory.ADMIN;
        if (
          adminPrefs.subscribedCategories &&
          adminPrefs.subscribedCategories.length > 0 &&
          !adminPrefs.subscribedCategories.includes(eventCategory) &&
          !adminPrefs.subscribedCategories.includes('ALL') &&
          !adminPrefs.subscribedCategories.includes(NotificationCategory.ADMIN)
        ) {
          console.log(`[AdminNotificationRouter] Admin ${adminId} not subscribed to category ${eventCategory}`);
          continue;
        }
      }

      targetedAdminIds.push(adminId);
    }

    // 3. Dispatch to each targeted admin through the centralized notification pipeline
    const dispatchPromises = targetedAdminIds.map((adminId) => {
      const event: DomainNotificationEvent = NotificationEventFactory.adminAlertEvent({
        eventType: options.eventType,
        recipientId: adminId,
        titleAr: options.titleAr,
        titleEn: options.titleEn,
        messageAr: options.messageAr,
        messageEn: options.messageEn,
        priority: options.priority,
        referenceId: options.referenceId,
        incidentId: options.incidentId,
        isResolved: options.isResolved,
        requiredPermission,
        data: {
          ...(options.data || {}),
          category: options.category || NotificationCategory.ADMIN,
          requiredPermission,
        },
      });

      return notificationDispatcher.dispatch(event);
    });

    await Promise.allSettled(dispatchPromises);

    console.log(
      `[AdminNotificationRouter] Routed event "${options.eventType}" (${priority}) to ${targetedAdminIds.length} authorized admins.`
    );

    return {
      recipientsCount: targetedAdminIds.length,
      recipientIds: targetedAdminIds,
    };
  }
}

export const adminNotificationRouter = AdminNotificationRouterService.get();
