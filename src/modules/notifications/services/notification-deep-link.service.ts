import { prisma } from '../../../database/prisma';

export interface DeepLinkVerificationResult {
  isValid: boolean;
  isAuthorized: boolean;
  destination: string;
  reason?: string;
  entityData?: any;
}

export class NotificationDeepLinkService {
  private static instance: NotificationDeepLinkService;

  static get(): NotificationDeepLinkService {
    if (!NotificationDeepLinkService.instance) {
      NotificationDeepLinkService.instance = new NotificationDeepLinkService();
    }
    return NotificationDeepLinkService.instance;
  }

  /**
   * Verifies that the recipient is authorized to access the deep link entity (IDOR protection).
   */
  async verifyDeepLinkAuthorization(
    userId: string,
    role: string,
    deepLink: string
  ): Promise<DeepLinkVerificationResult> {
    if (!deepLink || !deepLink.startsWith('souqnaa://')) {
      return { isValid: false, isAuthorized: false, destination: '/', reason: 'Invalid deep link protocol' };
    }

    const path = deepLink.replace('souqnaa://', '');
    const parts = path.split('/').filter(Boolean);

    if (parts.length === 0) {
      return { isValid: true, isAuthorized: true, destination: '/' };
    }

    const [domain, id] = parts;

    // Admin has platform-wide access
    if (role === 'ADMIN') {
      return { isValid: true, isAuthorized: true, destination: `/${path}` };
    }

    try {
      // 0. Cart
      if (domain === 'cart') {
        return { isValid: true, isAuthorized: true, destination: '/cart' };
      }

      // 1. Orders
      if (domain === 'orders' && id) {
        const order = await prisma.order.findUnique({
          where: { id },
          select: { userId: true, orderNumber: true },
        });

        if (!order) {
          return { isValid: false, isAuthorized: false, destination: '/orders', reason: 'Order not found' };
        }

        const isOwner = order.userId === userId;
        return {
          isValid: true,
          isAuthorized: isOwner,
          destination: `/orders/${id}`,
          reason: isOwner ? undefined : 'Unauthorized order access',
        };
      }

      // 2. Chat
      if (domain === 'chat' && id) {
        const member = await prisma.conversationMember.findUnique({
          where: {
            conversationId_userId: {
              conversationId: id,
              userId,
            },
          },
        });

        const isMember = !!member;
        return {
          isValid: true,
          isAuthorized: isMember,
          destination: `/chat/${id}`,
          reason: isMember ? undefined : 'User not a member of conversation',
        };
      }

      // 3. Seller Orders
      if (parts[0] === 'seller' && parts[1] === 'orders' && parts[2]) {
        const sellerOrderId = parts[2];
        const seller = await prisma.seller.findUnique({ where: { userId } });
        if (!seller) {
          return { isValid: false, isAuthorized: false, destination: '/seller', reason: 'Not a seller' };
        }

        const sellerOrder = await prisma.sellerOrder.findUnique({
          where: { id: sellerOrderId },
          select: { sellerId: true },
        });

        const isOwner = sellerOrder?.sellerId === seller.id;
        return {
          isValid: !!sellerOrder,
          isAuthorized: isOwner,
          destination: `/seller/orders/${sellerOrderId}`,
        };
      }

      // 4. Products & Campaigns & Rewards are publicly accessible to authenticated users
      return { isValid: true, isAuthorized: true, destination: `/${path}` };
    } catch (err: any) {
      return { isValid: false, isAuthorized: false, destination: '/', reason: err.message };
    }
  }
}

export const notificationDeepLinkService = NotificationDeepLinkService.get();
