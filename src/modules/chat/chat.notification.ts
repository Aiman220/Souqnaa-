import { prisma } from '../../database/prisma';
import { SocketService } from '../../services/websocket/socket.service';
import { notificationDispatcher } from '../notifications/services/notification-dispatcher';
import { NotificationEventFactory } from '../notifications/events/domain-events';

interface ChatNotificationParams {
  conversationId: string;
  senderId: string;
  messageId: string;
  type: string;
  text?: string;
  metadata?: any;
}

/**
 * Sends push notifications to offline recipients in a conversation.
 * Adheres to privacy rules (no sensitive credentials/tokens exposed)
 * and skips notifications if the user is online or has muted the conversation.
 */
export async function sendChatNotification({
  conversationId,
  senderId,
  messageId,
  type,
  text,
  metadata,
}: ChatNotificationParams): Promise<void> {
  try {
    const socketSvc = SocketService.get();

    // 1. Find conversation members excluding the sender
    const recipients = await prisma.conversationMember.findMany({
      where: {
        conversationId,
        userId: { not: senderId },
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    if (recipients.length === 0) return;

    // 2. Resolve sender display name (Store name if seller, else User full name)
    const sender = await prisma.user.findUnique({
      where: { id: senderId },
      select: {
        firstName: true,
        lastName: true,
        seller: {
          select: {
            stores: { select: { name: true } },
          },
        },
      },
    });

    const store = sender?.seller?.stores?.[0];
    const senderNameAr =
      store?.name ||
      `${sender?.firstName || ''} ${sender?.lastName || ''}`.trim() ||
      'مستخدم';

    const senderNameEn =
      store?.name ||
      `${sender?.firstName || ''} ${sender?.lastName || ''}`.trim() ||
      'User';

    // 3. Format safe, non-sensitive notification content
    let bodyAr = 'أرسل لك رسالة جديدة';
    let bodyEn = 'Sent you a new message';

    const cleanText = (text || '').trim();
    const meta = typeof metadata === 'string' ? JSON.parse(metadata || '{}') : metadata || {};

    switch (type.toLowerCase()) {
      case 'image':
        bodyAr = '📷 أرسل صورة';
        bodyEn = '📷 Sent an image';
        break;
      case 'file':
        bodyAr = meta.fileName ? `📎 أرسل ملفاً: ${meta.fileName}` : '📎 أرسل ملفاً';
        bodyEn = meta.fileName ? `📎 Sent a file: ${meta.fileName}` : '📎 Sent a file';
        break;
      case 'product':
        bodyAr = meta.product_name || meta.productName
          ? `🛍️ استفسار عن منتج: ${meta.product_name || meta.productName}`
          : '🛍️ أرسل استفساراً عن منتج';
        bodyEn = meta.product_name || meta.productName
          ? `🛍️ Product inquiry: ${meta.product_name || meta.productName}`
          : '🛍️ Shared a product';
        break;
      case 'order':
        bodyAr = meta.order_number || meta.orderNumber
          ? `📦 بخصوص الطلب #${meta.order_number || meta.orderNumber}`
          : '📦 أرسل تفاصيل طلب';
        bodyEn = meta.order_number || meta.orderNumber
          ? `📦 Regarding order #${meta.order_number || meta.orderNumber}`
          : '📦 Shared order details';
        break;
      case 'text':
      default:
        if (cleanText) {
          // Truncate to 100 characters and sanitize
          const excerpt = cleanText.length > 100 ? `${cleanText.substring(0, 97)}...` : cleanText;
          bodyAr = excerpt;
          bodyEn = excerpt;
        }
        break;
    }

    const titleAr = `رسالة جديدة من ${senderNameAr}`;
    const titleEn = `New message from ${senderNameEn}`;

    for (const recipient of recipients) {
      // Check if recipient has muted the conversation
      if (recipient.muted) {
        continue;
      }

      // Check if recipient is actively online in WebSocket
      const isOnline = socketSvc ? socketSvc.isUserOnline(recipient.userId) : false;
      if (isOnline) {
        // Recipient is online and receives the message via WebSocket directly
        continue;
      }

      // Dispatch through Centralized SOUQNAA Notification Platform
      const chatEvent = NotificationEventFactory.chatEvent({
        eventType: 'CHAT_MESSAGE_RECEIVED',
        recipientId: recipient.userId,
        conversationId,
        senderId,
        senderName: senderNameAr,
        messageText: cleanText || (type === 'image' ? '📷 صورة' : '📎 مرفق'),
        messageType: type,
        productName: meta.product_name || meta.productName,
        orderNumber: meta.order_number || meta.orderNumber,
      });

      await notificationDispatcher.dispatch(chatEvent);
    }
  } catch (error) {
    console.error('[Chat Notification] Error sending chat notification:', error);
  }
}

/**
 * Marks all pending CHAT_MESSAGE notifications for this conversation and user as read.
 */
export async function markChatNotificationsAsRead(
  conversationId: string,
  userId: string
): Promise<void> {
  try {
    const unreadNotifications = await prisma.notification.findMany({
      where: {
        userId,
        type: 'CHAT_MESSAGE',
        isRead: false,
      },
    });

    const matchingIds: string[] = [];
    for (const notif of unreadNotifications) {
      if (notif.data) {
        try {
          const parsed = JSON.parse(notif.data);
          if (parsed.conversationId === conversationId) {
            matchingIds.push(notif.id);
          }
        } catch (_) {}
      }
    }

    if (matchingIds.length > 0) {
      await prisma.notification.updateMany({
        where: {
          id: { in: matchingIds },
        },
        data: { isRead: true },
      });
    }
  } catch (error) {
    console.error('[Chat Notification] Error marking notifications as read:', error);
  }
}
