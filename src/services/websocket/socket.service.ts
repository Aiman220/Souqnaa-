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

  async getLastSeen(userId: string): Promise<Date | null> {
    const memoryLastSeen = this.userLastSeen.get(userId);
    if (memoryLastSeen) return memoryLastSeen;
    try {
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

  private setup(httpServer: HttpServer): void {
    this.io = new Server(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
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
        try {
          const payload = JwtUtil.verifyAccessToken(token);
          socket.data.user = payload;
          console.log(`[Socket.IO] Authenticated user: ${payload.userId} (${payload.role})`);
        } catch (_) {
          socket.data.user = { userId: `guest_${socket.id}`, role: 'GUEST' };
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
      const existing = this.userSockets.get(userId) || [];
      this.userSockets.set(userId, [...existing, socket.id]);

      // Join user room
      socket.join(`user:${userId}`);

      // Broadcast user online only for real authenticated users
      if (!isGuest) {
        this.io.emit('user:online', {
          userId,
          isOnline: true,
        });
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

      socket.on('leave:order', (orderId: string) => {
        if (orderId) {
          const cleanOrderId = String(orderId).trim();
          socket.leave(`order:${cleanOrderId}`);
          console.log(`[Socket.IO] User ${userId} left order room: order:${cleanOrderId}`);
        }
      });

      // Join conversation room
      socket.on('join:conversation', async (conversationId: string) => {
        console.log(`[Socket.IO] User ${userId} joined room conversation:${conversationId}`);
        socket.join(`conversation:${conversationId}`);

        // Check if other members of the conversation are online
        try {
          let baseConvId = conversationId;
          const supConv = await prisma.supportConversation.findFirst({
            where: {
              OR: [{ id: conversationId }, { conversationId }],
            },
            include: { ticket: true },
          });

          if (supConv) {
            socket.join(`conversation:${supConv.id}`);
            socket.join(`conversation:${supConv.conversationId}`);
            baseConvId = supConv.conversationId;

            // 1. Direct unread badge clearance upon opening chat room
            const userRole = socket.data.user?.role;
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
            for (const member of conv.members) {
              if (member.userId !== userId) {
                const isOnline = this.isUserOnline(member.userId);
                const lastSeen = await this.getLastSeen(member.userId);
                socket.emit(isOnline ? 'user:online' : 'user:offline', {
                  userId: member.userId,
                  isOnline,
                  lastSeen: lastSeen ? (lastSeen instanceof Date ? lastSeen.toISOString() : String(lastSeen)) : null,
                  conversationId,
                });
              }
            }
          }
        } catch (e) {
          console.error('[Socket.IO] Error in join:conversation:', e);
        }

        // Notify other members in this conversation that user joined/is online
        socket.to(`conversation:${conversationId}`).emit('user:online', {
          userId,
          isOnline: true,
          conversationId,
        });
      });

      // Query presence
      socket.on('get:presence', async ({ targetUserId }: { targetUserId: string }) => {
        if (!targetUserId) return;
        const isOnline = this.isUserOnline(targetUserId);
        const lastSeen = await this.getLastSeen(targetUserId);
        socket.emit(isOnline ? 'user:online' : 'user:offline', {
          userId: targetUserId,
          isOnline,
          lastSeen: lastSeen ? (lastSeen instanceof Date ? lastSeen.toISOString() : String(lastSeen)) : null,
        });
      });

      // Leave conversation room
      socket.on('leave:conversation', async (conversationId: string) => {
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

      // Unified typing indicators (handles typing:start, typing:stop, support:typing:start, support:typing:stop)
      const handleTypingEvent = async (convId: string, isTyping: boolean) => {
        let altRoom: string | null = null;
        try {
          const supConv = await prisma.supportConversation.findFirst({
            where: { OR: [{ id: convId }, { conversationId: convId }] },
          });
          if (supConv) {
            altRoom = supConv.id === convId ? supConv.conversationId : supConv.id;
          }
        } catch (_) {}

        const typingPayload = {
          conversationId: convId,
          userId,
          isTyping,
        };

        const rooms = [convId, ...(altRoom ? [altRoom] : [])];
        for (const r of rooms) {
          const payload = {
            conversationId: r,
            altConversationId: altRoom,
            userId,
            isTyping,
          };
          socket.to(`conversation:${r}`).emit(isTyping ? 'typing:start' : 'typing:stop', payload);
          socket.to(`conversation:${r}`).emit('typing:status', payload);
          socket.to(`conversation:${r}`).emit('support:typing', payload);
        }
      };

      socket.on('typing:start', async (data: any) => {
        const convId = typeof data === 'string' ? data : data?.conversationId;
        if (convId) await handleTypingEvent(convId, true);
      });

      socket.on('support:typing:start', async (data: any) => {
        const convId = typeof data === 'string' ? data : data?.conversationId;
        if (convId) await handleTypingEvent(convId, true);
      });

      socket.on('typing:stop', async (data: any) => {
        const convId = typeof data === 'string' ? data : data?.conversationId;
        if (convId) await handleTypingEvent(convId, false);
      });

      socket.on('support:typing:stop', async (data: any) => {
        const convId = typeof data === 'string' ? data : data?.conversationId;
        if (convId) await handleTypingEvent(convId, false);
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
      socket.on('message:seen', async ({ conversationId }: { conversationId: string }) => {
        try {
          await prisma.conversationMember.update({
            where: { conversationId_userId: { conversationId, userId } },
            data: { lastReadAt: new Date() },
          });

          await prisma.message.updateMany({
            where: {
              conversationId,
              senderId: { not: userId },
              isRead: false,
            },
            data: { isRead: true },
          });

          socket.to(`conversation:${conversationId}`).emit('messages:read', {
            conversationId,
            userId,
            readAt: new Date().toISOString(),
          });
          socket.to(`conversation:${conversationId}`).emit('message:read', {
            conversationId,
            userId,
          });

          // Mark pending chat notifications for this conversation as read
          markChatNotificationsAsRead(conversationId, userId).catch((err) =>
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
            readAt: null,
            reactions: {},
            sender: created.sender || null,
          };

          // Broadcast to conversation room and individual user rooms
          this.io.to(`conversation:${conversationId}`).emit('message:new', norm);
          this.io.to(`conversation:${conversationId}`).emit('new:message', norm);

          const allMembers = await prisma.conversationMember.findMany({
            where: { conversationId },
            select: { userId: true },
          });
          for (const m of allMembers) {
            this.io.to(`user:${m.userId}`).emit('message:new', norm);
            this.io.to(`user:${m.userId}`).emit('new:message', norm);
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

      // Disconnect
      socket.on('disconnect', () => {
        const sockets = this.userSockets.get(userId) || [];
        const filtered = sockets.filter((id) => id !== socket.id);
        if (filtered.length > 0) {
          this.userSockets.set(userId, filtered);
        } else {
          this.userSockets.delete(userId);
          const now = new Date();
          this.userLastSeen.set(userId, now);
          this.io.emit('user:offline', {
            userId,
            isOnline: false,
            lastSeen: now.toISOString(),
          });
          this.io.emit('user:last_seen', {
            userId,
            lastSeen: now.toISOString(),
          });

          // If user was a support agent, update agent offline status in background
          prisma.supportAgent.findUnique({ where: { adminUserId: userId } }).then((agent) => {
            if (agent) {
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

  emitToUser(userId: string, event: string, data: any): void {
    if (this.io) {
      this.io.to(`user:${userId}`).emit(event, data);
    }
  }

  emitToConversation(conversationId: string, event: string, data: any): void {
    if (this.io) {
      this.io.to(`conversation:${conversationId}`).emit(event, data);
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
    sellerOrderId?: string;
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
      sellerOrderId,
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
      sellerOrderId,
      status,
      parentStatus: parentStatus || status,
      version,
      timestamp,
      changedByRole,
      ...extra,
    };

    const specificEvent = `order:${status.toLowerCase()}`;

    // 1. Emit to order rooms (orderId, orderNumber, sellerOrderId)
    this.io.to(`order:${orderId}`).emit('order:status', payload);
    this.io.to(`order:${orderId}`).emit(specificEvent, payload);
    if (orderNumber && orderNumber !== orderId) {
      this.io.to(`order:${orderNumber}`).emit('order:status', payload);
      this.io.to(`order:${orderNumber}`).emit(specificEvent, payload);
    }
    if (sellerOrderId && sellerOrderId !== orderId) {
      this.io.to(`order:${sellerOrderId}`).emit('order:status', payload);
      this.io.to(`order:${sellerOrderId}`).emit(specificEvent, payload);
    }

    // 2. Emit to Customer's private room
    if (customerUserId) {
      this.io.to(`user:${customerUserId}`).emit('order:status', payload);
      this.io.to(`user:${customerUserId}`).emit(specificEvent, payload);
    }

    // 3. Emit to all associated Seller private rooms
    for (const sUserId of sellerUserIds) {
      if (sUserId) {
        this.io.to(`user:${sUserId}`).emit('order:status', payload);
        this.io.to(`user:${sUserId}`).emit(specificEvent, payload);
      }
    }

    // 4. Emit to Admin orders room
    this.io.to('admin:orders').emit('order:status', payload);
    this.io.to('admin:orders').emit(specificEvent, payload);

    // 5. Global broadcast for backward compatibility
    this.io.emit('order:status', payload);
    this.io.emit(specificEvent, payload);
  }

  emitGlobal(event: string, data: any): void {
    if (this.io) {
      this.io.emit(event, data);
    }
  }
}
