import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import {
  SupportRequesterType,
  SupportPriority,
  SupportConversationStatus,
  SupportAgentStatus,
  UserRoleType,
} from '@prisma/client';
import { AppError } from '../../middleware/error.middleware';
import { SocketService } from '../../services/websocket/socket.service';
import { sendChatNotification } from '../chat/chat.notification';

export interface CreateSupportConversationDto {
  requesterType: SupportRequesterType;
  requesterId: string;
  subject: string;
  categoryId?: string;
  departmentId?: string;
  priority?: SupportPriority;
  relatedOrderId?: string;
  relatedSellerOrderId?: string;
  relatedProductId?: string;
  initialMessage?: string;
  attachmentUrl?: string;
}

export class SupportService {
  /**
   * Generate a server-side authoritative human-readable ticket number (e.g. SUP-2026-000001).
   */
  static async generateTicketNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await prisma.supportTicket.count();
    const sequence = String(count + 1).padStart(6, '0');
    let ticketNum = `SUP-${year}-${sequence}`;

    // Ensure uniqueness
    const exists = await prisma.supportTicket.findUnique({ where: { ticketNumber: ticketNum } });
    if (exists) {
      const randSuffix = Math.floor(1000 + Math.random() * 9000);
      ticketNum = `SUP-${year}-${sequence}-${randSuffix}`;
    }
    return ticketNum;
  }

  /**
   * Determine SLA deadlines based on priority.
   */
  static async calculateSlaDeadlines(priority: SupportPriority): Promise<{
    firstResponseDueAt: Date;
    resolutionDueAt: Date;
  }> {
    const policy = await prisma.supportSlaPolicy.findUnique({
      where: { priority },
    });

    const firstResponseMins = policy?.firstResponseMinutes || (priority === SupportPriority.URGENT ? 2 : priority === SupportPriority.HIGH ? 5 : 15);
    const resolutionMins = policy?.resolutionMinutes || (priority === SupportPriority.URGENT ? 30 : priority === SupportPriority.HIGH ? 60 : 120);

    const now = new Date();
    return {
      firstResponseDueAt: new Date(now.getTime() + firstResponseMins * 60 * 1000),
      resolutionDueAt: new Date(now.getTime() + resolutionMins * 60 * 1000),
    };
  }

  /**
   * Create a new support conversation and ticket, place in queue, and attempt auto-assignment.
   */
  static async createConversation(dto: CreateSupportConversationDto): Promise<any> {
    const {
      requesterType,
      requesterId,
      subject,
      categoryId,
      relatedOrderId,
      relatedSellerOrderId,
      relatedProductId,
      initialMessage,
      attachmentUrl,
    } = dto;

    // Validate category & resolve department
    let resolvedDepartmentId = dto.departmentId;
    let priority = dto.priority || SupportPriority.NORMAL;

    if (categoryId) {
      const cat = await prisma.supportCategory.findUnique({ where: { id: categoryId } });
      if (cat) {
        if (!resolvedDepartmentId && cat.departmentId) {
          resolvedDepartmentId = cat.departmentId;
        }
        if (!dto.priority && cat.priority) {
          priority = cat.priority;
        }
      }
    }

    // Fallback to General Support department if still undefined
    if (!resolvedDepartmentId) {
      const generalDept = await prisma.supportDepartment.findFirst({
        where: { name: 'GENERAL_SUPPORT' },
      });
      if (generalDept) {
        resolvedDepartmentId = generalDept.id;
      }
    }

    const { firstResponseDueAt, resolutionDueAt } = await this.calculateSlaDeadlines(priority);
    const ticketNumber = await this.generateTicketNumber();

    // Verify related authoritative entities
    if (relatedOrderId) {
      const order = await prisma.order.findUnique({
        where: { id: relatedOrderId },
        select: { id: true, orderNumber: true, userId: true },
      });
      if (order && requesterType === SupportRequesterType.CUSTOMER) {
        if (order.userId !== requesterId) {
          throw new AppError('Unauthorized: You can only reference your own orders.', 403);
        }
      }
    }

    const convType = requesterType === SupportRequesterType.CUSTOMER ? 'SUPPORT_CUSTOMER' : 'SUPPORT_SELLER';

    // Transactional creation
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create base Conversation
      const baseConv = await tx.conversation.create({
        data: {
          title: `${ticketNumber} - ${subject}`,
          type: convType,
          status: 'ACTIVE',
        },
      });

      // 2. Add requester as conversation member
      await tx.conversationMember.create({
        data: {
          conversationId: baseConv.id,
          userId: requesterId,
        },
      });

      // 3. Create SupportConversation
      const supportConv = await tx.supportConversation.create({
        data: {
          conversationId: baseConv.id,
          requesterType,
          requesterId,
          departmentId: resolvedDepartmentId || null,
          categoryId: categoryId || null,
          priority,
          status: SupportConversationStatus.QUEUED,
          subject,
          firstResponseDueAt,
          resolutionDueAt,
        },
      });

      // 4. Create SupportTicket
      const ticket = await tx.supportTicket.create({
        data: {
          ticketNumber,
          supportConversationId: supportConv.id,
          requesterType,
          requesterId,
          categoryId: categoryId || null,
          subject,
          priority,
          status: SupportConversationStatus.QUEUED,
          departmentId: resolvedDepartmentId || null,
          relatedOrderId: relatedOrderId || null,
          relatedSellerOrderId: relatedSellerOrderId || null,
          relatedProductId: relatedProductId || null,
        },
      });

      // 5. Initial Message if provided
      let firstMsg: any = null;
      if (initialMessage && initialMessage.trim()) {
        firstMsg = await tx.message.create({
          data: {
            conversationId: baseConv.id,
            senderId: requesterId,
            type: attachmentUrl ? 'image' : 'text',
            text: initialMessage.trim(),
            attachmentUrl: attachmentUrl || null,
          },
          include: {
            sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          },
        });

        await tx.conversation.update({
          where: { id: baseConv.id },
          data: { lastMessageId: firstMsg.id, updatedAt: new Date() },
        });

        await tx.supportConversation.update({
          where: { id: supportConv.id },
          data: {
            lastMessageId: firstMsg.id,
            lastMessageAt: firstMsg.createdAt,
            unreadAgentCount: 1,
          },
        });
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          userId: requesterId,
          action: 'SUPPORT_CONVERSATION_CREATED',
          resource: 'support_conversations',
          details: JSON.stringify({
            ticketNumber,
            supportConversationId: supportConv.id,
            priority,
            departmentId: resolvedDepartmentId,
          }),
        },
      });

      return { baseConv, supportConv, ticket, firstMsg };
    });

    // Notify WebSocket subscribers of queue update
    try {
      const io = SocketService.get();
      if (io) {
        io.emitGlobal('support:conversation:created', {
          conversationId: result.baseConv.id,
          ticketNumber: result.ticket.ticketNumber,
          status: SupportConversationStatus.QUEUED,
          priority,
          requesterId,
          requesterType,
          subject,
          createdAt: result.supportConv.createdAt,
        });
        io.emitGlobal('support:queue:updated', { action: 'created', ticketNumber: result.ticket.ticketNumber });
      }
    } catch (_) {}

    // Conversation remains QUEUED until a real agent claims it or responds
    return this.getConversationById(result.baseConv.id, requesterId);
  }

  /**
   * Concurrency-safe Auto-Assignment Engine.
   * Strategy:
   * 1. Matches Department.
   * 2. Checks active & online agents with status != OFFLINE.
   * 3. Checks available slots (currentActiveChats < maxConcurrentChats).
   * 4. Selects agent with lowest currentActiveChats (least active).
   * 5. Atomically assigns with transactional row lock.
   */
  static async attemptAutoAssignment(supportConversationId: string): Promise<boolean> {
    try {
      return await prisma.$transaction(async (tx) => {
        // Re-read conversation with row lock verification
        const conv = await tx.supportConversation.findFirst({
          where: {
            OR: [{ id: supportConversationId }, { conversationId: supportConversationId }],
          },
          include: { department: true, ticket: true },
        });

        if (!conv || conv.status !== SupportConversationStatus.QUEUED) {
          return false;
        }

        if (conv.department && !conv.department.autoAssignmentEnabled) {
          return false;
        }

        // Query eligible agents
        const eligibleAgents = await tx.supportAgent.findMany({
          where: {
            active: true,
            online: true,
            status: { not: SupportAgentStatus.OFFLINE },
            departments: conv.departmentId ? { some: { departmentId: conv.departmentId } } : undefined,
          },
          orderBy: [
            { currentActiveChats: 'asc' },
            { updatedAt: 'asc' },
          ],
        });

        // Filter by capacity
        const candidate = eligibleAgents.find((a) => a.currentActiveChats < a.maxConcurrentChats);

        if (!candidate) {
          // No agent available -> stays in QUEUED
          return false;
        }

        // Atomic assignment
        await tx.supportAgent.update({
          where: { id: candidate.id },
          data: { currentActiveChats: { increment: 1 } },
        });

        const updatedConv = await tx.supportConversation.update({
          where: { id: conv.id },
          data: {
            assignedAgentId: candidate.id,
            status: SupportConversationStatus.ASSIGNED,
          },
        });

        if (conv.ticket) {
          await tx.supportTicket.update({
            where: { id: conv.ticket.id },
            data: {
              assignedAgentId: candidate.id,
              status: SupportConversationStatus.ASSIGNED,
            },
          });
        }

        // Add agent as member in base Conversation
        const existingMember = await tx.conversationMember.findUnique({
          where: {
            conversationId_userId: {
              conversationId: conv.conversationId,
              userId: candidate.adminUserId,
            },
          },
        });

        if (!existingMember) {
          await tx.conversationMember.create({
            data: {
              conversationId: conv.conversationId,
              userId: candidate.adminUserId,
            },
          });
        }

        // Audit log
        await tx.auditLog.create({
          data: {
            userId: candidate.adminUserId,
            action: 'SUPPORT_CONVERSATION_ASSIGNED_AUTO',
            resource: 'support_conversations',
            details: JSON.stringify({
              supportConversationId: conv.id,
              agentId: candidate.id,
              displayName: candidate.displayName,
            }),
          },
        });

        // Realtime notifications
        try {
          const io = SocketService.get();
          if (io) {
            const assignData = {
              conversationId: conv.conversationId,
              ticketNumber: conv.ticket?.ticketNumber,
              agent: {
                id: candidate.id,
                displayName: candidate.displayName,
                avatar: candidate.avatar,
              },
              status: SupportConversationStatus.ASSIGNED,
            };
            io.emitToConversation(conv.conversationId, 'support:conversation:assigned', assignData);
            if (conv.id !== conv.conversationId) {
              io.emitToConversation(conv.id, 'support:conversation:assigned', assignData);
            }
            io.emitToUser(candidate.adminUserId, 'support:agent:new_assignment', {
              conversationId: conv.conversationId,
              ticketNumber: conv.ticket?.ticketNumber,
              subject: conv.subject,
              priority: conv.priority,
            });
            io.emitGlobal('support:queue:updated', { action: 'assigned', conversationId: conv.conversationId });
          }
        } catch (_) {}

        return true;
      });
    } catch (e) {
      console.error('Auto-assignment failed:', e);
      return false;
    }
  }

  /**
   * Concurrency-safe Manual Claim by an Agent.
   */
  static async claimConversation(conversationId: string, adminUserId: string): Promise<any> {
    return await prisma.$transaction(async (tx) => {
      // Find agent profile for admin
      const agent = await tx.supportAgent.findUnique({
        where: { adminUserId },
      });
      if (!agent || !agent.active) {
        throw new AppError('Only active support agents can claim conversations.', 403);
      }

      if (agent.currentActiveChats >= agent.maxConcurrentChats) {
        throw new AppError(`Capacity limit reached. You have ${agent.currentActiveChats}/${agent.maxConcurrentChats} active chats.`, 400);
      }

      const conv = await tx.supportConversation.findFirst({
        where: {
          OR: [
            { id: conversationId },
            { conversationId },
          ],
        },
        include: { ticket: true },
      });

      if (!conv) {
        throw new AppError('Support conversation not found.', 404);
      }

      if (conv.status === SupportConversationStatus.CLOSED) {
        throw new AppError('لا يمكن استلام تذكرة مغلقة. يرجى إعادة فتح التذكرة أولاً.', 400);
      }

      if (conv.assignedAgentId && conv.assignedAgentId !== agent.id) {
        throw new AppError('This conversation has already been claimed by another agent.', 409);
      }

      // Claim conversation & increment active chats if not already assigned
      if (conv.assignedAgentId !== agent.id) {
        await tx.supportAgent.update({
          where: { id: agent.id },
          data: { currentActiveChats: { increment: 1 } },
        });
      }

      await tx.supportConversation.update({
        where: { id: conv.id },
        data: {
          assignedAgentId: agent.id,
          status: SupportConversationStatus.IN_PROGRESS,
        },
      });

      if (conv.ticket) {
        await tx.supportTicket.update({
          where: { id: conv.ticket.id },
          data: {
            assignedAgentId: agent.id,
            status: SupportConversationStatus.IN_PROGRESS,
          },
        });
      }

      // Add agent as member
      await tx.conversationMember.upsert({
        where: {
          conversationId_userId: { conversationId: conv.conversationId, userId: adminUserId },
        },
        update: {},
        create: { conversationId: conv.conversationId, userId: adminUserId },
      });

      // System message announcing real agent join
      const systemMsg = await tx.message.create({
        data: {
          conversationId: conv.conversationId,
          senderId: adminUserId,
          type: 'system',
          text: `انضم موظف الدعم ${agent.displayName} للمحادثة لخدمتك.`,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'SUPPORT_CONVERSATION_CLAIMED',
          resource: 'support_conversations',
          details: JSON.stringify({ conversationId: conv.id, agentId: agent.id }),
        },
      });

      // Realtime emit
      try {
        const io = SocketService.get();
        if (io) {
          const payload = {
            conversationId: conv.id,
            ticketNumber: conv.ticket?.ticketNumber,
            agent: { id: agent.id, displayName: agent.displayName, avatar: agent.avatar },
            status: SupportConversationStatus.IN_PROGRESS,
          };
          io.emitToConversation(conv.conversationId, 'support:conversation:assigned', payload);
          io.emitToConversation(conv.id, 'support:conversation:assigned', payload);
          io.emitToConversation(conv.conversationId, 'message:new', {
            ...systemMsg,
            conversationId: conv.conversationId,
          });
          if (conv.id !== conv.conversationId) {
            io.emitToConversation(conv.id, 'message:new', {
              ...systemMsg,
              conversationId: conv.id,
            });
          }
          io.emitGlobal('support:queue:updated', { action: 'claimed', conversationId: conv.id });
        }
      } catch (_) {}

      return { success: true, agentId: agent.id, status: SupportConversationStatus.IN_PROGRESS };
    });
  }

  /**
   * Release conversation back to QUEUED status.
   */
  static async releaseConversation(conversationId: string, adminUserId: string): Promise<any> {
    return await prisma.$transaction(async (tx) => {
      const agent = await tx.supportAgent.findUnique({ where: { adminUserId } });
      const conv = await tx.supportConversation.findFirst({
        where: {
          OR: [
            { id: conversationId },
            { conversationId },
          ],
        },
        include: { ticket: true },
      });

      if (!conv) throw new AppError('Conversation not found.', 404);

      if (conv.assignedAgentId) {
        await tx.supportAgent.update({
          where: { id: conv.assignedAgentId },
          data: { currentActiveChats: { decrement: 1 } },
        });
      }

      await tx.supportConversation.update({
        where: { id: conv.id },
        data: {
          assignedAgentId: null,
          status: SupportConversationStatus.QUEUED,
        },
      });

      if (conv.ticket) {
        await tx.supportTicket.update({
          where: { id: conv.ticket.id },
          data: {
            assignedAgentId: null,
            status: SupportConversationStatus.QUEUED,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'SUPPORT_CONVERSATION_RELEASED',
          resource: 'support_conversations',
          details: JSON.stringify({ conversationId: conv.id }),
        },
      });

      try {
        const io = SocketService.get();
        if (io) {
          const payload = {
            conversationId: conv.id,
            status: SupportConversationStatus.QUEUED,
          };
          io.emitToConversation(conv.conversationId, 'support:conversation:queued', payload);
          io.emitToConversation(conv.id, 'support:conversation:queued', payload);
          io.emitGlobal('support:queue:updated', { action: 'released', conversationId: conv.id });
        }
      } catch (_) {}

      return { success: true, status: SupportConversationStatus.QUEUED };
    });
  }

  /**
   * Transfer conversation to another agent or department.
   */
  static async transferConversation(
    conversationId: string,
    fromAdminUserId: string,
    toAgentId?: string,
    toDepartmentId?: string,
    reason?: string
  ): Promise<any> {
    return await prisma.$transaction(async (tx) => {
      const fromAgent = await tx.supportAgent.findUnique({ where: { adminUserId: fromAdminUserId } });
      const conv = await tx.supportConversation.findFirst({
        where: {
          OR: [
            { id: conversationId },
            { conversationId },
          ],
        },
        include: { ticket: true, assignedAgent: true },
      });

      if (!conv) throw new AppError('Support conversation not found.', 404);

      if (conv.status === SupportConversationStatus.CLOSED) {
        throw new AppError('لا يمكن تحويل تذكرة مغلقة. يرجى إعادة فتح التذكرة أولاً.', 400);
      }

      let targetAgent: any = null;
      if (toAgentId) {
        targetAgent = await tx.supportAgent.findUnique({ where: { id: toAgentId } });
        if (!targetAgent || !targetAgent.active) {
          throw new AppError('Target agent is not active or available.', 400);
        }
        if (targetAgent.currentActiveChats >= targetAgent.maxConcurrentChats) {
          throw new AppError('Target agent has reached maximum concurrent capacity.', 400);
        }
      }

      let targetDepartment: any = null;
      if (toDepartmentId) {
        targetDepartment = await tx.supportDepartment.findUnique({ where: { id: toDepartmentId } });
        if (!targetDepartment) throw new AppError('Target department not found.', 404);
      }

      // Record transfer
      await tx.supportConversationTransfer.create({
        data: {
          conversationId: conv.id,
          fromAgentId: conv.assignedAgentId,
          toAgentId: toAgentId || null,
          fromDepartmentId: conv.departmentId,
          toDepartmentId: toDepartmentId || conv.departmentId,
          reason,
        },
      });

      // Adjust chat capacities
      if (conv.assignedAgentId) {
        await tx.supportAgent.update({
          where: { id: conv.assignedAgentId },
          data: { currentActiveChats: { decrement: 1 } },
        });
      }

      let newStatus: SupportConversationStatus = SupportConversationStatus.QUEUED;
      if (targetAgent) {
        await tx.supportAgent.update({
          where: { id: targetAgent.id },
          data: { currentActiveChats: { increment: 1 } },
        });
        newStatus = SupportConversationStatus.ASSIGNED;

        // Add to conversation member
        await tx.conversationMember.upsert({
          where: {
            conversationId_userId: { conversationId: conv.conversationId, userId: targetAgent.adminUserId },
          },
          update: {},
          create: { conversationId: conv.conversationId, userId: targetAgent.adminUserId },
        });
      }

      const updated = await tx.supportConversation.update({
        where: { id: conv.id },
        data: {
          assignedAgentId: targetAgent ? targetAgent.id : null,
          departmentId: toDepartmentId || conv.departmentId,
          status: newStatus,
        },
      });

      if (conv.ticket) {
        await tx.supportTicket.update({
          where: { id: conv.ticket.id },
          data: {
            assignedAgentId: targetAgent ? targetAgent.id : null,
            departmentId: toDepartmentId || conv.departmentId,
            status: newStatus,
          },
        });
      }

      // System notification message
      const deptMsg = targetDepartment ? ` إلى قسم ${targetDepartment.nameAr}` : '';
      const agentMsg = targetAgent ? ` إلى الموظف ${targetAgent.displayName}` : '';
      await tx.message.create({
        data: {
          conversationId: conv.conversationId,
          senderId: fromAdminUserId,
          type: 'system',
          text: `تم تحويل المحادثة${deptMsg}${agentMsg}. السبب: ${reason || 'تحويل متابعة'}`,
        },
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId: fromAdminUserId,
          action: 'SUPPORT_CONVERSATION_TRANSFERRED',
          resource: 'support_conversations',
          details: JSON.stringify({
            conversationId: conv.id,
            fromAgentId: conv.assignedAgentId,
            toAgentId,
            toDepartmentId,
            reason,
          }),
        },
      });

      // WebSocket notify
      try {
        const io = SocketService.get();
        if (io) {
          const payload = {
            conversationId: conv.id,
            fromAgent: conv.assignedAgent?.displayName,
            toAgent: targetAgent?.displayName,
            department: targetDepartment?.nameAr,
            reason,
          };
          io.emitToConversation(conv.conversationId, 'support:conversation:transferred', payload);
          io.emitToConversation(conv.id, 'support:conversation:transferred', payload);
          if (targetAgent) {
            io.emitToUser(targetAgent.adminUserId, 'support:agent:new_assignment', {
              conversationId: conv.id,
              ticketNumber: conv.ticket?.ticketNumber,
              subject: conv.subject,
            });
          }
          io.emitGlobal('support:queue:updated', { action: 'transferred', conversationId: conv.id });
        }
      } catch (_) {}

      return { success: true, updated };
    });
  }

  /**
   * Escalate conversation.
   */
  static async escalateConversation(
    conversationId: string,
    actorUserId: string,
    reason: string
  ): Promise<any> {
    return await prisma.$transaction(async (tx) => {
      const conv = await tx.supportConversation.findFirst({
        where: {
          OR: [
            { id: conversationId },
            { conversationId },
          ],
        },
        include: { ticket: true },
      });
      if (!conv) throw new AppError('Support conversation not found.', 404);

      if (conv.status === SupportConversationStatus.CLOSED) {
        throw new AppError('لا يمكن تصعيد تذكرة مغلقة. يرجى إعادة فتح التذكرة أولاً.', 400);
      }

      // Find Escalation department
      const escDept = await tx.supportDepartment.findFirst({
        where: { name: 'ESCALATIONS' },
      });

      const updated = await tx.supportConversation.update({
        where: { id: conv.id },
        data: {
          priority: SupportPriority.URGENT,
          status: SupportConversationStatus.ESCALATED,
          departmentId: escDept ? escDept.id : conv.departmentId,
          escalatedAt: new Date(),
          escalatedBy: actorUserId,
        },
      });

      if (conv.ticket) {
        await tx.supportTicket.update({
          where: { id: conv.ticket.id },
          data: {
            priority: SupportPriority.URGENT,
            status: SupportConversationStatus.ESCALATED,
            departmentId: escDept ? escDept.id : conv.departmentId,
          },
        });
      }

      await tx.message.create({
        data: {
          conversationId: conv.conversationId,
          senderId: actorUserId,
          type: 'system',
          text: `تم تصعيد هذا الطلب بشكل عاجل لفريق الإدارة والمتابعة الخاصة. السبب: ${reason}`,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: actorUserId,
          action: 'SUPPORT_CONVERSATION_ESCALATED',
          resource: 'support_conversations',
          details: JSON.stringify({ conversationId: conv.id, reason }),
        },
      });

      try {
        const io = SocketService.get();
        if (io) {
          const payload = {
            conversationId: conv.id,
            priority: SupportPriority.URGENT,
            status: SupportConversationStatus.ESCALATED,
            reason,
          };
          io.emitToConversation(conv.conversationId, 'support:conversation:escalated', payload);
          io.emitToConversation(conv.id, 'support:conversation:escalated', payload);
          io.emitGlobal('support:queue:updated', { action: 'escalated', conversationId: conv.id });
        }
      } catch (_) {}

      return updated;
    });
  }

  /**
   * Resolve support conversation.
   */
  static async resolveConversation(conversationId: string, adminUserId: string): Promise<any> {
    return await prisma.$transaction(async (tx) => {
      const conv = await tx.supportConversation.findFirst({
        where: {
          OR: [
            { id: conversationId },
            { conversationId },
          ],
        },
        include: { ticket: true, assignedAgent: true },
      });
      if (!conv) throw new AppError('Support conversation not found.', 404);

      if (conv.status === SupportConversationStatus.CLOSED) {
        throw new AppError('لا يمكن حل تذكرة مغلقة بالفعل.', 400);
      }

      if (conv.assignedAgentId) {
        await tx.supportAgent.update({
          where: { id: conv.assignedAgentId },
          data: { currentActiveChats: { decrement: 1 } },
        });
      }

      const now = new Date();
      const updated = await tx.supportConversation.update({
        where: { id: conv.id },
        data: {
          status: SupportConversationStatus.RESOLVED,
          resolvedAt: now,
        },
      });

      if (conv.ticket) {
        await tx.supportTicket.update({
          where: { id: conv.ticket.id },
          data: {
            status: SupportConversationStatus.RESOLVED,
            resolvedAt: now,
          },
        });
      }

      const resolveMsg = await tx.message.create({
        data: {
          conversationId: conv.conversationId,
          senderId: adminUserId,
          type: 'system',
          text: 'تم حل هذا الطلب بنجاح. نتمنى أن نكون قد قدمنا لك الخدمة المطلوبة! يرجى تقييم تجربتك معنا.',
        },
      });

      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'SUPPORT_CONVERSATION_RESOLVED',
          resource: 'support_conversations',
          details: JSON.stringify({ conversationId: conv.id }),
        },
      });

      try {
        const io = SocketService.get();
        if (io) {
          const msgPayload = {
            id: resolveMsg.id,
            conversationId: conv.conversationId,
            senderId: adminUserId,
            content: resolveMsg.text,
            type: resolveMsg.type,
            isInternal: false,
            createdAt: resolveMsg.createdAt.toISOString(),
          };
          io.emitToConversation(conv.conversationId, 'message:new', msgPayload);
          if (conv.id !== conv.conversationId) {
            io.emitToConversation(conv.id, 'message:new', msgPayload);
          }

          const payload = {
            conversationId: conv.id,
            baseConversationId: conv.conversationId,
            status: SupportConversationStatus.RESOLVED,
            resolvedAt: now.toISOString(),
          };
          io.emitToConversation(conv.conversationId, 'support:conversation:resolved', payload);
          if (conv.id !== conv.conversationId) {
            io.emitToConversation(conv.id, 'support:conversation:resolved', payload);
          }
          io.emitGlobal('support:queue:updated', { action: 'resolved', conversationId: conv.id });
        }
      } catch (_) {}

      return updated;
    });
  }

  /**
   * Close support conversation.
   */
  static async closeConversation(conversationId: string, actorUserId: string): Promise<any> {
    return await prisma.$transaction(async (tx) => {
      const conv = await tx.supportConversation.findFirst({
        where: {
          OR: [
            { id: conversationId },
            { conversationId },
          ],
        },
        include: { ticket: true },
      });
      if (!conv) throw new AppError('Support conversation not found.', 404);

      if (conv.status === SupportConversationStatus.CLOSED) {
        return conv;
      }

      if (conv.status !== SupportConversationStatus.RESOLVED && conv.assignedAgentId) {
        await tx.supportAgent.update({
          where: { id: conv.assignedAgentId },
          data: { currentActiveChats: { decrement: 1 } },
        });
      }

      const now = new Date();
      const updated = await tx.supportConversation.update({
        where: { id: conv.id },
        data: {
          status: SupportConversationStatus.CLOSED,
          closedAt: now,
          closedBy: actorUserId,
        },
      });

      if (conv.ticket) {
        await tx.supportTicket.update({
          where: { id: conv.ticket.id },
          data: {
            status: SupportConversationStatus.CLOSED,
            closedAt: now,
          },
        });
      }

      const closeMsg = await tx.message.create({
        data: {
          conversationId: conv.conversationId,
          senderId: actorUserId,
          type: 'system',
          text: 'تم إغلاق المحادثة من قِبل موظف الدعم. شكراً لتواصلك معنا.',
        },
      });

      await tx.auditLog.create({
        data: {
          userId: actorUserId,
          action: 'SUPPORT_CONVERSATION_CLOSED',
          resource: 'support_conversations',
          details: JSON.stringify({ conversationId: conv.id }),
        },
      });

      try {
        const io = SocketService.get();
        if (io) {
          const msgPayload = {
            id: closeMsg.id,
            conversationId: conv.conversationId,
            senderId: actorUserId,
            content: closeMsg.text,
            type: closeMsg.type,
            isInternal: false,
            createdAt: closeMsg.createdAt.toISOString(),
          };
          io.emitToConversation(conv.conversationId, 'message:new', msgPayload);
          if (conv.id !== conv.conversationId) {
            io.emitToConversation(conv.id, 'message:new', msgPayload);
          }

          const payload = {
            conversationId: conv.id,
            baseConversationId: conv.conversationId,
            status: SupportConversationStatus.CLOSED,
            closedAt: now.toISOString(),
          };
          io.emitToConversation(conv.conversationId, 'support:conversation:closed', payload);
          if (conv.id !== conv.conversationId) {
            io.emitToConversation(conv.id, 'support:conversation:closed', payload);
          }
          io.emitGlobal('support:queue:updated', { action: 'closed', conversationId: conv.id });
        }
      } catch (_) {}

      return updated;
    });
  }

  /**
   * Reopen a closed or resolved support conversation.
   */
  static async reopenConversation(conversationId: string, actorUserId: string): Promise<any> {
    return await prisma.$transaction(async (tx) => {
      const conv = await tx.supportConversation.findFirst({
        where: {
          OR: [
            { id: conversationId },
            { conversationId },
          ],
        },
        include: { ticket: true },
      });
      if (!conv) throw new AppError('Support conversation not found.', 404);

      const updated = await tx.supportConversation.update({
        where: { id: conv.id },
        data: {
          status: SupportConversationStatus.QUEUED,
          assignedAgentId: null,
          closedAt: null,
          closedBy: null,
        },
      });

      if (conv.ticket) {
        await tx.supportTicket.update({
          where: { id: conv.ticket.id },
          data: {
            status: SupportConversationStatus.QUEUED,
            assignedAgentId: null,
            closedAt: null,
          },
        });
      }

      await tx.message.create({
        data: {
          conversationId: conv.conversationId,
          senderId: actorUserId,
          type: 'system',
          text: 'تمت إعادة فتح تذكرة الدعم وبانتظار رد موظف الخدمة.',
        },
      });

      await tx.auditLog.create({
        data: {
          userId: actorUserId,
          action: 'SUPPORT_CONVERSATION_REOPENED',
          resource: 'support_conversations',
          details: JSON.stringify({ conversationId: conv.id }),
        },
      });

      try {
        const io = SocketService.get();
        if (io) {
          const payload = {
            conversationId: conv.id,
            status: SupportConversationStatus.QUEUED,
          };
          io.emitToConversation(conv.conversationId, 'support:conversation:queued', payload);
          io.emitToConversation(conv.id, 'support:conversation:queued', payload);
          io.emitGlobal('support:queue:updated', { action: 'reopened', conversationId: conv.id });
        }
      } catch (_) {}

      return updated;
    });
  }

  /**
   * Send a support message (either normal customer/seller/agent message or internal agent note).
   */
  static async sendMessage(
    conversationId: string,
    senderId: string,
    role: string,
    text: string,
    attachmentUrl?: string,
    type: string = 'text',
    metadata?: any,
    isInternalNote: boolean = false,
    clientMessageId?: string
  ): Promise<any> {
    // Check permission for internal notes
    if (isInternalNote && role !== 'ADMIN') {
      throw new AppError('Only authorized admin agents can create internal notes.', 403);
    }

    const conv = await prisma.supportConversation.findFirst({
      where: {
        OR: [
          { id: conversationId },
          { conversationId },
        ],
      },
      include: { ticket: true, assignedAgent: true },
    });

    if (!conv) throw new AppError('Support conversation not found.', 404);

    if (conv.status === SupportConversationStatus.CLOSED) {
      throw new AppError('هذه التذكرة مغلقة ولا يمكن إرسال رسائل جديدة فيها. يرجى إعادة فتح التذكرة للمتابعة.', 400);
    }

    // Verify membership / access
    const isRequester = conv.requesterId === senderId;
    const isAgent = role === 'ADMIN';

    if (!isRequester && !isAgent) {
      throw new AppError('Unauthorized access to this conversation.', 403);
    }

    // Idempotency check
    if (clientMessageId) {
      const existing = await prisma.message.findUnique({
        where: { clientMessageId },
        include: { sender: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
      });
      if (existing) {
        return existing;
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          conversationId: conv.conversationId,
          senderId,
          type: isInternalNote ? 'internal_note' : type,
          text,
          attachmentUrl: attachmentUrl || null,
          metadata: metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null,
          isInternal: isInternalNote,
          clientMessageId: clientMessageId || null,
        },
        include: {
          sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        },
      });

      // Update Conversation & SupportConversation counters
      const updateData: any = {
        updatedAt: new Date(),
        lastMessageId: msg.id,
      };

      const supportUpdate: any = {
        lastMessageId: msg.id,
        lastMessageAt: msg.createdAt,
      };

      if (!isInternalNote) {
        if (isAgent) {
          // Agent message: track firstResponseAt for SLA
          if (!conv.firstResponseAt) {
            supportUpdate.firstResponseAt = new Date();
          }
          if (conv.requesterType === SupportRequesterType.CUSTOMER) {
            supportUpdate.unreadCustomerCount = { increment: 1 };
          } else {
            supportUpdate.unreadSellerCount = { increment: 1 };
          }
          // If unassigned or queued, auto-assign this active agent and announce real join
          if (!conv.assignedAgentId || conv.status === SupportConversationStatus.QUEUED) {
            const agent = await tx.supportAgent.findUnique({ where: { adminUserId: senderId } });
            if (agent) {
              supportUpdate.assignedAgentId = agent.id;
              supportUpdate.status = SupportConversationStatus.IN_PROGRESS;
              await tx.supportAgent.update({
                where: { id: agent.id },
                data: { currentActiveChats: { increment: 1 } },
              });
              if (conv.ticket) {
                await tx.supportTicket.update({
                  where: { id: conv.ticket.id },
                  data: { assignedAgentId: agent.id, status: SupportConversationStatus.IN_PROGRESS },
                });
              }
              const joinMsg = await tx.message.create({
                data: {
                  conversationId: conv.conversationId,
                  senderId,
                  type: 'system',
                  text: `انضم موظف الدعم ${agent.displayName} للمحادثة لخدمتك.`,
                },
              });
              const io = SocketService.get();
              if (io) {
                io.emitToConversation(conv.conversationId, 'message:new', {
                  ...joinMsg,
                  conversationId: conv.conversationId,
                });
                if (conv.id !== conv.conversationId) {
                  io.emitToConversation(conv.id, 'message:new', {
                    ...joinMsg,
                    conversationId: conv.id,
                  });
                }
                io.emitToConversation(conv.conversationId, 'support:conversation:assigned', {
                  conversationId: conv.id,
                  ticketNumber: conv.ticket?.ticketNumber,
                  agent: { id: agent.id, displayName: agent.displayName, avatar: agent.avatar },
                  status: SupportConversationStatus.IN_PROGRESS,
                });
              }
            }
          } else if (conv.status === SupportConversationStatus.ASSIGNED) {
            supportUpdate.status = SupportConversationStatus.IN_PROGRESS;
          }
        } else {
          // Customer/Seller message
          supportUpdate.unreadAgentCount = { increment: 1 };
          // If was WAITING_FOR_CUSTOMER/SELLER, transition back to IN_PROGRESS
          if (
            conv.status === SupportConversationStatus.WAITING_FOR_CUSTOMER ||
            conv.status === SupportConversationStatus.WAITING_FOR_SELLER
          ) {
            supportUpdate.status = SupportConversationStatus.IN_PROGRESS;
          }
        }
      }

      await tx.conversation.update({
        where: { id: conv.conversationId },
        data: updateData,
      });

      await tx.supportConversation.update({
        where: { id: conv.id },
        data: supportUpdate,
      });

      return msg;
    });

    // Realtime broadcast with STRICT isolation
    try {
      const io = SocketService.get();
      if (io) {
        const payload = {
          id: created.id,
          conversationId: conv.id,
          baseConversationId: conv.conversationId,
          supportConversationId: conv.id,
          senderId,
          content: created.text,
          type: created.type,
          metadata: metadata,
          imageUrl: created.type === 'image' ? created.attachmentUrl : null,
          fileUrl: created.type === 'file' ? created.attachmentUrl : null,
          clientMessageId: created.clientMessageId,
          createdAt: created.createdAt.toISOString(),
          isInternal: created.isInternal,
          sender: created.sender,
        };

        if (isInternalNote) {
          // Send ONLY to admin user rooms or admin sockets! NEVER to general conversation room!
          const adminAgents = await prisma.supportAgent.findMany({
            where: { active: true },
            select: { adminUserId: true },
          });
          for (const a of adminAgents) {
            io.emitToUser(a.adminUserId, 'support:internal_note:new', payload);
          }
        } else {
          io.emitToConversation(conv.conversationId, 'message:new', payload);
          io.emitToConversation(conv.conversationId, 'new:message', payload);
          if (conv.id !== conv.conversationId) {
            io.emitToConversation(conv.id, 'message:new', payload);
            io.emitToConversation(conv.id, 'new:message', payload);
          }

          // Also emit directly to individual user rooms to guarantee live delivery
          // even if the client's room join event lagged or reconnected
          if (conv.requesterId) {
            io.emitToUser(conv.requesterId, 'message:new', payload);
            io.emitToUser(conv.requesterId, 'new:message', payload);
          }
          if (conv.assignedAgent?.adminUserId) {
            io.emitToUser(conv.assignedAgent.adminUserId, 'message:new', payload);
            io.emitToUser(conv.assignedAgent.adminUserId, 'new:message', payload);
          }
          try {
            const members = await prisma.conversationMember.findMany({
              where: { conversationId: conv.conversationId },
              select: { userId: true },
            });
            for (const m of members) {
              if (m.userId !== conv.requesterId && m.userId !== conv.assignedAgent?.adminUserId) {
                io.emitToUser(m.userId, 'message:new', payload);
                io.emitToUser(m.userId, 'new:message', payload);
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // Dispatch push notifications to recipients not currently viewing the chat room
    if (!isInternalNote) {
      sendChatNotification({
        conversationId: conv.conversationId || conv.id,
        senderId,
        messageId: created.id,
        type: type || 'text',
        text,
        metadata,
      }).catch((err) => console.error('[Support Notification Error]:', err));
    }

    return created;
  }

  /**
   * Submit Customer Satisfaction Rating (CSAT).
   */
  static async rateConversation(
    conversationId: string,
    userId: string,
    rating: number,
    comment?: string
  ): Promise<any> {
    if (rating < 1 || rating > 5) {
      throw new AppError('Rating must be between 1 and 5 stars.', 400);
    }

    const conv = await prisma.supportConversation.findFirst({
      where: {
        OR: [
          { id: conversationId },
          { conversationId },
        ],
      },
      include: { ticket: true },
    });
    if (!conv) throw new AppError('Support conversation not found.', 404);

    if (conv.requesterId !== userId) {
      throw new AppError('You can only rate your own support conversations.', 403);
    }

    const created = await prisma.supportRating.upsert({
      where: {
        conversationId_userId: { conversationId: conv.id, userId },
      },
      update: {
        rating,
        comment,
      },
      create: {
        conversationId: conv.id,
        ticketId: conv.ticket?.id || null,
        userId,
        rating,
        comment,
      },
    });

    const stars = '⭐'.repeat(rating);
    const rateMsgText = `قام العميل بتقييم الخدمة: ${rating} من 5 نجوم ${stars}${comment ? `\nملاحظات العميل: "${comment}"` : ''}`;

    const rateMsg = await prisma.message.create({
      data: {
        conversationId: conv.conversationId,
        senderId: userId,
        type: 'system',
        text: rateMsgText,
      },
    });

    try {
      const io = SocketService.get();
      if (io) {
        const msgPayload = {
          id: rateMsg.id,
          conversationId: conv.conversationId,
          senderId: userId,
          content: rateMsg.text,
          type: rateMsg.type,
          isInternal: false,
          createdAt: rateMsg.createdAt.toISOString(),
        };
        io.emitToConversation(conv.conversationId, 'message:new', msgPayload);
        if (conv.id !== conv.conversationId) {
          io.emitToConversation(conv.id, 'message:new', msgPayload);
        }

        const ratedPayload = {
          conversationId: conv.id,
          baseConversationId: conv.conversationId,
          rating: {
            id: created.id,
            conversationId: conv.id,
            ticketId: conv.ticket?.id,
            userId,
            rating: created.rating,
            comment: created.comment,
            createdAt: created.createdAt.toISOString(),
          },
        };
        io.emitToConversation(conv.conversationId, 'support:conversation:rated', ratedPayload);
        if (conv.id !== conv.conversationId) {
          io.emitToConversation(conv.id, 'support:conversation:rated', ratedPayload);
        }
        io.emitGlobal('support:queue:updated', { action: 'rated', conversationId: conv.id });
      }
    } catch (_) {}

    return created;
  }

  /**
   * Get single conversation by ID with authoritative enrichment.
   */
  static async getConversationById(conversationId: string, requestingUserId: string): Promise<any> {
    const user = await prisma.user.findUnique({
      where: { id: requestingUserId },
      select: { role: true },
    });

    const isAgent = user?.role === UserRoleType.ADMIN;

    const conv = await prisma.supportConversation.findFirst({
      where: {
        OR: [
          { id: conversationId },
          { conversationId },
        ],
      },
      include: {
        conversation: {
          include: {
            members: {
              include: {
                user: { select: { id: true, firstName: true, lastName: true, avatar: true, email: true, phone: true } },
              },
            },
          },
        },
        ticket: true,
        assignedAgent: {
          include: {
            user: { select: { firstName: true, lastName: true, avatar: true } },
          },
        },
        department: true,
        category: true,
        ratings: true,
      },
    });

    if (!conv) {
      throw new AppError('Support conversation not found.', 404);
    }

    // Authorization check
    if (!isAgent && conv.requesterId !== requestingUserId) {
      throw new AppError('Unauthorized access to support conversation.', 403);
    }

    // Authoritative Order / Product Context if linked
    let orderContext: any = null;
    if (conv.ticket?.relatedOrderId) {
      orderContext = await prisma.order.findUnique({
        where: { id: conv.ticket.relatedOrderId },
        include: {
          sellerOrders: {
            include: {
              items: {
                include: { product: { select: { id: true, nameAr: true, nameEn: true, images: true, price: true } } },
              },
            },
          },
          addressSnapshot: true,
        },
      });
    }

    let productContext: any = null;
    if (conv.ticket?.relatedProductId) {
      productContext = await prisma.product.findUnique({
        where: { id: conv.ticket.relatedProductId },
        select: { id: true, nameAr: true, nameEn: true, price: true, images: true, sku: true },
      });
    }

    // Requester Profile Context
    let requesterContext: any = null;
    if (isAgent) {
      const reqUser = await prisma.user.findUnique({
        where: { id: conv.requesterId },
        include: {
          customer: true,
          seller: { include: { stores: { select: { id: true, name: true, slug: true, logo: true } } } },
          orders: { take: 3, orderBy: { createdAt: 'desc' }, select: { id: true, orderNumber: true, total: true, status: true, createdAt: true } },
        },
      });
      if (reqUser) {
        requesterContext = {
          id: reqUser.id,
          name: `${reqUser.firstName} ${reqUser.lastName}`.trim(),
          email: reqUser.email,
          phone: reqUser.phone,
          avatar: reqUser.avatar,
          role: reqUser.role,
          store: reqUser.seller?.stores?.[0] || null,
          recentOrders: reqUser.orders,
        };
      }
    }

    let queuePosition: number | null = null;
    if (conv.status === SupportConversationStatus.QUEUED) {
      queuePosition = await prisma.supportConversation.count({
        where: {
          status: SupportConversationStatus.QUEUED,
          createdAt: { lte: conv.createdAt },
        },
      });
    }

    return {
      id: conv.id,
      conversationId: conv.conversationId,
      ticketNumber: conv.ticket?.ticketNumber,
      requesterType: conv.requesterType,
      requesterId: conv.requesterId,
      requesterContext,
      queuePosition,
      subject: conv.subject,
      priority: conv.priority,
      status: conv.status,
      assignedAgent: conv.assignedAgent
        ? (() => {
            let isOnline = conv.assignedAgent.online;
            try {
              if (SocketService.get().isUserOnline(conv.assignedAgent.adminUserId)) {
                isOnline = true;
              }
            } catch (_) {}
            const status = isOnline
              ? (conv.assignedAgent.status === SupportAgentStatus.OFFLINE ? SupportAgentStatus.ONLINE : conv.assignedAgent.status)
              : conv.assignedAgent.status;
            return {
              id: conv.assignedAgent.id,
              adminUserId: conv.assignedAgent.adminUserId,
              displayName: conv.assignedAgent.displayName,
              avatar: conv.assignedAgent.avatar || conv.assignedAgent.user?.avatar,
              online: isOnline,
              status,
            };
          })()
        : null,
      department: conv.department,
      category: conv.category,
      unreadCustomerCount: conv.unreadCustomerCount,
      unreadSellerCount: conv.unreadSellerCount,
      unreadAgentCount: conv.unreadAgentCount,
      firstResponseDueAt: conv.firstResponseDueAt,
      resolutionDueAt: conv.resolutionDueAt,
      firstResponseAt: conv.firstResponseAt,
      resolvedAt: conv.resolvedAt,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      closedAt: conv.closedAt,
      orderContext,
      productContext,
      ratings: conv.ratings,
    };
  }

  /**
   * Get messages for conversation with STRICT internal note privacy filtering.
   */
  static async getMessages(
    conversationId: string,
    requestingUserId: string,
    limit = 50,
    before?: string
  ): Promise<any[]> {
    const user = await prisma.user.findUnique({
      where: { id: requestingUserId },
      select: { role: true },
    });
    const isAgent = user?.role === UserRoleType.ADMIN;

    const conv = await prisma.supportConversation.findFirst({
      where: {
        OR: [
          { id: conversationId },
          { conversationId },
        ],
      },
    });
    if (!conv) throw new AppError('Conversation not found.', 404);

    if (!isAgent && conv.requesterId !== requestingUserId) {
      throw new AppError('Unauthorized access.', 403);
    }

    const whereClause: any = {
      conversationId: conv.conversationId,
      deletedAt: null,
    };

    // STRICT: non-agents NEVER see internal notes
    if (!isAgent) {
      whereClause.isInternal = false;
      whereClause.type = { not: 'internal_note' };
    }

    if (before) {
      whereClause.createdAt = { lt: new Date(before) };
    }

    const messages = await prisma.message.findMany({
      where: whereClause,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        sender: {
          select: { id: true, firstName: true, lastName: true, avatar: true },
        },
      },
    });

    return messages.reverse().map((m) => {
      let meta = null;
      if (m.metadata) {
        try {
          meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata;
        } catch (_) {
          meta = m.metadata;
        }
      }
      return {
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        content: m.text,
        type: m.type,
        metadata: meta,
        imageUrl: m.type === 'image' ? m.attachmentUrl : null,
        fileUrl: m.type === 'file' ? m.attachmentUrl : null,
        isRead: m.isRead,
        isInternal: m.isInternal,
        clientMessageId: m.clientMessageId,
        createdAt: m.createdAt.toISOString(),
        sender: m.sender,
      };
    });
  }

  /**
   * List conversations with search, queue filters, and role scoping.
   */
  static async listConversations(
    requestingUserId: string,
    filters: {
      status?: string;
      queue?: string; // all, unassigned, my_chats, high_priority, urgent, waiting, escalated, resolved, closed
      priority?: string;
      departmentId?: string;
      requesterType?: string;
      search?: string;
      limit?: number;
      page?: number;
    }
  ): Promise<{ items: any[]; total: number; page: number; totalPages: number }> {
    const user = await prisma.user.findUnique({
      where: { id: requestingUserId },
      select: { role: true },
    });
    const isAgent = user?.role === UserRoleType.ADMIN;

    const page = filters.page || 1;
    const limit = filters.limit || 30;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (!isAgent) {
      // Customer or Seller sees only their own conversations
      where.requesterId = requestingUserId;
    } else {
      // Admin / Agent filtering
      let agent: any = null;
      if (filters.queue === 'my_chats') {
        agent = await prisma.supportAgent.findUnique({ where: { adminUserId: requestingUserId } });
        if (agent) {
          where.assignedAgentId = agent.id;
        }
      }

      if (filters.queue === 'unassigned') {
        where.assignedAgentId = null;
        where.status = { in: [SupportConversationStatus.QUEUED, SupportConversationStatus.OPEN] };
      } else if (filters.queue === 'urgent') {
        where.priority = SupportPriority.URGENT;
        where.status = { notIn: [SupportConversationStatus.RESOLVED, SupportConversationStatus.CLOSED] };
      } else if (filters.queue === 'high_priority') {
        where.priority = { in: [SupportPriority.HIGH, SupportPriority.URGENT] };
        where.status = { notIn: [SupportConversationStatus.RESOLVED, SupportConversationStatus.CLOSED] };
      } else if (filters.queue === 'waiting') {
        where.status = {
          in: [
            SupportConversationStatus.QUEUED,
            SupportConversationStatus.WAITING_FOR_CUSTOMER,
            SupportConversationStatus.WAITING_FOR_SELLER,
          ],
        };
      } else if (filters.queue === 'escalated') {
        where.status = SupportConversationStatus.ESCALATED;
      } else if (filters.queue === 'resolved') {
        where.status = SupportConversationStatus.RESOLVED;
      } else if (filters.queue === 'closed') {
        where.status = SupportConversationStatus.CLOSED;
      }
    }

    if (filters.status && filters.status !== 'ALL') {
      where.status = filters.status as SupportConversationStatus;
    }

    if (filters.priority && filters.priority !== 'ALL') {
      where.priority = filters.priority as SupportPriority;
    }

    if (filters.departmentId && filters.departmentId !== 'ALL') {
      where.departmentId = filters.departmentId;
    }

    if (filters.requesterType && filters.requesterType !== 'ALL') {
      where.requesterType = filters.requesterType as SupportRequesterType;
    }

    if (filters.search && filters.search.trim()) {
      const q = filters.search.trim();
      where.OR = [
        { subject: { contains: q, mode: 'insensitive' } },
        { ticket: { ticketNumber: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [total, records] = await Promise.all([
      prisma.supportConversation.count({ where }),
      prisma.supportConversation.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { priority: 'desc' },
          { updatedAt: 'desc' },
        ],
        include: {
          ticket: true,
          assignedAgent: { select: { id: true, displayName: true, avatar: true, online: true, status: true } },
          department: { select: { id: true, name: true, nameAr: true } },
          category: { select: { id: true, nameAr: true, nameEn: true, icon: true } },
        },
      }),
    ]);

    const requesterIds = Array.from(new Set(records.map((r) => r.requesterId)));
    const requesters = await prisma.user.findMany({
      where: { id: { in: requesterIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        avatar: true,
        role: true,
        isActive: true,
        seller: { include: { stores: { select: { id: true, name: true, slug: true, logo: true } } } },
      },
    });
    const requesterMap = new Map(requesters.map((u) => [u.id, u]));

    const relatedOrderIds = records
      .map((r) => r.ticket?.relatedOrderId)
      .filter((id): id is string => Boolean(id));

    let orderMap = new Map<string, any>();
    if (relatedOrderIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { id: { in: relatedOrderIds } },
        include: {
          sellerOrders: {
            include: {
              items: {
                include: { product: { select: { id: true, nameAr: true, nameEn: true, images: true, price: true } } },
              },
            },
          },
        },
      });
      orderMap = new Map(orders.map((o) => [o.id, o]));
    }

    const items = records.map((conv) => {
      const reqUser = requesterMap.get(conv.requesterId);
      const requesterContext = reqUser
        ? {
            id: reqUser.id,
            name: `${reqUser.firstName || ''} ${reqUser.lastName || ''}`.trim() || reqUser.email,
            email: reqUser.email,
            phone: reqUser.phone,
            phoneNumber: reqUser.phone,
            avatar: reqUser.avatar,
            role: reqUser.role,
            status: reqUser.isActive ? 'نشط' : 'معلق',
            store: reqUser.seller?.stores?.[0] || null,
          }
        : null;

      const orderContext = conv.ticket?.relatedOrderId ? orderMap.get(conv.ticket.relatedOrderId) || null : null;

      return {
        id: conv.id,
        conversationId: conv.conversationId,
        ticketNumber: conv.ticket?.ticketNumber || '',
        requesterType: conv.requesterType,
        requesterId: conv.requesterId,
        requesterContext,
        orderContext,
        subject: conv.subject,
        priority: conv.priority,
        status: conv.status,
        assignedAgent: conv.assignedAgent,
        department: conv.department,
        category: conv.category,
        unreadCustomerCount: conv.unreadCustomerCount,
        unreadSellerCount: conv.unreadSellerCount,
        unreadAgentCount: conv.unreadAgentCount,
        firstResponseDueAt: conv.firstResponseDueAt,
        resolutionDueAt: conv.resolutionDueAt,
        firstResponseAt: conv.firstResponseAt,
        resolvedAt: conv.resolvedAt,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        closedAt: conv.closedAt,
      };
    });

    return {
      items,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Queue statistics and metrics for Admin Dashboard.
   */
  static async getQueueAnalytics(): Promise<any> {
    const now = new Date();

    const [
      totalOpen,
      totalQueued,
      totalActive,
      totalUnassigned,
      totalEscalated,
      totalResolved,
      totalUrgent,
      slaViolations,
      departments,
      agents,
      ratings,
    ] = await Promise.all([
      prisma.supportConversation.count({
        where: { status: { notIn: [SupportConversationStatus.RESOLVED, SupportConversationStatus.CLOSED] } },
      }),
      prisma.supportConversation.count({
        where: { status: SupportConversationStatus.QUEUED },
      }),
      prisma.supportConversation.count({
        where: { status: { in: [SupportConversationStatus.ASSIGNED, SupportConversationStatus.IN_PROGRESS] } },
      }),
      prisma.supportConversation.count({
        where: { assignedAgentId: null, status: { notIn: [SupportConversationStatus.RESOLVED, SupportConversationStatus.CLOSED] } },
      }),
      prisma.supportConversation.count({
        where: { status: SupportConversationStatus.ESCALATED },
      }),
      prisma.supportConversation.count({
        where: { status: SupportConversationStatus.RESOLVED },
      }),
      prisma.supportConversation.count({
        where: { priority: SupportPriority.URGENT, status: { notIn: [SupportConversationStatus.RESOLVED, SupportConversationStatus.CLOSED] } },
      }),
      prisma.supportConversation.count({
        where: {
          status: { notIn: [SupportConversationStatus.RESOLVED, SupportConversationStatus.CLOSED] },
          firstResponseDueAt: { lt: now },
          firstResponseAt: null,
        },
      }),
      prisma.supportDepartment.findMany({
        where: { active: true },
        select: {
          id: true,
          nameAr: true,
          nameEn: true,
          _count: {
            select: {
              conversations: {
                where: { status: { notIn: [SupportConversationStatus.RESOLVED, SupportConversationStatus.CLOSED] } },
              },
            },
          },
        },
      }),
      prisma.supportAgent.findMany({
        where: { active: true },
        select: {
          id: true,
          displayName: true,
          avatar: true,
          online: true,
          status: true,
          maxConcurrentChats: true,
          currentActiveChats: true,
        },
      }),
      prisma.supportRating.aggregate({
        _avg: { rating: true },
        _count: { rating: true },
      }),
    ]);

    return {
      totalOpen,
      totalQueued,
      totalActive,
      totalUnassigned,
      totalEscalated,
      totalResolved,
      totalUrgent,
      slaViolations,
      averageRating: ratings._avg.rating ? Number(ratings._avg.rating.toFixed(2)) : 5.0,
      totalRatings: ratings._count.rating,
      departmentStats: departments.map((d) => ({
        id: d.id,
        nameAr: d.nameAr,
        nameEn: d.nameEn,
        activeChats: d._count.conversations,
      })),
      agentStats: agents.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        avatar: a.avatar,
        online: a.online,
        status: a.status,
        maxCapacity: a.maxConcurrentChats,
        activeChats: a.currentActiveChats,
        availableSlots: Math.max(0, a.maxConcurrentChats - a.currentActiveChats),
      })),
    };
  }
}
