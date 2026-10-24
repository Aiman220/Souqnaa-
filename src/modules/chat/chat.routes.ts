import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { prisma } from '../../database/prisma';
import { authenticate, authorize } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { SocketService } from '../../services/websocket/socket.service';
import { storageService } from '../../services/storage/storage.service';
import { AppError } from '../../middleware/error.middleware';
import {
  chatLimiter,
  chatMessageLimiter,
  conversationCreationLimiter,
  chatUploadLimiter,
  chatReportLimiter,
} from '../../middleware/rate-limiter.middleware';
import { sendChatNotification, markChatNotificationsAsRead } from './chat.notification';

const router = Router();
router.use(authenticate);
router.use(chatLimiter);

const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|sh|ps1|vbs|js|mjs|jar|scr|pif|com|hta|cpl|msi|php|asp|aspx|py|elf|bin|svg|html|htm|xml|xhtml)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();

    if (
      BLOCKED_EXTENSIONS.test(ext) ||
      mime.includes('html') ||
      mime.includes('xml') ||
      mime.includes('javascript') ||
      mime.includes('svg')
    ) {
      return cb(new AppError('Executable, script, HTML, or SVG attachments are not allowed for security reasons', 400));
    }
    cb(null, true);
  },
});


// ─── helpers ────────────────────────────────────────────────────────────────

export function normalizeMessage(m: any) {
  const rawType = (m.type || 'text').toLowerCase();
  const url = m.attachmentUrl ? storageService.normalizeUrl(m.attachmentUrl) : null;
  const isImage = rawType === 'image' || (url && /\.(jpg|jpeg|png|webp|gif|svg|bmp)(\?.*)?$/i.test(url));
  const isVideo = rawType === 'video' || (url && /\.(mp4|mov|avi|mkv|webm|3gp|m4v|flv)(\?.*)?$/i.test(url));
  const isProduct = rawType === 'product';
  const isOrder = rawType === 'order';
  const isSystem = rawType === 'system';
  const isFile = (rawType === 'file' || (url && !isImage && !isVideo)) && !isProduct && !isOrder && !isSystem;

  let computedType = 'text';
  if (isImage) computedType = 'image';
  else if (isVideo) computedType = 'video';
  else if (isProduct) computedType = 'product';
  else if (isOrder) computedType = 'order';
  else if (isSystem) computedType = 'system';
  else if (isFile) computedType = 'file';

  let parsedMetadata: any = null;
  if (m.metadata) {
    if (typeof m.metadata === 'string') {
      try {
        parsedMetadata = JSON.parse(m.metadata);
      } catch (_) {
        parsedMetadata = m.metadata;
      }
    } else {
      parsedMetadata = m.metadata;
    }
  }

  const createdAtStr =
    m.createdAt instanceof Date
      ? m.createdAt.toISOString()
      : typeof m.createdAt === 'string'
      ? m.createdAt
      : new Date().toISOString();

  return {
    id: String(m.id),
    conversationId: String(m.conversationId),
    senderId: String(m.senderId),
    content: m.text || '',
    type: computedType,
    metadata: parsedMetadata,
    clientMessageId: m.clientMessageId || null,
    createdAt: createdAtStr,
    imageUrl: isImage ? url : null,
    videoUrl: isVideo ? url : null,
    fileUrl: (isFile || isVideo) ? url : null,
    fileName: (isFile || isVideo) ? (m.text || (isVideo ? 'video.mp4' : 'file')) : null,
    fileSize: null,
    isRead: Boolean(m.isRead),
    readAt: null,
    deletedAt: m.deletedAt ? (m.deletedAt instanceof Date ? m.deletedAt.toISOString() : String(m.deletedAt)) : null,
    reactions: (parsedMetadata && typeof parsedMetadata === 'object' && parsedMetadata.reactions && typeof parsedMetadata.reactions === 'object')
      ? parsedMetadata.reactions
      : (m.reactions && typeof m.reactions === 'object' ? m.reactions : {}),
    sender: m.sender || null,
  };
}

/** Enrich a conversation with computed fields the Flutter model expects. */
async function enrichConversation(conv: any, requestingUserId: string) {
  // Last message
  const lastMsg = conv.messages?.[0];

  // Identify members
  const requesterMember = conv.members?.find((m: any) => m.userId === requestingUserId);
  const otherMember = conv.members?.find((m: any) => m.userId !== requestingUserId);

  // Count unread messages (sent by other, created after requester's lastReadAt)
  const lastReadAt = requesterMember?.lastReadAt ?? new Date(0);
  const unreadCount = await prisma.message.count({
    where: {
      conversationId: conv.id,
      senderId: { not: requestingUserId },
      createdAt: { gt: lastReadAt },
      deletedAt: null,
    },
  });

  // Find store associated with any conversation member
  const allUserIds = conv.members?.map((m: any) => m.userId) || [requestingUserId];
  const store = await prisma.store.findFirst({
    where: {
      seller: { userId: { in: allUserIds } },
    },
    select: {
      id: true,
      name: true,
      logo: true,
      seller: { select: { userId: true } },
    },
  });

  const sellerMemberByRole = conv.members?.find((m: any) => m.user?.role === 'SELLER');
  const customerMemberByRole = conv.members?.find((m: any) => m.user?.role === 'CUSTOMER');

  let sellerUserId = store?.seller?.userId;
  if (!sellerUserId && sellerMemberByRole) {
    sellerUserId = sellerMemberByRole.userId;
  }
  if (!sellerUserId) {
    sellerUserId = otherMember?.userId || requestingUserId;
  }

  let customerUserId = conv.members?.find((m: any) => m.userId !== sellerUserId)?.userId;
  if (!customerUserId && customerMemberByRole) {
    customerUserId = customerMemberByRole.userId;
  }
  if (!customerUserId) {
    customerUserId = requestingUserId === sellerUserId ? (otherMember?.userId || requestingUserId) : requestingUserId;
  }

  const customerMember = conv.members?.find((m: any) => m.userId === customerUserId) || otherMember || requesterMember;
  const sellerMember = conv.members?.find((m: any) => m.userId === sellerUserId) || otherMember || requesterMember;

  const customerFullName = `${customerMember?.user?.firstName || ''} ${customerMember?.user?.lastName || ''}`.trim() || 'عميل';
  const sellerStoreName =
    store?.name ||
    conv.title ||
    `${sellerMember?.user?.firstName || ''} ${sellerMember?.user?.lastName || ''}`.trim() ||
    'متجر سوقناا';

  let lastMessageSnippet = null;
  if (lastMsg) {
    if (lastMsg.type === 'image' || lastMsg.attachmentUrl) {
      lastMessageSnippet = '📷 صورة';
    } else if (lastMsg.type === 'product') {
      lastMessageSnippet = '🛍️ منتج';
    } else if (lastMsg.type === 'order') {
      lastMessageSnippet = '📦 طلب';
    } else {
      lastMessageSnippet = lastMsg.text || 'رسالة جديدة';
    }
  }

  return {
    id: conv.id,
    title: conv.title || sellerStoreName,
    status: conv.status || 'ACTIVE',
    type: conv.type || (Boolean(conv.supportConversation) ? 'SUPPORT_CUSTOMER' : 'DIRECT_CUSTOMER_SELLER'),
    isSupport: Boolean(conv.supportConversation || conv.type?.startsWith('SUPPORT_')),
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    // Computed fields Flutter ConversationModel expects
    customerId: customerUserId,
    sellerId: sellerUserId,
    storeId: store?.id || '',
    customerName: customerFullName,
    sellerStoreName,
    storeLogo: store?.logo || sellerMember?.user?.avatar || null,
    lastMessage: lastMessageSnippet,
    lastMessageAt: lastMsg?.createdAt || null,
    unreadCount,
    isBlocked: Boolean(requesterMember?.blocked || otherMember?.blocked),
    isBlockedByMe: Boolean(requesterMember?.blocked),
    isBlockedByOther: Boolean(otherMember?.blocked),
    isMuted: Boolean(requesterMember?.muted),
    members: conv.members,
    supportConversation: conv.supportConversation || null,
  };
}

// ─── GET /api/v1/conversations ───────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const search = req.query.search as string | undefined;
    const type = req.query.type as string | undefined;

    const whereClause: any = {
      members: { some: { userId } },
    };

    if (type) {
      const upperType = type.toUpperCase();
      if (upperType === 'STORE' || upperType === 'DIRECT_CUSTOMER_SELLER') {
        whereClause.type = { notIn: ['SUPPORT_CUSTOMER', 'SUPPORT_SELLER'] };
        whereClause.supportConversation = null;
      } else if (upperType === 'SUPPORT' || upperType === 'SUPPORT_CUSTOMER') {
        whereClause.OR = [
          { type: { in: ['SUPPORT_CUSTOMER', 'SUPPORT_SELLER'] } },
          { supportConversation: { isNot: null } },
        ];
      }
    }

    if (search && search.trim()) {
      const q = search.trim();
      const searchFilter = [
        { title: { contains: q, mode: 'insensitive' } },
        {
          members: {
            some: {
              user: {
                OR: [
                  { firstName: { contains: q, mode: 'insensitive' } },
                  { lastName: { contains: q, mode: 'insensitive' } },
                ],
              },
            },
          },
        },
      ];

      if (whereClause.OR) {
        whereClause.AND = [{ OR: whereClause.OR }, { OR: searchFilter }];
        delete whereClause.OR;
      } else {
        whereClause.OR = searchFilter;
      }
    }

    const conversations = await prisma.conversation.findMany({
      where: whereClause,
      include: {
        members: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
          },
        },
        supportConversation: {
          select: {
            id: true,
            subject: true,
            status: true,
            priority: true,
            ticket: {
              select: {
                ticketNumber: true,
              },
            },
          },
        },
        messages: {
          where: { deletedAt: null },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const enriched = await Promise.all(conversations.map((c) => enrichConversation(c, userId)));
    ResponseUtil.success(res, enriched);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/conversations/:id ──────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = String(req.params.id);
    const userId = req.user!.userId;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        members: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
          },
        },
        messages: {
          where: { deletedAt: null },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!conversation) {
      return ResponseUtil.error(res, 'Conversation not found', 404);
    }

    const isMember = conversation.members.some((m) => m.userId === userId);
    if (!isMember && req.user!.role !== 'ADMIN') {
      return ResponseUtil.error(res, 'Unauthorized', 403);
    }

    const enriched = await enrichConversation(conversation, userId);
    ResponseUtil.success(res, enriched);
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/conversations ──────────────────────────────────────────────
router.post('/', conversationCreationLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currentUserId = req.user!.userId;
    const { storeId, sellerId, customerId, orderId } = req.body as {
      storeId?: string;
      sellerId?: string;
      customerId?: string;
      orderId?: string;
    };

    let targetUserId: string | null = null;
    let storeName: string | null = null;

    // 1. Resolve from orderId if provided
    if (orderId && typeof orderId === 'string' && orderId.trim()) {
      const trimmedOrderId = orderId.trim();
      const sellerOrder = await prisma.sellerOrder.findFirst({
        where: {
          OR: [
            { id: trimmedOrderId },
            { orderId: trimmedOrderId },
            { order: { orderNumber: trimmedOrderId } },
          ],
        },
        include: {
          order: { select: { userId: true, orderNumber: true } },
          seller: {
            include: {
              stores: { take: 1, select: { name: true } },
            },
          },
        },
      });

      if (sellerOrder) {
        if (currentUserId === sellerOrder.seller?.userId) {
          targetUserId = sellerOrder.order?.userId || null;
        } else {
          targetUserId = sellerOrder.seller?.userId || null;
        }
        storeName = sellerOrder.seller?.stores?.[0]?.name || null;
      } else {
        const order = await prisma.order.findFirst({
          where: {
            OR: [
              { id: trimmedOrderId },
              { orderNumber: trimmedOrderId },
            ],
          },
          include: {
            sellerOrders: {
              take: 1,
              include: {
                seller: {
                  include: { stores: { take: 1, select: { name: true } } },
                },
              },
            },
          },
        });
        if (order) {
          const firstSeller = order.sellerOrders?.[0]?.seller;
          if (firstSeller) {
            if (currentUserId === firstSeller.userId) {
              targetUserId = order.userId;
            } else {
              targetUserId = firstSeller.userId;
            }
            storeName = firstSeller.stores?.[0]?.name || null;
          } else {
            // Check products in order
            const item = await prisma.orderItem.findFirst({
              where: { sellerOrder: { orderId: order.id } },
              include: { product: { include: { store: { include: { seller: true } } } } },
            });
            if (item?.product?.store?.seller?.userId) {
              if (currentUserId === item.product.store.seller.userId) {
                targetUserId = order.userId;
              } else {
                targetUserId = item.product.store.seller.userId;
              }
              storeName = item.product.store.name;
            }
          }
        }
      }
    }

    // 2. Resolve from customerId if provided and targetUserId not found
    if (!targetUserId && customerId && typeof customerId === 'string' && customerId.trim()) {
      const cid = customerId.trim();
      const user = await prisma.user.findUnique({
        where: { id: cid },
        select: { id: true, firstName: true, lastName: true },
      });
      if (user) {
        targetUserId = user.id;
      }
    }

    // 3. Resolve from storeId if provided and targetUserId not found
    if (!targetUserId && storeId && typeof storeId === 'string' && storeId.trim() && storeId !== 'store') {
      const sid = storeId.trim();
      const store = await prisma.store.findFirst({
        where: {
          OR: [
            { id: sid },
            { slug: sid },
          ],
        },
        select: {
          id: true,
          name: true,
          logo: true,
          seller: { select: { userId: true } },
        },
      });

      if (store?.seller?.userId) {
        targetUserId = store.seller.userId;
        storeName = store.name;
      } else {
        const seller = await prisma.seller.findFirst({
          where: {
            OR: [
              { id: sid },
              { userId: sid },
            ],
          },
          include: { stores: { take: 1, select: { name: true } } },
        });
        if (seller) {
          targetUserId = seller.userId;
          storeName = seller.stores[0]?.name || null;
        } else {
          const user = await prisma.user.findUnique({
            where: { id: sid },
            include: { seller: { include: { stores: { take: 1, select: { name: true } } } } },
          });
          if (user) {
            targetUserId = user.id;
            storeName = user.seller?.stores[0]?.name || null;
          }
        }
      }
    }

    // 4. Resolve from sellerId if provided and targetUserId not found
    if (!targetUserId && sellerId && typeof sellerId === 'string' && sellerId.trim()) {
      const sid = sellerId.trim();
      const seller = await prisma.seller.findFirst({
        where: {
          OR: [
            { id: sid },
            { userId: sid },
          ],
        },
        include: { stores: { take: 1, select: { name: true } } },
      });
      if (seller) {
        targetUserId = seller.userId;
        storeName = seller.stores[0]?.name || null;
      } else {
        const store = await prisma.store.findFirst({
          where: {
            OR: [
              { id: sid },
              { slug: sid },
            ],
          },
          include: { seller: { select: { userId: true } } },
        });
        if (store?.seller?.userId) {
          targetUserId = store.seller.userId;
          storeName = store.name;
        } else {
          const user = await prisma.user.findUnique({
            where: { id: sid },
            include: { seller: { include: { stores: { take: 1, select: { name: true } } } } },
          });
          if (user) {
            targetUserId = user.id;
            storeName = user.seller?.stores[0]?.name || null;
          }
        }
      }
    }

    // 5. If targetUserId was provided directly but not resolved yet, check if it is a user, seller, or store
    if (!targetUserId && (customerId || sellerId)) {
      const rawId = (customerId || sellerId)!.trim();
      const user = await prisma.user.findUnique({ where: { id: rawId }, select: { id: true } });
      if (user) {
        targetUserId = user.id;
      } else {
        const seller = await prisma.seller.findUnique({
          where: { id: rawId },
          select: { userId: true, stores: { take: 1, select: { name: true } } },
        });
        if (seller) {
          targetUserId = seller.userId;
          if (!storeName) storeName = seller.stores[0]?.name || null;
        } else {
          const store = await prisma.store.findUnique({
            where: { id: rawId },
            include: { seller: { select: { userId: true } } },
          });
          if (store?.seller?.userId) {
            targetUserId = store.seller.userId;
            if (!storeName) storeName = store.name;
          }
        }
      }
    }

    // 6. Graceful fallback to first active store in system if target user not directly found
    if (!targetUserId || targetUserId === currentUserId) {
      const anyStore = await prisma.store.findFirst({
        where: {
          isActive: true,
          seller: { userId: { not: currentUserId } },
        },
        include: { seller: { select: { userId: true } } },
      });
      if (anyStore?.seller?.userId) {
        targetUserId = anyStore.seller.userId;
        storeName = anyStore.name;
      }
    }

    if (!targetUserId) {
      return ResponseUtil.error(res, 'Could not determine conversation participant', 400);
    }

    if (targetUserId === currentUserId) {
      return ResponseUtil.error(res, 'Cannot start a conversation with yourself', 400);
    }

    // Find existing conversation between the two users
    const existing = await prisma.conversation.findFirst({
      where: {
        AND: [
          { members: { some: { userId: currentUserId } } },
          { members: { some: { userId: targetUserId } } },
        ],
      },
      include: {
        members: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
          },
        },
        messages: {
          where: { deletedAt: null },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (existing) {
      const enriched = await enrichConversation(existing, currentUserId);
      return ResponseUtil.success(res, enriched);
    }

    // Create new conversation + add both members
    const conversation = await prisma.conversation.create({
      data: {
        title: storeName,
        members: {
          create: [{ userId: currentUserId }, { userId: targetUserId }],
        },
      },
      include: {
        members: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
          },
        },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    const enriched = await enrichConversation(conversation, currentUserId);
    ResponseUtil.created(res, enriched);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/conversations/:id/messages ──────────────────────────────────
// Cursor pagination: ?before=<cursor_message_id_or_iso>&limit=30
router.get('/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = String(req.params.id);
    const userId = req.user!.userId;
    const limit = Math.min(parseInt(String(req.query.limit || '30'), 10), 100);
    const before = req.query.before as string | undefined;

    // Verify membership
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!member && req.user!.role !== 'ADMIN') {
      return ResponseUtil.error(res, 'Conversation not found', 404);
    }

    const whereClause: any = {
      conversationId,
      deletedAt: null,
    };

    if (before) {
      const maybeDate = new Date(before);
      if (!isNaN(maybeDate.getTime())) {
        whereClause.createdAt = { lt: maybeDate };
      } else {
        const refMsg = await prisma.message.findUnique({
          where: { id: before },
          select: { createdAt: true },
        });
        if (refMsg) {
          whereClause.createdAt = { lt: refMsg.createdAt };
        }
      }
    }

    const messages = await prisma.message.findMany({
      where: whereClause,
      take: limit,
      include: {
        sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Mark messages as read by updating lastReadAt
    await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    });

    // Also update isRead flag on messages sent by others
    await prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        isRead: false,
      },
      data: { isRead: true },
    });

    const chronoSorted = messages.reverse();
    const normalized = chronoSorted.map(normalizeMessage);
    ResponseUtil.success(res, normalized);
  } catch (error) {
    next(error);
  }
});

// ─── Authoritative Verification Helpers for Safe Snapshots ────────────────────
export async function verifyProductPayload(productId: string): Promise<any | null> {
  try {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        images: { take: 1, select: { url: true } },
        store: { select: { id: true, name: true, logo: true } },
      },
    });
    if (!product) return null;

    return {
      productId: product.id,
      product_id: product.id,
      productName: product.nameAr || product.nameEn,
      product_name: product.nameAr || product.nameEn,
      thumbnail: product.images[0]?.url || null,
      price: product.price,
      discountPrice: product.compareAtPrice,
      discount_price: product.compareAtPrice,
      currency: product.currency || 'SAR',
      sellerId: product.storeId,
      seller_id: product.storeId,
      storeName: product.store?.name,
    };
  } catch {
    return null;
  }
}

export async function verifyOrderPayload(orderId: string, userId: string, userRole: string = 'CUSTOMER'): Promise<any | null> {
  try {
    let order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        sellerOrders: {
          include: {
            seller: { select: { userId: true } },
            items: {
              take: 5,
              include: { product: { select: { nameAr: true, nameEn: true, images: { take: 1 } } } },
            },
          },
        },
      },
    });

    let sellerOrderId: string | null = null;

    if (!order) {
      const sellerOrder = await prisma.sellerOrder.findUnique({
        where: { id: orderId },
        include: {
          seller: { select: { userId: true } },
          order: {
            include: {
              sellerOrders: {
                include: {
                  seller: { select: { userId: true } },
                  items: {
                    take: 5,
                    include: { product: { select: { nameAr: true, nameEn: true, images: { take: 1 } } } },
                  },
                },
              },
            },
          },
        },
      });

      if (sellerOrder) {
        order = sellerOrder.order;
        sellerOrderId = sellerOrder.id;
      }
    }

    if (!order) return null;

    const isCustomer = order.userId === userId;
    const isSeller = order.sellerOrders.some((so) => so.seller?.userId === userId || so.sellerId === userId);
    const isAdmin = userRole === 'ADMIN';

    if (!isCustomer && !isSeller && !isAdmin) {
      return null;
    }

    const relevantSellerOrder = sellerOrderId
      ? order.sellerOrders.find((so) => so.id === sellerOrderId)
      : order.sellerOrders.find((so) => so.seller?.userId === userId || so.sellerId === userId) || order.sellerOrders[0];

    const itemNames: string[] = [];
    let count = 0;
    for (const so of order.sellerOrders) {
      for (const item of so.items) {
        count++;
        if (item.product) {
          itemNames.push(item.product.nameAr || item.product.nameEn);
        }
      }
    }

    // Safe snapshot: Never expose payment credentials, private customer info, or internal admin data
    return {
      orderId: order.id,
      order_id: order.id,
      sellerOrderId: relevantSellerOrder?.id || null,
      seller_order_id: relevantSellerOrder?.id || null,
      orderNumber: order.orderNumber || order.id.slice(0, 8),
      order_number: order.orderNumber || order.id.slice(0, 8),
      orderStatus: relevantSellerOrder?.status || order.status,
      order_status: relevantSellerOrder?.status || order.status,
      displayTotal: isSeller && relevantSellerOrder ? relevantSellerOrder.subtotal : order.total,
      display_total: isSeller && relevantSellerOrder ? relevantSellerOrder.subtotal : order.total,
      currency: order.currency || 'SAR',
      summary: itemNames.join('، '),
      itemsCount: count,
      createdAt: order.createdAt,
    };
  } catch {
    return null;
  }
}

// ─── POST /api/v1/conversations/:id/messages ─────────────────────────────────
router.post('/:id/messages', chatMessageLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = String(req.params.id);
    const userId = req.user!.userId;
    const { text, attachmentUrl, type = 'text', metadata, clientMessageId } = req.body;

    if (text && typeof text === 'string' && text.length > 4000) {
      return ResponseUtil.error(res, 'Message text exceeds the 4,000 character limit', 400);
    }
    if ((!text || !text.trim()) && !attachmentUrl && type === 'text') {
      return ResponseUtil.error(res, 'Cannot send empty message', 400);
    }

    // Idempotency: Check if clientMessageId already exists
    if (clientMessageId) {
      const existing = await prisma.message.findUnique({
        where: { clientMessageId },
        include: {
          sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        },
      });
      if (existing) {
        return ResponseUtil.success(res, normalizeMessage(existing));
      }
    }

    // Verify membership
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!member) {
      return ResponseUtil.error(res, 'Conversation not found or not a member', 404);
    }
    
    // Check if conversation is blocked by ANY member
    const blockedMember = await prisma.conversationMember.findFirst({
      where: {
        conversationId,
        blocked: true,
      },
    });
    if (blockedMember) {
      return ResponseUtil.error(res, 'This conversation is blocked. New messages cannot be sent.', 403);
    }

    // Authoritative verification for Product sharing
    let finalMetadata = metadata;
    let validatedType = type;

    const reqProductId = metadata?.productId || metadata?.product_id;
    if (type === 'product' && reqProductId) {
      const verifiedProduct = await verifyProductPayload(reqProductId);
      if (verifiedProduct) {
        finalMetadata = verifiedProduct;
      }
    }

    // Authoritative verification for Order sharing
    const reqOrderId = metadata?.orderId || metadata?.order_id || metadata?.sellerOrderId || metadata?.seller_order_id;
    if (type === 'order' && reqOrderId) {
      const verifiedOrder = await verifyOrderPayload(reqOrderId, userId, req.user!.role);
      if (verifiedOrder) {
        finalMetadata = verifiedOrder;
      } else {
        return ResponseUtil.error(res, 'You do not have permission to share this order', 403);
      }
    }

    const metadataStr = finalMetadata ? (typeof finalMetadata === 'string' ? finalMetadata : JSON.stringify(finalMetadata)) : null;

    // Atomic transaction: Create message + update conversation
    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId: userId,
          type: validatedType,
          text: text || '',
          attachmentUrl: attachmentUrl || null,
          metadata: metadataStr,
          clientMessageId: clientMessageId || null,
        },
        include: {
          sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        },
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          updatedAt: new Date(),
          lastMessageId: created.id,
        },
      });

      return created;
    });

    const normalized = normalizeMessage(message);

    // Broadcast via WebSocket to the conversation room and to each member
    try {
      const socketSvc = SocketService.get();
      if (socketSvc) {
        socketSvc.emitToConversation(conversationId, 'message:new', normalized);
        socketSvc.emitToConversation(conversationId, 'new:message', normalized);
        const allMembers = await prisma.conversationMember.findMany({
          where: { conversationId },
          select: { userId: true },
        });
        for (const m of allMembers) {
          socketSvc.emitToUser(m.userId, 'message:new', normalized);
          socketSvc.emitToUser(m.userId, 'new:message', normalized);
        }
      }
    } catch (err) {
      console.error('[Chat] WebSocket broadcast error:', err);
    }

    // Push notifications to offline recipients
    sendChatNotification({
      conversationId,
      senderId: userId,
      messageId: message.id,
      type: validatedType,
      text: text || '',
      metadata: finalMetadata,
    }).catch((err) => console.error('[Notification Error]:', err));

    // Seller Performance chat response event ingestion
    try {
      const seller = await prisma.seller.findUnique({ where: { userId } });
      if (seller) {
        const { SellerPerformanceEventService } = await import('../seller-performance/seller-performance-event.service');
        SellerPerformanceEventService.recordEvent({
          sellerId: seller.id,
          eventType: 'CHAT_RESPONSE_RECORDED',
          entityId: message.id,
        }).catch(() => {});
      }
    } catch (_) {}

    ResponseUtil.created(res, normalized);
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/conversations/:id/messages/upload ──────────────────────────
router.post('/:id/messages/upload', chatUploadLimiter, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = String(req.params.id);
    const userId = req.user!.userId;
    const clientMessageId = req.body.clientMessageId;

    if (!req.file) {
      throw new AppError('No file uploaded', 400);
    }

    try {
      req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    } catch (_) {}

    // Verify membership
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!member) {
      return ResponseUtil.error(res, 'Conversation not found', 404);
    }

    // Check if conversation is blocked by ANY member
    const blockedMember = await prisma.conversationMember.findFirst({
      where: {
        conversationId,
        blocked: true,
      },
    });
    if (blockedMember) {
      return ResponseUtil.error(res, 'This conversation is blocked. New files cannot be uploaded.', 403);
    }

    // Upload file to Cloudflare R2 / local storage
    const uploadResult = await storageService.uploadFile(req.file, 'chat');
    const isImg = /\.(jpg|jpeg|png|webp|gif|svg|bmp)$/i.test(req.file.originalname || '') || req.file.mimetype.startsWith('image/');
    const isVid = /\.(mp4|mov|avi|mkv|webm|3gp|m4v|flv)$/i.test(req.file.originalname || '') || req.file.mimetype.startsWith('video/');
    const type = isImg ? 'image' : isVid ? 'video' : 'file';

    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId: userId,
          type,
          text: req.file!.originalname || 'file',
          attachmentUrl: uploadResult.url,
          clientMessageId: clientMessageId || null,
        },
        include: {
          sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        },
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          updatedAt: new Date(),
          lastMessageId: created.id,
        },
      });

      return created;
    });

    const normalized = normalizeMessage(message);

    // Broadcast via WebSocket
    try {
      const socketSvc = SocketService.get();
      if (socketSvc) {
        socketSvc.emitToConversation(conversationId, 'message:new', normalized);
        socketSvc.emitToConversation(conversationId, 'new:message', normalized);
        const allMembers = await prisma.conversationMember.findMany({
          where: { conversationId },
          select: { userId: true },
        });
        for (const m of allMembers) {
          socketSvc.emitToUser(m.userId, 'message:new', normalized);
          socketSvc.emitToUser(m.userId, 'new:message', normalized);
        }
      }
    } catch (err) {
      console.error('[Chat] WebSocket upload broadcast error:', err);
    }

    // Push notifications to offline recipients
    sendChatNotification({
      conversationId,
      senderId: userId,
      messageId: message.id,
      type,
      text: req.file!.originalname || 'file',
      metadata: { fileName: req.file!.originalname, fileSize: req.file!.size },
    }).catch((err) => console.error('[Notification Error]:', err));

    ResponseUtil.created(res, normalized);
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/conversations/:id/read ────────────────────────────────────
router.post('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = String(req.params.id);
    const userId = req.user!.userId;

    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!member) {
      return ResponseUtil.error(res, 'Conversation not found', 404);
    }

    const now = new Date();
    await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: now },
    });

    await prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        isRead: false,
      },
      data: { isRead: true },
    });

    // Mark related CHAT_MESSAGE notifications as read
    markChatNotificationsAsRead(conversationId, userId).catch((err) =>
      console.error('[Notification Read Error]:', err)
    );

    try {
      const socketSvc = SocketService.get();
      if (socketSvc) {
        const readPayload = {
          conversationId,
          userId,
          readAt: now.toISOString(),
        };
        socketSvc.emitToConversation(conversationId, 'messages:read', readPayload);
        socketSvc.emitToConversation(conversationId, 'message:read', readPayload);
        const members = await prisma.conversationMember.findMany({
          where: { conversationId, userId: { not: userId } },
          select: { userId: true },
        });
        for (const m of members) {
          socketSvc.emitToUser(m.userId, 'messages:read', readPayload);
          socketSvc.emitToUser(m.userId, 'message:read', readPayload);
        }
      }
    } catch (_) {}

    ResponseUtil.success(res, { success: true, readAt: now.toISOString() });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/conversations/:id/messages/:messageId/reactions ────────────
router.post('/:id/messages/:messageId/reactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = String(req.params.id);
    const messageId = String(req.params.messageId);
    const userId = req.user!.userId;
    const { emoji } = req.body as { emoji?: string };

    if (!emoji || typeof emoji !== 'string' || !emoji.trim()) {
      return ResponseUtil.error(res, 'Emoji is required', 400);
    }

    const trimmedEmoji = emoji.trim();

    const msg = await prisma.message.findFirst({
      where: { id: messageId, conversationId, deletedAt: null },
    });

    if (!msg) {
      return ResponseUtil.error(res, 'Message not found', 404);
    }

    let meta: any = {};
    if (msg.metadata) {
      try {
        meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata;
      } catch (_) {
        meta = {};
      }
    }

    if (!meta.reactions || typeof meta.reactions !== 'object') {
      meta.reactions = {};
    }

    const reactions: Record<string, string[]> = meta.reactions;

    if (!Array.isArray(reactions[trimmedEmoji])) {
      reactions[trimmedEmoji] = [];
    }

    const existingIndex = reactions[trimmedEmoji].indexOf(userId);
    if (existingIndex > -1) {
      reactions[trimmedEmoji].splice(existingIndex, 1);
      if (reactions[trimmedEmoji].length === 0) {
        delete reactions[trimmedEmoji];
      }
    } else {
      reactions[trimmedEmoji].push(userId);
    }

    meta.reactions = reactions;

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { metadata: JSON.stringify(meta) },
      include: {
        sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    });

    SocketService.get()?.emitToConversation(conversationId, 'message:reaction', {
      messageId,
      emoji: trimmedEmoji,
      userId,
      conversationId,
      reactions,
    });

    ResponseUtil.success(res, normalizeMessage(updated));
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/v1/conversations/:id ─────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = String(req.params.id);
    const userId = req.user!.userId;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { members: true },
    });

    if (!conversation) {
      return ResponseUtil.error(res, 'Conversation not found', 404);
    }

    const isMember = conversation.members.some((m) => m.userId === userId);
    if (!isMember && req.user!.role !== 'ADMIN') {
      return ResponseUtil.error(res, 'Unauthorized', 403);
    }

    await prisma.conversation.delete({
      where: { id: conversationId },
    });

    try {
      SocketService.get()?.emitToConversation(conversationId, 'conversation:deleted', {
        conversationId,
        deletedBy: userId,
      });
    } catch (_) {}

    ResponseUtil.success(res, { success: true, conversationId });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/v1/conversations/:id/messages/:messageId ────────────────────
router.delete('/:id/messages/:messageId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = String(req.params.id);
    const messageId = String(req.params.messageId);
    const userId = req.user!.userId;

    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message || message.conversationId !== conversationId) {
      return ResponseUtil.error(res, 'Message not found', 404);
    }

    if (message.senderId !== userId && req.user!.role !== 'ADMIN') {
      return ResponseUtil.error(res, 'Forbidden', 403);
    }

    await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date() },
    });

    try {
      SocketService.get()?.emitToConversation(conversationId, 'message:deleted', {
        conversationId,
        messageId,
      });
    } catch (_) {}

    ResponseUtil.success(res, { success: true, messageId });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/conversations/:id/messages/:messageId/report ───────────────
router.post('/:id/messages/:messageId/report', chatReportLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = String(req.params.id);
    const messageId = String(req.params.messageId);
    const userId = req.user!.userId;
    const { reason, description } = req.body;

    if (!reason) {
      return ResponseUtil.error(res, 'Reason is required', 400);
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });
    if (!message || message.conversationId !== conversationId) {
      return ResponseUtil.error(res, 'Message not found', 404);
    }

    const report = await prisma.messageReport.create({
      data: {
        messageId,
        reportedBy: userId,
        reason,
        description: description || null,
      },
    });

    ResponseUtil.created(res, { success: true, reportId: report.id });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/conversations/:id/block ───────────────────────────────────
router.post('/:id/block', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = String(req.params.id);
    const userId = req.user!.userId;
    const { block = true } = req.body;

    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!member) {
      return ResponseUtil.error(res, 'Conversation not found', 404);
    }

    await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { blocked: Boolean(block) },
    });

    const anyBlocked = await prisma.conversationMember.findFirst({
      where: {
        conversationId,
        blocked: true,
      },
    });

    const isBlocked = Boolean(anyBlocked);

    try {
      SocketService.get()?.emitToConversation(conversationId, 'conversation:block_status', {
        conversationId,
        isBlocked,
        blockedBy: userId,
      });
    } catch (_) {}

    ResponseUtil.success(res, { success: true, blocked: Boolean(block), isBlocked });
  } catch (error) {
    next(error);
  }
});

// ─── ADMIN MODERATION ROUTES ────────────────────────────────────────────────
router.get('/admin/reports', authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reports = await prisma.messageReport.findMany({
      include: {
        message: {
          include: {
            sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          },
        },
        reporter: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    ResponseUtil.success(res, reports);
  } catch (error) {
    next(error);
  }
});

router.patch('/admin/reports/:reportId', authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reportId = String(req.params.reportId);
    const { status } = req.body; // RESOLVED or DISMISSED

    const report = await prisma.messageReport.update({
      where: { id: reportId },
      data: {
        status: status || 'RESOLVED',
        resolvedAt: new Date(),
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          userId: req.user!.userId,
          action: 'CHAT_MESSAGE_REPORT_RESOLVED',
          resource: 'message_reports',
          ipAddress: req.ip || req.socket?.remoteAddress || null,
          userAgent: req.headers['user-agent'] || null,
          details: JSON.stringify({ reportId, status: status || 'RESOLVED', messageId: report.messageId }),
        },
      });
    } catch (_) {}

    ResponseUtil.success(res, report);
  } catch (error) {
    next(error);
  }
});

export const chatRoutes = router;
