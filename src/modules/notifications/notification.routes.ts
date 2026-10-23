import { SocketService } from '../../services/websocket/socket.service';
import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { notificationPreferenceService } from './services/notification-preference.service';
import { notificationTokenService } from './services/notification-token.service';
import { notificationTemplateService } from './services/notification-template.service';
import { notificationAnalyticsService } from './services/notification-analytics.service';
import { notificationDispatcher } from './services/notification-dispatcher';
import { NotificationEventFactory } from './events/domain-events';
import { NotificationCategory, NotificationPriority, NotificationChannel, AppType, normalizePriority } from './notification.types';
import { adminNotificationRouter } from './services/admin-notification-router.service';
import { smtpEmailProvider } from './providers/email.provider';
import { smsNotificationProvider } from './providers/sms.provider';
import { EmailTemplateKey } from './templates/email-templates';

const router = Router();
router.use(authenticate);

// ==============================================================================
// 1. NOTIFICATION CENTER (CUSTOMER / SELLER / ADMIN)
// ==============================================================================

// GET /api/v1/notifications — Paginated, filterable notifications (cursor & offset supported)
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cursor = (req.query.cursor as string | undefined)?.trim();
    const isExplicitPage = req.query.page !== undefined && !cursor;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));

    const category = req.query.category as string | undefined;
    const priority = req.query.priority as string | undefined;
    const recipientType = req.query.recipientType as string | undefined;
    const unreadOnly = req.query.unread === 'true';

    const userFilter: any = req.user!.role === 'ADMIN'
      ? { OR: [{ userId: req.user!.userId }, { recipientType: 'ADMIN' }] }
      : { userId: req.user!.userId };

    const where: any = { ...userFilter };
    if (recipientType && recipientType !== 'ALL') {
      where.recipientType = recipientType;
    }
    if (category && category !== 'ALL') {
      where.category = category;
    }
    if (unreadOnly) {
      where.isRead = false;
    }
    if (priority && priority !== 'ALL') {
      const norm = normalizePriority(priority);
      if (norm === 'P0') {
        where.priority = { in: ['P0', 'P0_CRITICAL', 'URGENT', 'CRITICAL'] };
      } else if (norm === 'P1') {
        where.priority = { in: ['P1', 'P1_HIGH', 'HIGH'] };
      } else if (norm === 'P2') {
        where.priority = { in: ['P2', 'P2_ROUTINE', 'NORMAL'] };
      } else if (norm === 'P3') {
        where.priority = { in: ['P3', 'P3_INFO', 'LOW', 'INFO'] };
      } else {
        where.priority = priority;
      }
    }

    let items: any[] = [];
    let hasNext = false;
    let nextCursor: string | null = null;
    let total = 0;
    let totalPages = 1;
    let page = 1;

    if (cursor) {
      // High-performance cursor-based pagination
      const fetched = await prisma.notification.findMany({
        where,
        take: limit + 1,
        skip: 1,
        cursor: { id: cursor },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      hasNext = fetched.length > limit;
      if (hasNext) fetched.pop();
      items = fetched;
      nextCursor = hasNext && items.length > 0 ? items[items.length - 1].id : null;
      total = items.length;
      totalPages = hasNext ? 2 : 1;
    } else if (isExplicitPage) {
      // Legacy offset-based pagination
      page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const skip = (page - 1) * limit;
      const [fetchedItems, countTotal] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: limit,
        }),
        prisma.notification.count({ where }),
      ]);
      items = fetchedItems;
      total = countTotal;
      totalPages = Math.ceil(total / limit) || 1;
      hasNext = page < totalPages;
      nextCursor = hasNext && items.length > 0 ? items[items.length - 1].id : null;
    } else {
      // First page in cursor-friendly mode (avoids slow count({ where }) scan)
      const fetched = await prisma.notification.findMany({
        where,
        take: limit + 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      hasNext = fetched.length > limit;
      if (hasNext) fetched.pop();
      items = fetched;
      nextCursor = hasNext && items.length > 0 ? items[items.length - 1].id : null;
      total = items.length;
      totalPages = hasNext ? 2 : 1;
    }

    const unreadCount = await prisma.notification.count({
      where: { ...userFilter, isRead: false },
    });

    ResponseUtil.success(res, {
      items,
      notifications: items,
      total,
      unreadCount,
      page,
      limit,
      totalPages,
      hasNext,
      nextCursor,
    });
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 1.1 ADMIN PREFERENCES & PRIORITY ROUTING (§4, §5, §7)
// ==============================================================================

// GET /api/v1/notifications/admin/preferences — Get current admin's comprehensive preferences
router.get('/admin/preferences', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin privileges required');
    const preferences = await notificationPreferenceService.getAdminPreferences(req.user!.userId);
    ResponseUtil.success(res, preferences);
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/notifications/admin/preferences — Update admin preferences
router.put('/admin/preferences', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin privileges required');
    const updated = await notificationPreferenceService.updateAdminPreferences(req.user!.userId, req.body);
    ResponseUtil.success(res, updated, 'Admin preferences updated successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/notifications/admin/mute — Temporarily mute non-P0 admin notifications
router.post('/admin/mute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin privileges required');
    const hours = parseInt(req.body.hours, 10) || 0;
    const result = await notificationPreferenceService.muteAdminNotifications(req.user!.userId, hours);
    ResponseUtil.success(res, result, hours > 0 ? `Notifications muted for ${hours} hours` : 'Notifications unmuted');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/notifications/admin/route-alert — Intelligently route alert via RBAC
router.post('/admin/route-alert', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin privileges required');
    const { eventType, category, priority, titleAr, titleEn, messageAr, messageEn, referenceId, incidentId, data } = req.body;
    if (!eventType || !titleAr || !messageAr) {
      return ResponseUtil.badRequest(res, 'eventType, titleAr, and messageAr are required');
    }
    const result = await adminNotificationRouter.routeAndDispatch({
      eventType,
      category,
      priority,
      titleAr,
      titleEn: titleEn || titleAr,
      messageAr,
      messageEn: messageEn || messageAr,
      referenceId,
      incidentId,
      data,
    });
    ResponseUtil.success(res, result, `Alert routed to ${result.recipientsCount} authorized administrators`);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/notifications/unread-count — Light & fast unread counter
router.get('/unread-count', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userFilter: any = req.user!.role === 'ADMIN'
      ? { OR: [{ userId: req.user!.userId }, { recipientType: 'ADMIN' }] }
      : { userId: req.user!.userId };
    const unreadCount = await prisma.notification.count({
      where: { ...userFilter, isRead: false },
    });
    ResponseUtil.success(res, { unreadCount });
  } catch (error) {
    next(error);
  }
});

// PATCH / PUT / POST /api/v1/notifications/read-all — Mark all as read
router.all('/read-all', async (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'PATCH' && req.method !== 'PUT' && req.method !== 'POST') return next();
  try {
    const userFilter: any = req.user!.role === 'ADMIN'
      ? { OR: [{ userId: req.user!.userId }, { recipientType: 'ADMIN' }] }
      : { userId: req.user!.userId };
    await prisma.notification.updateMany({
      where: { ...userFilter, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    try {
      SocketService.get()?.emitNotificationBadge(req.user!.userId, 0);
      SocketService.get()?.emitToUser(req.user!.userId, 'notification:read_all', {});
    } catch (_) {}
    ResponseUtil.success(res, null, 'All notifications marked as read');
  } catch (error) {
    next(error);
  }
});

// PATCH / PUT / POST /api/v1/notifications/:id/read — Mark single as read
router.all('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'PATCH' && req.method !== 'PUT' && req.method !== 'POST') return next();
  try {
    const id = String(req.params.id);
    const userFilter: any = req.user!.role === 'ADMIN'
      ? { OR: [{ userId: req.user!.userId }, { recipientType: 'ADMIN' }] }
      : { userId: req.user!.userId };
    const notif = await prisma.notification.updateMany({
      where: { id, ...userFilter },
      data: { isRead: true, readAt: new Date() },
    });

    if (notif.count === 0) {
      return ResponseUtil.notFound(res, 'Notification not found');
    }

    try {
      const remainingUnread = await prisma.notification.count({
        where: { ...userFilter, isRead: false },
      });
      SocketService.get()?.emitNotificationBadge(req.user!.userId, remainingUnread);
      SocketService.get()?.emitToUser(req.user!.userId, 'notification:read', { id, unreadCount: remainingUnread });
    } catch (_) {}
    ResponseUtil.success(res, { id, isRead: true });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/notifications/:id — Delete/Archive notification
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const deleted = await prisma.notification.deleteMany({
      where: { id, userId: req.user!.userId },
    });
    if (deleted.count === 0) {
      return ResponseUtil.notFound(res, 'Notification not found');
    }
    ResponseUtil.success(res, null, 'Notification deleted');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 2. NOTIFICATION PREFERENCES & QUIET HOURS
// ==============================================================================

// GET /api/v1/notifications/preferences
router.get('/preferences', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const preferences = await notificationPreferenceService.getUserPreferences(req.user!.userId);
    ResponseUtil.success(res, preferences);
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/notifications/preferences — Update category preference
router.put('/preferences', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category, pushEnabled, emailEnabled, smsEnabled, inAppEnabled, quietHoursEnabled, quietHoursStart, quietHoursEnd, timezone } = req.body;
    if (!category) {
      return ResponseUtil.badRequest(res, 'Category is required');
    }

    const updated = await notificationPreferenceService.updateCategoryPreference(
      req.user!.userId,
      category,
      {
        pushEnabled,
        emailEnabled,
        smsEnabled,
        inAppEnabled,
        quietHoursEnabled,
        quietHoursStart,
        quietHoursEnd,
        timezone,
      }
    );
    ResponseUtil.success(res, updated, 'Notification preferences updated');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 3. DEVICE REGISTRY & TOKEN MANAGEMENT
// ==============================================================================

// POST /api/v1/notifications/devices — Register device & token
router.post('/devices', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      deviceId,
      deviceToken,
      platform,
      appType,
      pushProvider,
      browserInfo,
      appVersion,
      locale,
      timezone,
      permissionStatus,
    } = req.body;

    if (!deviceId || !deviceToken || !platform) {
      return ResponseUtil.badRequest(res, 'deviceId, deviceToken, and platform are required');
    }

    const device = await notificationTokenService.registerDevice({
      userId: req.user!.userId,
      deviceId,
      deviceToken,
      platform,
      appType: appType || (req.user!.role === 'SELLER' ? AppType.SELLER : req.user!.role === 'ADMIN' ? AppType.ADMIN : AppType.CUSTOMER),
      pushProvider,
      browserInfo,
      appVersion,
      locale,
      timezone,
      permissionStatus,
    });

    ResponseUtil.success(res, device, 'Device registered successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/notifications/devices/refresh — Device heartbeat
router.post('/devices/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { deviceId } = req.body;
    if (deviceId) {
      await notificationTokenService.touchDevice(req.user!.userId, deviceId);
    }
    ResponseUtil.success(res, null, 'Device heartbeat refreshed');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/notifications/devices/:deviceId — Unregister device on logout
router.delete('/devices/:deviceId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceId = String(req.params.deviceId);
    await notificationTokenService.deactivateDevice(req.user!.userId, deviceId);
    ResponseUtil.success(res, null, 'Device unregistered');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/notifications/token — Backward compatible FCM token registration
router.post('/token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, device = 'web' } = req.body;
    if (!token) return ResponseUtil.badRequest(res, 'token is required');

    await notificationTokenService.registerDevice({
      userId: req.user!.userId,
      deviceId: `device_${req.user!.userId}_${device}`,
      deviceToken: token,
      platform: device.toUpperCase(),
      appType: req.user!.role === 'SELLER' ? AppType.SELLER : req.user!.role === 'ADMIN' ? AppType.ADMIN : AppType.CUSTOMER,
    });

    ResponseUtil.success(res, null, 'Push notification token registered');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 4. ADMIN NOTIFICATION PLATFORM MANAGEMENT
// ==============================================================================

// GET /api/v1/notifications/admin/overview
router.get('/admin/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin access required');
    const overview = await notificationAnalyticsService.getOverviewStats();
    ResponseUtil.success(res, overview);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/notifications/admin/audience-preview
router.get('/admin/audience-preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin access required');
    const target = (req.query.target as string) || 'ALL';
    const preview = await notificationAnalyticsService.getAudiencePreview(target);
    ResponseUtil.success(res, preview);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/notifications/admin/deliveries
router.get('/admin/deliveries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin access required');
    const logs = await notificationAnalyticsService.getDeliveryLogs();
    ResponseUtil.success(res, logs);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/notifications/admin/failures — Dead-Letter Queue
router.get('/admin/failures', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin access required');
    const failures = await notificationAnalyticsService.getFailedDeliveries();
    ResponseUtil.success(res, failures);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/notifications/admin/templates
router.get('/admin/templates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin access required');
    const templates = await notificationTemplateService.listTemplates();
    ResponseUtil.success(res, templates);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/notifications/admin/templates
router.post('/admin/templates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin access required');
    const template = await notificationTemplateService.upsertTemplate(req.body);
    ResponseUtil.success(res, template, 'Notification template saved successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/notifications/admin/kill-switch — Emergency kill switch toggle
router.post('/admin/kill-switch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin access required');
    const { active } = req.body;
    notificationDispatcher.setEmergencyKillSwitch(!!active);
    ResponseUtil.success(res, { active: notificationDispatcher.getEmergencyKillSwitch() }, `Emergency kill switch ${active ? 'activated' : 'deactivated'}`);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/notifications/admin/test-send — Test send to admin's own devices
router.post('/admin/test-send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'ADMIN') return ResponseUtil.forbidden(res, 'Admin access required');
    const { titleAr, titleEn, bodyAr, bodyEn, category = 'ADMIN', priority = 'HIGH', channels } = req.body;

    const event = NotificationEventFactory.adminAlertEvent({
      eventType: 'ADMIN_ALERT',
      recipientId: req.user!.userId,
      titleAr: titleAr || 'إشعار تجريبي من منصة سوقناا',
      titleEn: titleEn || 'Test notification from SOUQNAA platform',
      messageAr: bodyAr || 'هذا إشعار تجريبي للتحقق من سلامة قنوات التوصيل.',
      messageEn: bodyEn || 'This is a test notification verifying delivery channels.',
      priority: priority || 'HIGH',
      data: {
        category,
        deepLink: 'souqnaa://admin/notifications',
      },
    });

    const resolvedChannels = channels && Array.isArray(channels) && channels.length > 0
      ? channels
      : [NotificationChannel.PUSH, NotificationChannel.IN_APP, NotificationChannel.REAL_TIME];
    event.channelsOverride = resolvedChannels;

    const result = await notificationDispatcher.dispatch(event);
    ResponseUtil.success(res, result, 'Test notification dispatched');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/notifications/test-email — Test sending any of the 14 email templates
router.post('/test-email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { template = 'WELCOME', email, locale = 'ar', data = {} } = req.body;
    let targetEmail = email;
    if (!targetEmail) {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { email: true },
      });
      targetEmail = user?.email;
    }

    if (!targetEmail) {
      return ResponseUtil.badRequest(res, 'Target email is required');
    }

    const result = await smtpEmailProvider.sendTemplate(
      targetEmail,
      template as EmailTemplateKey,
      locale,
      {
        ...data,
        name: data.name || 'عميل سوقناا',
        userId: req.user!.userId,
      }
    );

    ResponseUtil.success(res, result, `Test email for template [${template}] processed successfully`);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/notifications/test-sms — Test sending OTP or Marketing SMS with compliance check
router.post('/test-sms', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone, useCase = 'OTP', message, otpCode = '123456', locale = 'ar' } = req.body;
    let targetPhone = phone;
    if (!targetPhone) {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { phone: true },
      });
      targetPhone = user?.phone;
    }

    if (!targetPhone) {
      return ResponseUtil.badRequest(res, 'Target phone number is required');
    }

    let result;
    if (useCase === 'OTP') {
      result = await smsNotificationProvider.sendOtpSms(targetPhone, otpCode, locale);
    } else {
      result = await smsNotificationProvider.send({
        recipientPhone: targetPhone,
        recipientId: req.user!.userId,
        content: {
          titleAr: 'إشعار سوقناا',
          titleEn: 'SOUQNAA Alert',
          bodyAr: message || 'عرض حصري من سوقناا: خصومات كبرى بانتظارك!',
          bodyEn: message || 'Exclusive offer from SOUQNAA: Huge discounts await!',
        },
        metadata: {
          smsUseCase: useCase,
          useCase,
        },
      });
    }

    ResponseUtil.success(res, result, `Test SMS [${useCase}] processed successfully`);
  } catch (error) {
    next(error);
  }
});

export const notificationRoutes = router;
