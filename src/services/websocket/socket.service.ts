import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { JwtUtil } from '../../utils/jwt.util';
import { prisma } from '../../database/prisma';
import { verifyProductPayload, verifyOrderPayload } from '../../modules/chat/chat.routes';
import { sendChatNotification, markChatNotificationsAsRead } from '../../modules/chat/chat.notification';
import { config } from '../../config';
import { redis } from '../../database/redis';
import { SupportAgentStatus, SupportConversationStatus } from '@prisma/client';

export class SocketService {
  private static instance: SocketService;
  private io!: Server;
  private userSockets = new Map<string, string[]>(); // userId -> socketIds
  private userLastSeen = new Map<string, Date>(); // userId -> Date
  private userMessageTimestamps = new Map<string, number[]>(); // userId -> timestamps for rate limiting
  private userTypingTimestamps = new Map<string, number[]>(); // userId -> timestamps for typing rate limiting
  private conversationMetaCache = new Map<
    string,
    {
      baseConvId: string;
      altRoom: string | null;
      memberUserIds: string[];
      expiresAt: number;
    }
  >();
  private pendingDisconnectTimers = new Map<string, NodeJS.Timeout>(); // userId -> grace period timer
  public readonly DISCONNECT_GRACE_PERIOD_MS = 5000; // 5 second grace period to prevent false offline transitions

  private checkMessageRateLimit(userId: string): boolean {
    const now = Date.now();
    const timestamps = this.userMessageTimestamps.get(userId) || [];
    const windowStart = now - 60 * 1000; // 1 minute sliding window
    const recent = timestamps.filter((t) => t > windowStart);
    const limit = config.rateLimits?.chatMessagesPerMinute || 60;
    
    if (recent.length >= limit) {
      return false;
    }
    
    recent.push(now);
    this.userMessageTimestamps.set(userId, recent);
    return true;
  }

  private checkTypingRateLimit(userId: string): boolean {
    const now = Date.now();
    const timestamps = this.userTypingTimestamps.get(userId) || [];
    const windowStart = now - 10 * 1000; // 10 second sliding window
    const recent = timestamps.filter((t) => t > windowStart);
    // Allow maximum 25 typing events per 10 seconds per user
    if (recent.length >= 25) {
      return false;
    }
    recent.push(now);
    this.userTypingTimestamps.set(userId, recent);
    return true;
  }

  public async resolveAndCacheConversationMeta(
    cleanConvId: string,
    _requestingUserId?: string
  ): Promise<{ baseConvId: string; altRoom: string | null; memberUserIds: string[] } | null> {
    const cached = this.conversationMetaCache.get(cleanConvId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    try {
      let altRoom: string | null = null;
      let baseConvId = cleanConvId;
      let supportRequesterId: string | null = null;
      let supportAgentUserId: string | null = null;

      const supConv = await prisma.supportConversation.findFirst({
        where: {
          OR: [
            { id: cleanConvId },
            { conversationId: cleanConvId },
            { id: cleanConvId.toLowerCase() },
            { conversationId: cleanConvId.toLowerCase() },
          ],
        },
        include: { assignedAgent: true },
      });

      if (supConv) {
        altRoom =
          supConv.id.toLowerCase() === cleanConvId.toLowerCase()
            ? supConv.conversationId
            : supConv.id;
        baseConvId = supConv.conversationId;
        supportRequesterId = supConv.requesterId;
        supportAgentUserId = supConv.assignedAgent?.adminUserId || null;
      }

      const members = await prisma.conversationMember.findMany({
        where: {
          conversationId: { in: [cleanConvId, ...(altRoom ? [altRoom] : []), baseConvId] },
        },
        select: { userId: true },
      });

      const memberSet = new Set<string>(members.map((m) => m.userId));
      if (supportRequesterId) memberSet.add(supportRequesterId);
      if (supportAgentUserId) memberSet.add(supportAgentUserId);

      const meta = {
        baseConvId,
        altRoom,
        memberUserIds: Array.from(memberSet),
        expiresAt: Date.now() + 5 * 60 * 1000,
      };

      this.conversationMetaCache.set(cleanConvId, meta);
      this.conversationMetaCache.set(baseConvId, meta);
      if (altRoom) this.conversationMetaCache.set(altRoom, meta);

      return meta;
    } catch (_) {
      return null;
    }
  }

  static init(httpServer: HttpServer): SocketService {
    if (!SocketService.instance) {
      SocketService.instance = new SocketService();
      SocketService.instance.setup(httpServer);
    }
    return SocketService.instance;
  }

  static get(): SocketService {
    return SocketService.instance;
  }

  isUserOnline(userId: string): boolean {
    const sockets = this.userSockets.get(userId);
    return !!(sockets && sockets.length > 0);
  }

  isUserInConversation(userId: string, conversationId: string): boolean {
    if (!this.io) return false;
    const sockets = this.userSockets.get(userId);
    if (!sockets || sockets.length === 0) return false;
    const room = this.io.sockets.adapter.rooms.get(`conversation:${conversationId}`);
    if (!room) return false;
    return sockets.some((sid) => room.has(sid));
  }

  async getLastSeen(userId: string): Promise<Date | null> {
    const memoryLastSeen = this.userLastSeen.get(userId);
    if (memoryLastSeen) return memoryLastSeen;
    try {
      const redisVal = await redis.get(`user:last_seen:${userId}`);
      if (redisVal) {
        const d = new Date(redisVal);
        if (!isNaN(d.getTime())) {
          this.userLastSeen.set(userId, d);
          return d;
        }
      }
      const lastMsg = await prisma.message.findFirst({
        where: { senderId: userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (lastMsg) return lastMsg.createdAt;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { updatedAt: true },
      });
      return user?.updatedAt || null;
    } catch (_) {
      return null;
    }
  }

  public async handleUserOnline(userId: string): Promise<void> {
    if (!userId || userId.startsWith('guest_')) return;
    try {
      const memberships = await prisma.conversationMember.findMany({
        where: { userId },
        select: { conversationId: true },
      });
      const convIds = memberships.map((m) => m.conversationId);
      if (convIds.length === 0) return;

      const coMembers = await prisma.conversationMember.findMany({
        where: {
          conversationId: { in: convIds },
          userId: { not: userId },
        },
        select: { userId: true, conversationId: true },
      });

      const presencePayload = {
        userId,
        isOnline: true,
        lastSeen: new Date().toISOString(),
      };

      const notifiedUsers = new Set<string>();
      for (const cm of coMembers) {
        if (!notifiedUsers.has(cm.userId)) {
          notifiedUsers.add(cm.userId);
          this.io.to(`user:${cm.userId}`).emit('user:online', { ...presencePayload, conversationId: cm.conversationId });
          this.io.to(`user:${cm.userId}`).emit('user:presence', { ...presencePayload, conversationId: cm.conversationId });
        }
        this.io.to(`conversation:${cm.conversationId}`).emit('user:online', { ...presencePayload, conversationId: cm.conversationId });
        this.io.to(`conversation:${cm.conversationId}`).emit('user:presence', { ...presencePayload, conversationId: cm.conversationId });
      }
    } catch (err) {
      console.error(`[Socket.IO] handleUserOnline error for ${userId}:`, err);
    }
  }

  public async handleUserOffline(userId: string): Promise<void> {
    if (!userId || userId.startsWith('guest_')) return;
    try {
      const now = new Date();
      this.userLastSeen.set(userId, now);
      await redis.set(`user:last_seen:${userId}`, now.toISOString(), 60 * 60 * 24 * 30).catch(() => {});

      const memberships = await prisma.conversationMember.findMany({
        where: { userId },
        select: { conversationId: true },
      });
      const convIds = memberships.map((m) => m.conversationId);
      if (convIds.length === 0) return;

      const coMembers = await prisma.conversationMember.findMany({
        where: {
          conversationId: { in: convIds },
          userId: { not: userId },
        },
        select: { userId: true, conversationId: true },
      });

      const presencePayload = {
        userId,
        isOnline: false,
        lastSeen: now.toISOString(),
      };

      const notifiedUsers = new Set<string>();
      for (const cm of coMembers) {
        if (!notifiedUsers.has(cm.userId)) {
          notifiedUsers.add(cm.userId);
          this.io.to(`user:${cm.userId}`).emit('user:offline', { ...presencePayload, conversationId: cm.conversationId });
          this.io.to(`user:${cm.userId}`).emit('user:presence', { ...presencePayload, conversationId: cm.conversationId });
        }
        this.io.to(`conversation:${cm.conversationId}`).emit('user:offline', { ...presencePayload, conversationId: cm.conversationId });
        this.io.to(`conversation:${cm.conversationId}`).emit('user:presence', { ...presencePayload, conversationId: cm.conversationId });
      }
    } catch (err) {
      console.error(`[Socket.IO] handleUserOffline error for ${userId}:`, err);
    }
  }

  private setup(httpServer: HttpServer): void {
    this.io = new Server(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      pingTimeout: 20000,
      pingInterval: 25000,
      transports: ['websocket', 'polling'],
    });

    // JWT Authentication for WebSocket (with seamless guest fallback)
    this.io.use((socket, next) => {
      try {
        const auth = socket.handshake.auth;
        const headers = socket.handshake.headers;
        const query = socket.handshake.query;

        let rawToken: any =
          auth?.token ||
          headers?.['authorization'] ||
          query?.token;

        if (!rawToken || typeof rawToken !== 'string' || !rawToken.trim()) {
          socket.data.user = { userId: `guest_${socket.id}`, role: 'GUEST' };
          return next();
        }

        const token = rawToken.replace(/^Bearer\s+/i, '').trim();
        if (!token) {
          socket.data.user = { userId: `guest_${socket.id}`, role: 'GUEST' };
          return next();
        }
        try {
          const payload = JwtUtil.verifyAccessToken(token);
          socket.data.user = payload;
          console.log(`[Socket.IO] Authenticated user: ${payload.userId} (${payload.role})`);
        } catch (tokenErr: any) {
          console.warn(`[Socket.IO] [AUTH] Handshake token verification failed (expired or invalid). Falling back to guest.`);
          socket.data.user = { userId: `guest_${socket.id}`, role: 'GUEST' };
          socket.data.authError = 'Token expired or invalid';
        }
        next();
      } catch (err: any) {
        socket.data.user = { userId: `guest_${socket.id}`, role: 'GUEST' };
        next();
      }
    });

    this.io.on('connection', async (socket: Socket) => {
      const userId = socket.data.user?.userId;
      if (!userId) return;

      const isGuest = userId.startsWith('guest_');
      console.log(`[Socket.IO] ${isGuest ? 'Guest' : 'User'} connected: ${userId}, socket: ${socket.id}`);

      if (socket.data.authError) {
        socket.emit('auth:error', { message: socket.data.authError });
      }

      // Cancel pending offline transition if user reconnected within grace period
      const pendingTimer = this.pendingDisconnectTimers.get(userId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.pendingDisconnectTimers.delete(userId);
        console.log(`[Socket.IO] Cancelled pending offline transition for user ${userId} (reconnected within grace period)`);
      }

      const existing = this.userSockets.get(userId) || [];
      const isFirstSocket = existing.length === 0;
      this.userSockets.set(userId, [...existing, socket.id]);

      // Join user room
      socket.join(`user:${userId}`);
      if (socket.data.user?.role === 'ADMIN') {
        socket.join('admin:disputes');
        socket.join('admin:notifications');
        socket.join('admin:orders');
        socket.join('admin:dashboard');
      }
      if (socket.data.user?.role === 'SELLER') {
        prisma.seller.findFirst({ where: { userId }, select: { id: true } })
          .then((s) => {
            if (s) {
              socket.join(`seller:${s.id}`);
            }
          })
          .catch(() => {});
      }

      // If this is the user's first active connection, announce online status to authorized conversation co-members
      if (isFirstSocket && !isGuest) {
        this.handleUserOnline(userId);
      }

      // Join authorized order room
      socket.on('join:order', async (orderId: string, ack?: (res: any) => void) => {
        try {
          if (!orderId || isGuest) {
            if (ack) ack({ success: false, error: 'Unauthorized to subscribe to order updates' });
            return;
          }
          const cleanOrderId = String(orderId).trim();
          const userRole = socket.data.user?.role;

          let isAuthorized = false;
          if (userRole === 'ADMIN') {
            isAuthorized = true;
          } else {
            const order = await prisma.order.findFirst({
              where: {
                OR: [
                  { id: cleanOrderId },
                  { orderNumber: cleanOrderId },
                  { sellerOrders: { some: { id: cleanOrderId } } },
                  { sellerOrders: { some: { sellerOrderNumber: cleanOrderId } } },
                ],
              },
              select: {
                id: true,
                orderNumber: true,
                userId: true,
                sellerOrders: {
                  select: {
                    id: true,
                    sellerId: true,
                    seller: { select: { userId: true } },
                  },
                },
              },
            });

            if (order) {
              if (order.userId === userId) {
                isAuthorized = true;
              } else if (order.sellerOrders.some((so) => so.seller?.userId === userId || so.sellerId === userId)) {
                isAuthorized = true;
              }
            }
          }

          if (isAuthorized) {
            socket.join(`order:${cleanOrderId}`);
            console.log(`[Socket.IO] User ${userId} (${userRole}) joined authorized order room: order:${cleanOrderId}`);
            if (ack) ack({ success: true, room: `order:${cleanOrderId}` });
          } else {
            console.warn(`[Socket.IO] Unauthorized order subscription rejected for user ${userId} on order ${cleanOrderId}`);
            if (ack) ack({ success: false, error: 'Unauthorized to subscribe to this order' });
          }
        } catch (err: any) {
          console.error(`[Socket.IO] join:order error for ${userId}:`, err);
          if (ack) ack({ success: false, error: 'Failed to join order room' });
        }
      });

      
      // Join authorized dispute room (§ Phase 10)
      socket.on('join:dispute', async (disputeId: string, ack?: (res: any) => void) => {
        try {
          if (!disputeId || isGuest) {
            if (ack) ack({ success: false, error: 'Unauthorized to subscribe to dispute updates' });
            return;
          }
          const cleanDisputeId = String(disputeId).trim();
          const userRole = socket.data.user?.role;

          let isAuthorized = false;
          if (userRole === 'ADMIN') {
            isAuthorized = true;
          } else {
            const dispute = await prisma.dispute.findFirst({
              where: {
                OR: [{ id: cleanDisputeId }, { orderId: cleanDisputeId }],
              },
              select: {
                customerId: true,
                seller: { select: { userId: true } },
              },
            });

            if (dispute) {
              if (dispute.customerId === userId || dispute.seller?.userId === userId) {
                isAuthorized = true;
              }
            } else {
              const refund = await prisma.refundRequest.findFirst({
                where: {
                  OR: [{ id: cleanDisputeId }, { refundNumber: cleanDisputeId }, { orderId: cleanDisputeId }],
                },
                select: {
                  customerId: true,
                  seller: { select: { userId: true } },
                },
              });
              if (refund) {
                if (refund.customerId === userId || refund.seller?.userId === userId) {
                  isAuthorized = true;
                }
              }
            }
          }

          if (isAuthorized) {
            socket.join(`dispute:${cleanDisputeId}`);
            console.log(`[Socket.IO] User ${userId} (${userRole}) joined authorized dispute room: dispute:${cleanDisputeId}`);
            if (ack) ack({ success: true, room: `dispute:${cleanDisputeId}` });
          } else {
            console.warn(`[Socket.IO] Unauthorized dispute subscription rejected for user ${userId} on dispute ${cleanDisputeId}`);
            if (ack) ack({ success: false, error: 'Unauthorized to subscribe to this dispute' });
          }
        } catch (err: any) {
          console.error(`[Socket.IO] join:dispute error for ${userId}:`, err);
          if (ack) ack({ success: false, error: 'Failed to join dispute room' });
        }
      });

      socket.on('leave:dispute', (disputeId: string) => {
        if (disputeId) {
          const cleanDisputeId = String(disputeId).trim();
          socket.leave(`dispute:${cleanDisputeId}`);
          console.log(`[Socket.IO] User ${userId} left dispute room: dispute:${cleanDisputeId}`);
        }
      });

      socket.on('leave:order', (orderId: string) => {
        if (orderId) {
          const cleanOrderId = String(orderId).trim();
          socket.leave(`order:${cleanOrderId}`);
          console.log(`[Socket.IO] User ${userId} left order room: order:${cleanOrderId}`);
        }
      });

      // Join conversation room
      socket.on('join:conversation', async (data: any, ack?: (res: any) => void) => {
        const conversationId = typeof data === 'string' ? data.trim() : (data?.conversationId || data?.id)?.toString().trim();
        if (!conversationId || isGuest) {
          if (ack) ack({ success: false, error: 'Unauthorized to join conversation' });
          return;
        }

        try {
          let baseConvId = conversationId;
          const supConv = await prisma.supportConversation.findFirst({
            where: {
              OR: [{ id: conversationId }, { conversationId }],
            },
            include: { ticket: true },
          });

          if (supConv) {
            baseConvId = supConv.conversationId;
          }

          // Authorize: user must be conversation member, ADMIN, or assigned/requester of support conversation
          const userRole = socket.data.user?.role;
          let isAuthorized = userRole === 'ADMIN';

          if (!isAuthorized) {
            const member = await prisma.conversationMember.findUnique({
              where: {
                conversationId_userId: { conversationId: baseConvId, userId },
              },
            });
            if (member) {
              isAuthorized = true;
            } else if (supConv) {
              if (supConv.requesterId === userId) {
                isAuthorized = true;
              } else {
                const agent = await prisma.supportAgent.findUnique({ where: { adminUserId: userId } });
                if (agent) isAuthorized = true;
              }
            }
          }

          if (!isAuthorized) {
            console.warn(`[Socket.IO] Unauthorized join:conversation rejected for user ${userId} on conversation ${conversationId}`);
            if (ack) ack({ success: false, error: 'Unauthorized to access this conversation' });
            return;
          }

          socket.join(`conversation:${conversationId}`);
          if (supConv) {
            socket.join(`conversation:${supConv.id}`);
            socket.join(`conversation:${supConv.conversationId}`);

            // 1. Direct unread badge clearance upon opening chat room
            const isAgent = userRole === 'ADMIN' || (await prisma.supportAgent.findUnique({ where: { adminUserId: userId } })) !== null;
            const isSeller = userRole === 'SELLER';
            const updateField = isAgent
              ? { unreadAgentCount: 0 }
              : isSeller
              ? { unreadSellerCount: 0 }
              : { unreadCustomerCount: 0 };

            await prisma.supportConversation.update({
              where: { id: supConv.id },
              data: updateField,
            });

            await prisma.conversationMember.updateMany({
              where: { conversationId: supConv.conversationId, userId },
              data: { lastReadAt: new Date() },
            });

            await prisma.message.updateMany({
              where: {
                conversationId: supConv.conversationId,
                senderId: { not: userId },
                isRead: false,
              },
              data: { isRead: true },
            });

            const readData = {
              conversationId: supConv.id,
              baseConversationId: supConv.conversationId,
              readByUserId: userId,
              readAt: new Date().toISOString(),
            };
            this.emitToConversation(supConv.conversationId, 'support:messages:read', readData);
            if (supConv.id !== supConv.conversationId) {
              this.emitToConversation(supConv.id, 'support:messages:read', readData);
            }
            this.emitToConversation(supConv.conversationId, 'message:read', readData);
            if (supConv.id !== supConv.conversationId) {
              this.emitToConversation(supConv.id, 'message:read', readData);
            }

            this.emitToUser(userId, 'support:conversation:read', { conversationId: supConv.id });
            this.emitGlobal('support:queue:updated', { action: 'read', conversationId: supConv.id });

            // 2. Real join when supporter enters the chat room
            if (isAgent && (supConv.status === SupportConversationStatus.QUEUED || !supConv.assignedAgentId)) {
              let agent = await prisma.supportAgent.findUnique({
                where: { adminUserId: userId },
              });
              if (!agent) {
                const adminUser = await prisma.user.findUnique({ where: { id: userId } });
                if (adminUser) {
                  agent = await prisma.supportAgent.create({
                    data: {
                      adminUserId: userId,
                      displayName: `${adminUser.firstName} ${adminUser.lastName}`.trim() || 'موظف الدعم',
                      active: true,
                      online: true,
                      status: SupportAgentStatus.ONLINE,
                    },
                  });
                }
              }
              if (agent && agent.active) {
                await prisma.supportConversation.update({
                  where: { id: supConv.id },
                  data: {
                    assignedAgentId: agent.id,
                    status: SupportConversationStatus.IN_PROGRESS,
                  },
                });
                if (supConv.ticket) {
                  await prisma.supportTicket.update({
                    where: { id: supConv.ticket.id },
                    data: {
                      assignedAgentId: agent.id,
                      status: SupportConversationStatus.IN_PROGRESS,
                    },
                  });
                }
                await prisma.supportAgent.update({
                  where: { id: agent.id },
                  data: { currentActiveChats: { increment: 1 } },
                });

                await prisma.conversationMember.upsert({
                  where: {
                    conversationId_userId: { conversationId: supConv.conversationId, userId },
                  },
                  update: { lastReadAt: new Date() },
                  create: { conversationId: supConv.conversationId, userId, lastReadAt: new Date() },
                });

                // Announce real agent join (deduplicated)
                const existingJoinMsg = await prisma.message.findFirst({
                  where: {
                    conversationId: supConv.conversationId,
                    type: 'system',
                    text: { contains: 'انضم موظف الدعم' },
                  },
                  include: {
                    sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
                  },
                });

                let joinMsg = existingJoinMsg;
                if (!joinMsg) {
                  joinMsg = await prisma.message.create({
                    data: {
                      conversationId: supConv.conversationId,
                      senderId: userId,
                      type: 'system',
                      text: `انضم موظف الدعم ${agent.displayName} للمحادثة لخدمتك.`,
                    },
                    include: {
                      sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
                    },
                  });
                }

                const payload = {
                  id: joinMsg.id,
                  conversationId: supConv.conversationId,
                  senderId: userId,
                  content: joinMsg.text,
                  type: joinMsg.type,
                  isInternal: false,
                  createdAt: joinMsg.createdAt.toISOString(),
                  sender: joinMsg.sender,
                };

                this.emitToConversation(supConv.conversationId, 'message:new', payload);
                if (supConv.id !== supConv.conversationId) {
                  this.emitToConversation(supConv.id, 'message:new', payload);
                }

                const assignPayload = {
                  conversationId: supConv.id,
                  ticketNumber: supConv.ticket?.ticketNumber,
                  agent: { id: agent.id, displayName: agent.displayName, avatar: agent.avatar },
                  status: SupportConversationStatus.IN_PROGRESS,
                };
                this.emitToConversation(supConv.conversationId, 'support:conversation:assigned', assignPayload);
                if (supConv.id !== supConv.conversationId) {
                  this.emitToConversation(supConv.id, 'support:conversation:assigned', assignPayload);
                }
                this.emitGlobal('support:queue:updated', { action: 'claimed', conversationId: supConv.id });
              }
            }
          }

          const conv = await prisma.conversation.findUnique({
            where: { id: baseConvId },
            include: { members: { include: { user: true } } },
          });

          if (conv) {
            // Cache conversation metadata for instant typing & presence dispatch
            const memberIds = conv.members.map((m) => m.userId);
            const cachedMeta = {
              baseConvId,
              altRoom: supConv ? (supConv.id.toLowerCase() === baseConvId.toLowerCase() ? supConv.conversationId : supConv.id) : null,
              memberUserIds: memberIds,
              expiresAt: Date.now() + 5 * 60 * 1000,
            };
            this.conversationMetaCache.set(baseConvId, cachedMeta);
            this.conversationMetaCache.set(conversationId, cachedMeta);
            if (supConv) {
              this.conversationMetaCache.set(supConv.id, cachedMeta);
              this.conversationMetaCache.set(supConv.conversationId, cachedMeta);
            }

            // Update last read timestamp for this member
            await prisma.conversationMember.updateMany({
              where: { conversationId: baseConvId, userId },
              data: { lastReadAt: new Date() },
            });

            // Mark any unread messages sent by others in this conversation as read
            const unreadUpdated = await prisma.message.updateMany({
              where: {
                conversationId: baseConvId,
                senderId: { not: userId },
                isRead: false,
              },
              data: { isRead: true },
            });

            if (unreadUpdated.count > 0 || supConv) {
              const readData = {
                conversationId: baseConvId,
                altConversationId: supConv ? supConv.id : undefined,
                baseConversationId: supConv ? supConv.conversationId : baseConvId,
                readByUserId: userId,
                userId,
                readAt: new Date().toISOString(),
              };
              this.emitToConversation(baseConvId, 'messages:read', readData);
              this.emitToConversation(baseConvId, 'message:read', readData);
              this.emitToConversation(baseConvId, 'support:messages:read', readData);
              if (supConv && supConv.id !== baseConvId) {
                this.emitToConversation(supConv.id, 'messages:read', readData);
                this.emitToConversation(supConv.id, 'message:read', readData);
                this.emitToConversation(supConv.id, 'support:messages:read', readData);
              }
              for (const member of conv.members) {
                if (member.userId !== userId) {
                  this.emitToUser(member.userId, 'messages:read', readData);
                  this.emitToUser(member.userId, 'message:read', readData);
                  this.emitToUser(member.userId, 'support:messages:read', readData);
                }
              }
            }

            for (const member of conv.members) {
              if (member.userId !== userId) {
                const isOnline = this.isUserOnline(member.userId);
                const lastSeen = await this.getLastSeen(member.userId);
                const memberPresence = {
                  userId: member.userId,
                  isOnline,
                  lastSeen: lastSeen ? (lastSeen instanceof Date ? lastSeen.toISOString() : String(lastSeen)) : null,
                  conversationId: baseConvId,
                };
                socket.emit(isOnline ? 'user:online' : 'user:offline', memberPresence);
                socket.emit('user:presence', memberPresence);

                // Immediately inform the other member that THIS user joined/is online
                const myPresence = {
                  userId,
                  isOnline: true,
                  lastSeen: new Date().toISOString(),
                  conversationId: baseConvId,
                };
                this.emitToUser(member.userId, 'user:online', myPresence);
                this.emitToUser(member.userId, 'user:presence', myPresence);
              }
            }
          }

          // Notify other members in this conversation room that user joined/is online
          const joinPresence = {
            userId,
            isOnline: true,
            lastSeen: new Date().toISOString(),
            conversationId,
          };
          socket.to(`conversation:${conversationId}`).emit('user:online', joinPresence);
          socket.to(`conversation:${conversationId}`).emit('user:presence', joinPresence);

          if (ack) ack({ success: true, room: `conversation:${conversationId}` });
        } catch (e) {
          console.error('[Socket.IO] Error in join:conversation:', e);
          if (ack) ack({ success: false, error: 'Internal error joining conversation' });
        }
      });

      // Query presence
      socket.on('get:presence', async (data: any, ack?: (res: any) => void) => {
        const targetUserId = typeof data === 'string'
          ? data.trim()
          : (data?.targetUserId || data?.userId || data?.id)?.toString().trim();
        if (!targetUserId || isGuest) {
          if (ack) ack({ success: false, error: 'Target user ID is required' });
          return;
        }

        // Authorize: Requester must be ADMIN or share at least one conversation with target user
        const userRole = socket.data.user?.role;
        let isAuthorized = userRole === 'ADMIN';
        if (!isAuthorized) {
          const shared = await prisma.conversationMember.findFirst({
            where: {
              userId,
              conversation: {
                members: { some: { userId: targetUserId } },
              },
            },
          });
          if (shared) isAuthorized = true;
        }

        if (!isAuthorized) {
          if (ack) ack({ success: false, error: 'Unauthorized to view presence for this user' });
          return;
        }

        const isOnline = this.isUserOnline(targetUserId);
        const lastSeen = await this.getLastSeen(targetUserId);
        const presencePayload = {
          userId: targetUserId,
          isOnline,
          lastSeen: lastSeen ? (lastSeen instanceof Date ? lastSeen.toISOString() : String(lastSeen)) : null,
        };
        socket.emit(isOnline ? 'user:online' : 'user:offline', presencePayload);
        socket.emit('user:presence', presencePayload);
        if (ack) ack({ success: true, presence: presencePayload });
      });

      // Leave conversation room
      socket.on('leave:conversation', async (data: any) => {
        const conversationId = typeof data === 'string' ? data.trim() : (data?.conversationId || data?.id)?.toString().trim();
        if (!conversationId) return;
        socket.leave(`conversation:${conversationId}`);
        try {
          const supConv = await prisma.supportConversation.findFirst({
            where: { OR: [{ id: conversationId }, { conversationId }] },
          });
          if (supConv) {
            socket.leave(`conversation:${supConv.id}`);
            socket.leave(`conversation:${supConv.conversationId}`);
          }
        } catch (_) {}
      });

      // Unified typing indicators with authorization, in-memory caching, and zero latency
      const handleTypingEvent = async (convId: string, isTyping: boolean) => {
        if (isGuest) return;
        const cleanConvId = convId.trim();
        if (!cleanConvId) return;

        // Rate-limit typing events to prevent abuse
        if (!this.checkTypingRateLimit(userId)) {
          return;
        }

        const typingPayload: any = {
          conversationId: cleanConvId,
          userId,
          isTyping,
        };

        const userRole = socket.data.user?.role;
        const now = Date.now();
        const cached = this.conversationMetaCache.get(cleanConvId);

        // Fast path 1: Instant dispatch from in-memory cached membership (0ms latency)
        if (cached && cached.expiresAt > now) {
          const isAuthorized = userRole === 'ADMIN' || cached.memberUserIds.includes(userId);
          if (!isAuthorized) return;

          typingPayload.altConversationId = cached.altRoom;
          const rawRooms = [cleanConvId, ...(cached.altRoom ? [cached.altRoom] : []), cached.baseConvId];
          const uniqueRooms = Array.from(new Set(rawRooms.filter(Boolean)));

          for (const r of uniqueRooms) {
            socket.to(`conversation:${r}`).emit(isTyping ? 'typing:start' : 'typing:stop', typingPayload);
            socket.to(`conversation:${r}`).emit('typing:status', typingPayload);
          }

          for (const targetUid of cached.memberUserIds) {
            if (targetUid !== userId) {
              this.io.to(`user:${targetUid}`).emit(isTyping ? 'typing:start' : 'typing:stop', typingPayload);
              this.io.to(`user:${targetUid}`).emit('typing:status', typingPayload);
            }
          }
          return;
        }

        // Fast path 2: Socket has already authorized and joined the room in join:conversation
        if (socket.rooms.has(`conversation:${cleanConvId}`)) {
          // Immediately broadcast to conversation room without blocking on DB
          socket.to(`conversation:${cleanConvId}`).emit(isTyping ? 'typing:start' : 'typing:stop', typingPayload);
          socket.to(`conversation:${cleanConvId}`).emit('typing:status', typingPayload);

          // Asynchronously resolve metadata and deliver to co-members' user rooms in background
          this.resolveAndCacheConversationMeta(cleanConvId, userId).then((meta) => {
            if (!meta) return;
            if (meta.altRoom) {
              typingPayload.altConversationId = meta.altRoom;
              socket.to(`conversation:${meta.altRoom}`).emit(isTyping ? 'typing:start' : 'typing:stop', typingPayload);
              socket.to(`conversation:${meta.altRoom}`).emit('typing:status', typingPayload);
            }
            for (const targetUid of meta.memberUserIds) {
              if (targetUid !== userId) {
                this.io.to(`user:${targetUid}`).emit(isTyping ? 'typing:start' : 'typing:stop', typingPayload);
                this.io.to(`user:${targetUid}`).emit('typing:status', typingPayload);
              }
            }
          }).catch(() => {});
          return;
        }

        // Fallback cold path: resolve metadata from database, verify authorization, and emit
        const meta = await this.resolveAndCacheConversationMeta(cleanConvId, userId);
        if (!meta) return;

        const isAuthorized = userRole === 'ADMIN' || meta.memberUserIds.includes(userId);
        if (!isAuthorized) return;

        typingPayload.altConversationId = meta.altRoom;
        const rawRooms = [cleanConvId, ...(meta.altRoom ? [meta.altRoom] : []), meta.baseConvId];
        const uniqueRooms = Array.from(new Set(rawRooms.filter(Boolean)));

        for (const r of uniqueRooms) {
          socket.to(`conversation:${r}`).emit(isTyping ? 'typing:start' : 'typing:stop', typingPayload);
          socket.to(`conversation:${r}`).emit('typing:status', typingPayload);
        }

        for (const targetUid of meta.memberUserIds) {
          if (targetUid !== userId) {
            this.io.to(`user:${targetUid}`).emit(isTyping ? 'typing:start' : 'typing:stop', typingPayload);
            this.io.to(`user:${targetUid}`).emit('typing:status', typingPayload);
          }
        }
      };

      const parseTypingData = (data: any): { convId: string | null; isTyping?: boolean } => {
        if (typeof data === 'string') {
          return { convId: data.trim() };
        }
        const convId = (data?.conversationId || data?.conversation_id || data?.id)?.toString().trim() || null;
        let isTyping: boolean | undefined = undefined;
        if (data?.isTyping !== undefined) {
          isTyping = data.isTyping === true || data.isTyping === 'true' || data.isTyping === 1;
        }
        return { convId, isTyping };
      };

      socket.on('typing:start', async (data: any) => {
        const { convId } = parseTypingData(data);
        if (convId) await handleTypingEvent(convId, true);
      });

      socket.on('support:typing:start', async (data: any) => {
        const { convId } = parseTypingData(data);
        if (convId) await handleTypingEvent(convId, true);
      });

      socket.on('typing:stop', async (data: any) => {
        const { convId } = parseTypingData(data);
        if (convId) await handleTypingEvent(convId, false);
      });

      socket.on('support:typing:stop', async (data: any) => {
        const { convId } = parseTypingData(data);
        if (convId) await handleTypingEvent(convId, false);
      });

      socket.on('typing', async (data: any) => {
        const { convId, isTyping } = parseTypingData(data);
        if (convId) await handleTypingEvent(convId, isTyping !== undefined ? isTyping : true);
      });

      socket.on('typing:status', async (data: any) => {
        const { convId, isTyping } = parseTypingData(data);
        if (convId) await handleTypingEvent(convId, isTyping !== undefined ? isTyping : true);
      });

      // ── Support Chat Center Events ──────────────────────────────────────────

      // Agent sets their active presence / status
      socket.on('support:agent:status', async ({ status }: { status: 'ONLINE' | 'AWAY' | 'BUSY' | 'OFFLINE' }) => {
        try {
          const agent = await prisma.supportAgent.findUnique({ where: { adminUserId: userId } });
          if (agent) {
            const isOnline = status !== 'OFFLINE';
            await prisma.supportAgent.update({
              where: { id: agent.id },
              data: {
                status: status as any,
                online: isOnline,
                lastSeenAt: new Date(),
              },
            });
            // Redis presence with 5 min TTL
            await redis.set(`agent:${agent.id}:presence`, status, 300);
            this.io.emit('support:agent:status_changed', {
              agentId: agent.id,
              displayName: agent.displayName,
              status,
              online: isOnline,
            });
            this.io.emit('support:agent:online', {
              agentId: agent.id,
              displayName: agent.displayName,
              isOnline,
            });
          }
        } catch (e) {
          console.error('[Socket.IO] support:agent:status error:', e);
        }
      });

      // Agent heartbeat (refreshes Redis presence without writing DB)
      socket.on('support:agent:heartbeat', async () => {
        try {
          const agent = await prisma.supportAgent.findUnique({ where: { adminUserId: userId } });
          if (agent) {
            await redis.set(`agent:${agent.id}:presence`, agent.status, 300);
          }
        } catch (_) {}
      });

      // Join/leave support queue room (for Admin dashboard live updates)
      socket.on('join:support_queue', () => {
        if (socket.data.user?.role === 'ADMIN') {
          socket.join('room:support_queue');
        }
      });

      socket.on('leave:support_queue', () => {
        socket.leave('room:support_queue');
      });

      // Messages seen / read receipts
      socket.on('message:seen', async (data: any) => {
        const inputId = typeof data === 'string' ? data.trim() : (data?.conversationId || data?.id)?.toString().trim();
        if (!inputId) return;

        try {
          let baseConvId = inputId;
          let altConvId: string | null = null;
          const supConv = await prisma.supportConversation.findFirst({
            where: { OR: [{ id: inputId }, { conversationId: inputId }] },
            select: { id: true, conversationId: true, requesterId: true, assignedAgent: { select: { adminUserId: true } } },
          });
          if (supConv) {
            baseConvId = supConv.conversationId;
            altConvId = supConv.id;
          }

          const convIds = Array.from(new Set([inputId, baseConvId, ...(altConvId ? [altConvId] : [])]));

          await prisma.conversationMember.updateMany({
            where: { conversationId: { in: convIds }, userId },
            data: { lastReadAt: new Date() },
          });

          await prisma.message.updateMany({
            where: {
              conversationId: { in: convIds },
              senderId: { not: userId },
              isRead: false,
            },
            data: { isRead: true },
          });

          if (supConv) {
            const userRole = socket.data.user?.role;
            const isAgent = userRole === 'ADMIN' || (supConv.assignedAgent?.adminUserId === userId);
            const isSeller = userRole === 'SELLER';
            const updateField = isAgent
              ? { unreadAgentCount: 0 }
              : isSeller
              ? { unreadSellerCount: 0 }
              : { unreadCustomerCount: 0 };
            await prisma.supportConversation.update({
              where: { id: supConv.id },
              data: updateField,
            });
          }

          const readPayload = {
            conversationId: inputId,
            baseConversationId: baseConvId,
            altConversationId: altConvId,
            readByUserId: userId,
            userId,
            readAt: new Date().toISOString(),
          };

          for (const cid of convIds) {
            this.emitToConversation(cid, 'messages:read', readPayload);
            this.emitToConversation(cid, 'message:read', readPayload);
            this.emitToConversation(cid, 'support:messages:read', readPayload);
          }

          const members = await prisma.conversationMember.findMany({
            where: { conversationId: { in: convIds }, userId: { not: userId } },
            select: { userId: true },
          });
          for (const m of members) {
            this.emitToUser(m.userId, 'messages:read', readPayload);
            this.emitToUser(m.userId, 'message:read', readPayload);
            this.emitToUser(m.userId, 'support:messages:read', readPayload);
          }

          // Mark pending chat notifications for this conversation as read
          markChatNotificationsAsRead(baseConvId, userId).catch((err) =>
            console.error('[Notification Read Error]:', err)
          );
        } catch (_) {}
      });

      // Send message via WebSocket
      socket.on('message:send', async (payload: any, ack?: (res: any) => void) => {
        try {
          const { conversationId, text, attachmentUrl, type = 'text', metadata, clientMessageId } = payload;
          if (!conversationId) {
            if (ack) ack({ error: 'conversationId is required' });
            return;
          }

          if (!this.checkMessageRateLimit(userId)) {
            if (ack) ack({ error: `Message rate limit exceeded. Please slow down.` });
            return;
          }

          if (text && typeof text === 'string' && text.length > 4000) {
            if (ack) ack({ error: 'Message text exceeds the 4,000 character limit' });
            return;
          }
          if ((!text || !text.trim()) && !attachmentUrl && type === 'text') {
            if (ack) ack({ error: 'Cannot send empty message' });
            return;
          }

          // Idempotency check
          if (clientMessageId) {
            const existing = await prisma.message.findUnique({
              where: { clientMessageId },
              include: {
                sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
              },
            });
            if (existing) {
              const norm = {
                id: String(existing.id),
                conversationId: String(existing.conversationId),
                senderId: String(existing.senderId),
                content: existing.text || '',
                type: existing.type || 'text',
                metadata: existing.metadata ? (typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : existing.metadata) : null,
                clientMessageId: existing.clientMessageId || null,
                createdAt: existing.createdAt.toISOString(),
                imageUrl: existing.type === 'image' ? existing.attachmentUrl : null,
                fileUrl: existing.type === 'file' ? existing.attachmentUrl : null,
                fileName: existing.type === 'file' ? existing.text : null,
                fileSize: null,
                isRead: Boolean(existing.isRead),
                readAt: null,
                reactions: {},
                sender: existing.sender || null,
              };
              if (ack) ack({ success: true, message: norm });
              return;
            }
          }

          const member = await prisma.conversationMember.findUnique({
            where: { conversationId_userId: { conversationId, userId } },
          });
          if (!member) {
            if (ack) ack({ error: 'Unauthorized or not a member' });
            return;
          }

          const blockedMember = await prisma.conversationMember.findFirst({
            where: {
              conversationId,
              blocked: true,
            },
          });
          if (blockedMember) {
            if (ack) ack({ error: 'This conversation is blocked. New messages cannot be sent.' });
            return;
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
            const userRecord = await prisma.user.findUnique({
              where: { id: userId },
              select: { role: true },
            });
            const verifiedOrder = await verifyOrderPayload(reqOrderId, userId, userRecord?.role || 'CUSTOMER');
            if (verifiedOrder) {
              finalMetadata = verifiedOrder;
            } else {
              if (ack) ack({ error: 'You do not have permission to share this order' });
              return;
            }
          }

          const metadataStr = finalMetadata ? (typeof finalMetadata === 'string' ? finalMetadata : JSON.stringify(finalMetadata)) : null;

          const allMembers = await prisma.conversationMember.findMany({
            where: { conversationId },
            select: { userId: true },
          });

          let supConvForCheck: any = null;
          try {
            supConvForCheck = await prisma.supportConversation.findFirst({
              where: { OR: [{ id: conversationId }, { conversationId }] },
            });
          } catch (_) {}

          const roomIdsToCheck = Array.from(new Set([conversationId, ...(supConvForCheck ? [supConvForCheck.id, supConvForCheck.conversationId] : [])]));

          // Check if the other member is already viewing the conversation room (support or regular)
          const isRecipientViewing = allMembers.some(
            (m) => m.userId !== userId && roomIdsToCheck.some((rid) => this.isUserInConversation(m.userId, rid))
          );

          const created = await prisma.$transaction(async (tx) => {
            const msg = await tx.message.create({
              data: {
                conversationId,
                senderId: userId,
                type: validatedType,
                text: text || '',
                attachmentUrl: attachmentUrl || null,
                metadata: metadataStr,
                clientMessageId: clientMessageId || null,
                isRead: isRecipientViewing,
              },
              include: {
                sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
              },
            });

            await tx.conversation.update({
              where: { id: conversationId },
              data: {
                updatedAt: new Date(),
                lastMessageId: msg.id,
              },
            });

            return msg;
          });

          const norm = {
            id: String(created.id),
            conversationId: String(created.conversationId),
            senderId: String(created.senderId),
            content: created.text || '',
            type: created.type || 'text',
            metadata: metadata,
            clientMessageId: created.clientMessageId || null,
            createdAt: created.createdAt.toISOString(),
            imageUrl: created.type === 'image' ? created.attachmentUrl : null,
            fileUrl: created.type === 'file' ? created.attachmentUrl : null,
            fileName: created.type === 'file' ? created.text : null,
            fileSize: null,
            isRead: Boolean(created.isRead),
            readAt: isRecipientViewing ? new Date().toISOString() : null,
            reactions: {},
            sender: created.sender || null,
          };

          // Broadcast to conversation room (single canonical event 'message:new')
          this.io.to(`conversation:${conversationId}`).emit('message:new', norm);

          if (isRecipientViewing) {
            const otherMember = allMembers.find((m) => m.userId !== userId);
            const readPayload = {
              conversationId,
              baseConversationId: supConvForCheck ? supConvForCheck.conversationId : conversationId,
              altConversationId: supConvForCheck ? supConvForCheck.id : null,
              messageId: String(created.id),
              readByUserId: otherMember?.userId || '',
              userId,
              readAt: new Date().toISOString(),
            };
            this.emitToUser(userId, 'messages:read', readPayload);
            this.emitToUser(userId, 'message:read', readPayload);
            this.emitToUser(userId, 'support:messages:read', readPayload);

            for (const rid of roomIdsToCheck) {
              this.emitToConversation(rid, 'messages:read', readPayload);
              this.emitToConversation(rid, 'message:read', readPayload);
              this.emitToConversation(rid, 'support:messages:read', readPayload);
            }
          }

          try {
            const supConv = await prisma.supportConversation.findFirst({
              where: { OR: [{ id: conversationId }, { conversationId }] },
            });
            if (supConv) {
              if (supConv.id !== conversationId) {
                this.io.to(`conversation:${supConv.id}`).emit('message:new', norm);
              }
              if (supConv.conversationId !== conversationId) {
                this.io.to(`conversation:${supConv.conversationId}`).emit('message:new', norm);
              }
              if (supConv.requesterId && !this.isUserInConversation(supConv.requesterId, conversationId)) {
                this.io.to(`user:${supConv.requesterId}`).emit('message:new', norm);
              }
            }
          } catch (_) {}

          // Notify members who are NOT currently in the active conversation room
          for (const m of allMembers) {
            if (!this.isUserInConversation(m.userId, conversationId)) {
              this.io.to(`user:${m.userId}`).emit('message:new', norm);
            }
          }

          // Push notifications to offline recipients
          sendChatNotification({
            conversationId,
            senderId: userId,
            messageId: created.id,
            type: validatedType,
            text: text || '',
            metadata: metadata,
          }).catch((err) => console.error('[Notification Error]:', err));

          if (ack) ack({ success: true, message: norm });
        } catch (err: any) {
          console.error('[Socket.IO] message:send error:', err);
          if (ack) ack({ error: err?.message || 'Server error' });
        }
      });

      // Message reaction
      socket.on('message:reaction', async ({ messageId, emoji, conversationId }: { messageId: string; emoji: string; conversationId?: string }) => {
        try {
          if (!messageId || !emoji) return;

          const msg = await prisma.message.findUnique({
            where: { id: messageId },
            select: { id: true, conversationId: true, metadata: true },
          });

          if (!msg) return;

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

          if (!Array.isArray(reactions[emoji])) {
            reactions[emoji] = [];
          }

          const existingIndex = reactions[emoji].indexOf(userId);
          if (existingIndex > -1) {
            reactions[emoji].splice(existingIndex, 1);
            if (reactions[emoji].length === 0) {
              delete reactions[emoji];
            }
          } else {
            reactions[emoji].push(userId);
          }

          meta.reactions = reactions;

          await prisma.message.update({
            where: { id: messageId },
            data: { metadata: JSON.stringify(meta) },
          });

          const targetConvId = conversationId || msg.conversationId;
          const payload = {
            messageId,
            emoji,
            userId,
            conversationId: targetConvId,
            reactions,
          };

          this.io.to(`conversation:${targetConvId}`).emit('message:reaction', payload);
          socket.emit('message:reaction', payload);
        } catch (err) {
          console.error('[Socket.IO] message:reaction error:', err);
        }
      });

      // Disconnect handling with multi-socket support and configurable grace period
      socket.on('disconnect', () => {
        const sockets = this.userSockets.get(userId) || [];
        const filtered = sockets.filter((id) => id !== socket.id);
        if (filtered.length > 0) {
          this.userSockets.set(userId, filtered);
          console.log(`[Socket.IO] Socket ${socket.id} disconnected for user ${userId}, remaining active sockets: ${filtered.length}`);
        } else {
          this.userSockets.delete(userId);
          console.log(`[Socket.IO] Last socket disconnected for user ${userId}. Starting ${this.DISCONNECT_GRACE_PERIOD_MS}ms grace period.`);

          if (!isGuest) {
            const timer = setTimeout(async () => {
              this.pendingDisconnectTimers.delete(userId);
              const remainingSockets = this.userSockets.get(userId);
              if (!remainingSockets || remainingSockets.length === 0) {
                console.log(`[Socket.IO] Grace period expired for user ${userId}. Transitioning to OFFLINE.`);
                await this.handleUserOffline(userId);
              }
            }, this.DISCONNECT_GRACE_PERIOD_MS);
            this.pendingDisconnectTimers.set(userId, timer);
          }

          // If user was a support agent, update agent offline status in background
          prisma.supportAgent.findUnique({ where: { adminUserId: userId } }).then((agent) => {
            if (agent) {
              const now = new Date();
              prisma.supportAgent.update({
                where: { id: agent.id },
                data: { online: false, status: SupportAgentStatus.OFFLINE, lastSeenAt: now },
              }).then(() => {
                redis.set(`agent:${agent.id}:presence`, 'OFFLINE', 60);
                this.io.emit('support:agent:offline', {
                  agentId: agent.id,
                  displayName: agent.displayName,
                  lastSeen: now.toISOString(),
                });
                this.io.emit('support:agent:status_changed', {
                  agentId: agent.id,
                  status: 'OFFLINE',
                  online: false,
                });
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      });
    });
  }


  async emitDisputeUpdate(disputeId: string, event: string, data: any, sellerUserId?: string): Promise<void> {
    if (!this.io) return;
    this.io.to(`dispute:${disputeId}`).emit(event, data);
    this.io.to('admin:disputes').emit(event, data);

    let sUserId = sellerUserId || data?.sellerUserId || data?.seller?.userId;
    if (!sUserId && data?.sellerId) {
      try {
        const seller = await prisma.seller.findUnique({
          where: { id: data.sellerId },
          select: { userId: true },
        });
        if (seller) sUserId = seller.userId;
      } catch (_) {}
    }
    if (sUserId) {
      this.io.to(`user:${sUserId}`).emit(event, data);
    }
    if (data?.sellerId) {
      this.io.to(`seller:${data.sellerId}`).emit(event, data);
    }
    if (data?.customerId) {
      this.io.to(`user:${data.customerId}`).emit(event, data);
    }
  }

  emitNotificationBadge(userId: string, unreadCount: number): void {
    if (this.io) {
      this.io.to(`user:${userId}`).emit('notification:badge', { unreadCount });
      this.io.to(`user:${userId}`).emit('notification:unread_count', { unreadCount });
    }
  }

  emitToUser(userId: string, event: string, data: any): void {
    if (this.io) {
      this.io.to(`user:${userId}`).emit(event, data);
      this.io.to(`seller:${userId}`).emit(event, data);
    }
  }

  emitToConversation(conversationId: string, event: string, data: any): void {
    if (this.io) {
      this.io.to(`conversation:${conversationId}`).emit(event, data);
      const extraId1 = data?.baseConversationId || data?.message?.baseConversationId;
      if (extraId1 && extraId1 !== conversationId) {
        this.io.to(`conversation:${extraId1}`).emit(event, data);
      }
      const extraId2 = data?.conversationId || data?.message?.conversationId;
      if (extraId2 && extraId2 !== conversationId && extraId2 !== extraId1) {
        this.io.to(`conversation:${extraId2}`).emit(event, data);
      }
      const extraId3 = data?.supportConversationId || data?.message?.supportConversationId;
      if (extraId3 && extraId3 !== conversationId && extraId3 !== extraId1 && extraId3 !== extraId2) {
        this.io.to(`conversation:${extraId3}`).emit(event, data);
      }
    }
  }

  emitToRoom(room: string, event: string, data: any): void {
    if (this.io) {
      this.io.to(room).emit(event, data);
    }
  }

  emitToOrder(orderId: string, event: string, data: any): void {
    if (this.io) {
      this.io.to(`order:${orderId}`).emit(event, data);
    }
  }

  emitOrderStatusUpdate(params: {
    orderId: string;
    orderNumber: string;
    displayOrderNumber?: string;
    sellerOrderId?: string;
    sellerOrderNumber?: string;
    status: string;
    parentStatus?: string;
    version?: number;
    timestamp?: string;
    changedByRole: string;
    customerUserId?: string;
    sellerUserIds?: string[];
    extra?: Record<string, any>;
  }): void {
    if (!this.io) return;
    const {
      orderId,
      orderNumber,
      displayOrderNumber,
      sellerOrderId,
      sellerOrderNumber,
      status,
      parentStatus,
      version = Date.now(),
      timestamp = new Date().toISOString(),
      changedByRole,
      customerUserId,
      sellerUserIds = [],
      extra = {},
    } = params;

    const payload = {
      eventId: randomUUID(),
      orderId,
      orderNumber,
      displayOrderNumber: displayOrderNumber || orderNumber,
      sellerOrderId,
      sellerOrderNumber,
      status,
      parentStatus: parentStatus || status,
      version,
      timestamp,
      changedByRole,
      ...extra,
    };

    const specificEvent = `order:${status.toLowerCase()}`;

    // 1. Emit to order rooms (orderId, orderNumber, displayOrderNumber, sellerOrderId, sellerOrderNumber)
    this.io.to(`order:${orderId}`).emit('order:status', payload);
    this.io.to(`order:${orderId}`).emit(specificEvent, payload);
    if (orderNumber && orderNumber !== orderId) {
      this.io.to(`order:${orderNumber}`).emit('order:status', payload);
      this.io.to(`order:${orderNumber}`).emit(specificEvent, payload);
    }
    if (displayOrderNumber && displayOrderNumber !== orderId && displayOrderNumber !== orderNumber) {
      this.io.to(`order:${displayOrderNumber}`).emit('order:status', payload);
      this.io.to(`order:${displayOrderNumber}`).emit(specificEvent, payload);
    }
    if (sellerOrderId && sellerOrderId !== orderId) {
      this.io.to(`order:${sellerOrderId}`).emit('order:status', payload);
      this.io.to(`order:${sellerOrderId}`).emit(specificEvent, payload);
    }
    if (sellerOrderNumber && sellerOrderNumber !== sellerOrderId) {
      this.io.to(`order:${sellerOrderNumber}`).emit('order:status', payload);
      this.io.to(`order:${sellerOrderNumber}`).emit(specificEvent, payload);
    }

    // 2. Emit to Customer's private room
    if (customerUserId) {
      redis.del(`order_summary:${customerUserId}`).catch(() => {});
      this.io.to(`user:${customerUserId}`).emit('order:status', payload);
      this.io.to(`user:${customerUserId}`).emit(specificEvent, payload);
      this.io.to(`user:${customerUserId}`).emit('order:summary_updated', {
        orderId,
        orderNumber,
        status: payload.parentStatus,
        timestamp,
      });
    }

    // 3. Emit to all associated Seller private rooms
    for (const sUserId of sellerUserIds) {
      if (sUserId) {
        this.io.to(`user:${sUserId}`).emit('order:status', payload);
        this.io.to(`user:${sUserId}`).emit(specificEvent, payload);
        this.io.to(`user:${sUserId}`).emit('seller:order_updated', payload);
        if (status === 'PENDING' || status === 'CONFIRMED') {
          this.io.to(`user:${sUserId}`).emit('seller:new_order', payload);
          this.io.to(`user:${sUserId}`).emit('order:created', payload);
        }
      }
    }

    // 4. Emit to Admin orders room
    this.io.to('admin:orders').emit('order:status', payload);
    this.io.to('admin:orders').emit(specificEvent, payload);
    this.io.to('admin:dashboard').emit('admin:order_count_updated', { status, orderId });
  }

  emitGlobal(event: string, data: any): void {
    if (this.io) {
      this.io.emit(event, data);
    }
  }
}
