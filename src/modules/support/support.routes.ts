import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { SupportService } from './support.service';
import { storageService } from '../../services/storage/storage.service';
import {
  SupportRequesterType,
  SupportPriority,
  SupportAgentStatus,
  UserRoleType,
} from '@prisma/client';
import { chatUploadLimiter } from '../../middleware/rate-limiter.middleware';
import { SocketService } from '../../services/websocket/socket.service';

const router = Router();

// ==========================================
// 0. PUBLIC METADATA (No Auth Required)
// ==========================================

/**
 * GET /api/v1/support/categories
 * Configurable categories filtered by requesterType.
 */
router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { requesterType } = req.query;
    const where: any = { active: true };

    if (requesterType && requesterType !== 'BOTH') {
      where.OR = [
        { requesterType: requesterType as string },
        { requesterType: 'BOTH' },
      ];
    }

    const categories = await prisma.supportCategory.findMany({
      where,
      orderBy: { sortOrder: 'asc' },
      include: {
        department: { select: { id: true, name: true, nameAr: true, nameEn: true } },
      },
    });

    return ResponseUtil.success(res, categories);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/support/departments
 * Active departments.
 */
router.get('/departments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const departments = await prisma.supportDepartment.findMany({
      where: { active: true },
      orderBy: { priority: 'asc' },
    });
    return ResponseUtil.success(res, departments);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/support/faqs
 * FAQ suggestions for self-service before connecting with an agent.
 */
router.get('/faqs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { categoryId } = req.query;
    const where: any = { active: true };
    if (categoryId) {
      where.categoryId = categoryId as string;
    }

    const faqs = await prisma.supportFaq.findMany({
      where,
      orderBy: { sortOrder: 'asc' },
    });

    return ResponseUtil.success(res, faqs);
  } catch (error) {
    next(error);
  }
});

// ==========================================
// AUTHENTICATED SUPPORT ROUTES
// ==========================================
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ==========================================
// 1. CONVERSATIONS
// ==========================================

/**
 * GET /api/v1/support/conversations
 * List support conversations with queue filters and role scoping.
 */
router.get('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const {
      status,
      queue,
      priority,
      departmentId,
      requesterType,
      search,
      page,
      limit,
    } = req.query;

    const result = await SupportService.listConversations(userId, {
      status: status as string,
      queue: queue as string,
      priority: priority as string,
      departmentId: departmentId as string,
      requesterType: requesterType as string,
      search: search as string,
      page: page ? parseInt(page as string, 10) : 1,
      limit: limit ? parseInt(limit as string, 10) : 30,
    });

    return ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations
 * Start new support conversation / ticket.
 */
router.post('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const userRole = req.user!.role;

    const {
      subject,
      categoryId,
      departmentId,
      priority,
      relatedOrderId,
      relatedSellerOrderId,
      relatedProductId,
      initialMessage,
      attachmentUrl,
    } = req.body;

    if (!subject || !subject.trim()) {
      throw new AppError('Subject is required to create a support conversation.', 400);
    }

    let requesterType: SupportRequesterType = SupportRequesterType.CUSTOMER;
    if (req.body.requesterType) {
      requesterType =
        req.body.requesterType.toString().toUpperCase() === 'SELLER'
          ? SupportRequesterType.SELLER
          : SupportRequesterType.CUSTOMER;
    } else {
      requesterType =
        userRole === UserRoleType.SELLER ? SupportRequesterType.SELLER : SupportRequesterType.CUSTOMER;
    }

    const result = await SupportService.createConversation({
      requesterType,
      requesterId: userId,
      subject: subject.trim(),
      categoryId,
      departmentId,
      priority: priority as SupportPriority,
      relatedOrderId,
      relatedSellerOrderId,
      relatedProductId,
      initialMessage,
      attachmentUrl,
    });

    return ResponseUtil.created(res, result, 'Support conversation created successfully.');
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/support/conversations/:id
 * Retrieve a single support conversation with details & context.
 */
router.get('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const conv = await SupportService.getConversationById(id, userId);
    return ResponseUtil.success(res, conv);
  } catch (error) {
    next(error);
  }
});

// ==========================================
// 2. MESSAGES & NOTES
// ==========================================

/**
 * GET /api/v1/support/conversations/:id/messages
 * Retrieve messages with strict internal notes privacy.
 */
router.get('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { limit, before } = req.query;

    const messages = await SupportService.getMessages(
      id,
      userId,
      limit ? parseInt(limit as string, 10) : 50,
      before as string
    );

    return ResponseUtil.success(res, messages);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations/:id/messages
 * Send message (text, image, product, order) or internal note (admin only).
 */
router.post('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;
    const id = req.params.id as string;
    const { text, attachmentUrl, type = 'text', metadata, isInternalNote = false, clientMessageId } = req.body;

    if (!text && !attachmentUrl && type === 'text') {
      throw new AppError('Message cannot be empty.', 400);
    }

    const msg = await SupportService.sendMessage(
      id,
      userId,
      role,
      text || '',
      attachmentUrl,
      type,
      metadata,
      Boolean(isInternalNote),
      clientMessageId
    );

    return ResponseUtil.created(res, msg, 'Message sent successfully.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations/:id/read
 * Mark messages in conversation as read.
 */
router.post('/conversations/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const userRole = req.user!.role;
    const id = req.params.id as string;

    const isAgent = userRole === UserRoleType.ADMIN;

    const updateData: any = {};
    if (isAgent) {
      updateData.unreadAgentCount = 0;
    } else if (userRole === UserRoleType.SELLER) {
      updateData.unreadSellerCount = 0;
    } else {
      updateData.unreadCustomerCount = 0;
    }

    const conv = await prisma.supportConversation.findFirst({
      where: {
        OR: [{ id }, { conversationId: id }],
      },
    });

    if (conv) {
      await prisma.supportConversation.update({
        where: { id: conv.id },
        data: updateData,
      });

      await prisma.conversationMember.updateMany({
        where: { conversationId: conv.conversationId, userId },
        data: { lastReadAt: new Date() },
      });

      await prisma.message.updateMany({
        where: {
          conversationId: conv.conversationId,
          senderId: { not: userId },
          isRead: false,
        },
        data: {
          isRead: true,
        },
      });

      try {
        const io = SocketService.get();
        if (io) {
          const readData = {
            conversationId: conv.id,
            baseConversationId: conv.conversationId,
            readByUserId: userId,
            readAt: new Date().toISOString(),
          };
          io.emitToConversation(conv.conversationId, 'support:messages:read', readData);
          if (conv.id !== conv.conversationId) {
            io.emitToConversation(conv.id, 'support:messages:read', readData);
          }
          io.emitToConversation(conv.conversationId, 'message:read', readData);
          if (conv.id !== conv.conversationId) {
            io.emitToConversation(conv.id, 'message:read', readData);
          }
          io.emitToUser(userId, 'support:conversation:read', { conversationId: conv.id });
          io.emitGlobal('support:queue:updated', { action: 'read', conversationId: conv.id });
        }
      } catch (_) {}
    }

    return ResponseUtil.success(res, { markedRead: true });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// 3. LIFECYCLE & ACTIONS
// ==========================================

/**
 * POST /api/v1/support/conversations/:id/claim
 * Agent claims conversation atomically.
 */
router.post('/conversations/:id/claim', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const result = await SupportService.claimConversation(id, userId);
    return ResponseUtil.success(res, result, 'Conversation claimed successfully.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations/:id/release
 * Agent releases conversation back to queue.
 */
router.post('/conversations/:id/release', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const result = await SupportService.releaseConversation(id, userId);
    return ResponseUtil.success(res, result, 'Conversation released back to queue.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations/:id/assign
 * Supervisor / Admin assigns conversation to an agent.
 */
router.post('/conversations/:id/assign', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminUserId = req.user!.userId;
    const id = req.params.id as string;
    const { agentId, departmentId, reason } = req.body;

    if (!agentId && !departmentId) {
      throw new AppError('Either agentId or departmentId is required.', 400);
    }

    const result = await SupportService.transferConversation(id, adminUserId, agentId, departmentId, reason);
    return ResponseUtil.success(res, result, 'Conversation assigned successfully.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations/:id/transfer
 * Transfer conversation to another agent or department.
 */
router.post('/conversations/:id/transfer', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminUserId = req.user!.userId;
    const id = req.params.id as string;
    const { toAgentId, toDepartmentId, reason } = req.body;

    const result = await SupportService.transferConversation(id, adminUserId, toAgentId, toDepartmentId, reason);
    return ResponseUtil.success(res, result, 'Conversation transferred successfully.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations/:id/escalate
 * Escalate support conversation (Customer, Seller, Agent, Supervisor).
 */
router.post('/conversations/:id/escalate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { reason = 'طلب تصعيد من قبل المستخدم' } = req.body;

    const result = await SupportService.escalateConversation(id, userId, reason);
    return ResponseUtil.success(res, result, 'Conversation escalated successfully.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations/:id/resolve
 * Mark conversation as resolved.
 */
router.post('/conversations/:id/resolve', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminUserId = req.user!.userId;
    const id = req.params.id as string;

    const result = await SupportService.resolveConversation(id, adminUserId);
    return ResponseUtil.success(res, result, 'Conversation marked as resolved.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations/:id/close
 * Close support conversation.
 */
router.post('/conversations/:id/close', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const result = await SupportService.closeConversation(id, userId);
    return ResponseUtil.success(res, result, 'Conversation closed.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations/:id/reopen
 * Reopen a resolved/closed support conversation.
 */
router.post('/conversations/:id/reopen', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const result = await SupportService.reopenConversation(id, userId);
    return ResponseUtil.success(res, result, 'Conversation reopened.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/conversations/:id/rating
 * Rate support experience (CSAT).
 */
router.post('/conversations/:id/rating', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { rating, comment } = req.body;

    if (!rating) throw new AppError('Rating (1-5) is required.', 400);

    const result = await SupportService.rateConversation(id, userId, Number(rating), comment);
    return ResponseUtil.success(res, result, 'Rating submitted. Thank you for your feedback!');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/app-feedback
 * Rate the Souqnaa mobile app experience.
 */
router.post('/app-feedback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    const { rating, comment, platform, appVersion } = req.body;

    if (!rating) throw new AppError('التقييم (1-5 نجوم) مطلوب.', 400);

    const auditEntry = await prisma.auditLog.create({
      data: {
        userId,
        action: 'APP_FEEDBACK_SUBMITTED',
        resource: 'feedback',
        details: JSON.stringify({
          rating: Number(rating),
          comment: comment || '',
          platform: platform || 'flutter',
          appVersion: appVersion || '3.80.37',
        }),
      },
    });

    return ResponseUtil.success(res, { id: auditEntry.id, rating, comment }, 'شكراً لك! تم استلام تقييمك وملاحظاتك بنجاح.');
  } catch (error) {
    next(error);
  }
});
// 4. ATTACHMENT UPLOAD
// ==========================================

/**
 * POST /api/v1/support/uploads
 * Upload attachment (image, pdf, document) using object storage.
 */
router.post(
  '/uploads',
  chatUploadLimiter,
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError('No file provided for upload.', 400);
      }

      const uploaded = await storageService.uploadFile(req.file, 'support');
      return ResponseUtil.success(res, {
        url: uploaded.url,
        key: uploaded.key,
        size: uploaded.size,
        mimeType: uploaded.mimeType,
        fileName: req.file.originalname,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// 5. METADATA & CONFIGURATION
// ==========================================



/**
 * GET /api/v1/support/agents
 * List support agents with status & concurrent capacity.
 */
router.get('/agents', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agents = await prisma.supportAgent.findMany({
      where: { active: true },
      include: {
        departments: { include: { department: true } },
      },
      orderBy: { displayName: 'asc' },
    });

    return ResponseUtil.success(res, agents);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/support/queue
 * Support queue details with counts and priority breakdown.
 */
router.get('/queue', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const analytics = await SupportService.getQueueAnalytics();
    return ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/support/analytics
 * Performance analytics, response times, SLA violations.
 */
router.get('/analytics', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const analytics = await SupportService.getQueueAnalytics();
    return ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/support/quick-replies
 * Configurable quick replies by department.
 */
router.get('/quick-replies', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { departmentId } = req.query;
    const where: any = { active: true };
    if (departmentId) {
      where.OR = [
        { departmentId: departmentId as string },
        { departmentId: null },
      ];
    }

    const replies = await prisma.supportQuickReply.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return ResponseUtil.success(res, replies);
  } catch (error) {
    next(error);
  }
});



// ==========================================
// 6. ADMIN MANAGEMENT ENDPOINTS
// ==========================================

/**
 * POST /api/v1/support/admin/categories
 * Create or update support category.
 */
router.post('/admin/categories', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, nameAr, nameEn, descriptionAr, descriptionEn, requesterType, icon, priority, departmentId, active, sortOrder } = req.body;

    if (!nameAr || !nameEn) {
      throw new AppError('Arabic and English category names are required.', 400);
    }

    let category;
    if (id) {
      category = await prisma.supportCategory.update({
        where: { id },
        data: {
          nameAr,
          nameEn,
          descriptionAr,
          descriptionEn,
          requesterType: requesterType || 'BOTH',
          icon,
          priority: priority || SupportPriority.NORMAL,
          departmentId: departmentId || null,
          active: active !== undefined ? active : true,
          sortOrder: sortOrder !== undefined ? Number(sortOrder) : 0,
        },
      });
    } else {
      category = await prisma.supportCategory.create({
        data: {
          nameAr,
          nameEn,
          descriptionAr,
          descriptionEn,
          requesterType: requesterType || 'BOTH',
          icon,
          priority: priority || SupportPriority.NORMAL,
          departmentId: departmentId || null,
          active: active !== undefined ? active : true,
          sortOrder: sortOrder !== undefined ? Number(sortOrder) : 0,
        },
      });
    }

    return ResponseUtil.success(res, category, 'Category saved.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/admin/departments
 * Create or update support department.
 */
router.post('/admin/departments', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, name, nameAr, nameEn, description, active, priority, workingHours, autoAssignmentEnabled } = req.body;

    if (!nameAr || !nameEn) {
      throw new AppError('Department name is required.', 400);
    }

    let dept;
    if (id) {
      dept = await prisma.supportDepartment.update({
        where: { id },
        data: {
          nameAr,
          nameEn,
          description,
          active: active !== undefined ? active : true,
          priority: priority !== undefined ? Number(priority) : 0,
          workingHours,
          autoAssignmentEnabled: autoAssignmentEnabled !== undefined ? autoAssignmentEnabled : true,
        },
      });
    } else {
      dept = await prisma.supportDepartment.create({
        data: {
          name: name || nameEn.toUpperCase().replace(/\s+/g, '_'),
          nameAr,
          nameEn,
          description,
          active: active !== undefined ? active : true,
          priority: priority !== undefined ? Number(priority) : 0,
          workingHours,
          autoAssignmentEnabled: autoAssignmentEnabled !== undefined ? autoAssignmentEnabled : true,
        },
      });
    }

    return ResponseUtil.success(res, dept, 'Department saved.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/admin/agents
 * Update agent status, max concurrency, and assigned departments.
 */
router.post('/admin/agents', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { agentId, status, maxConcurrentChats, departmentIds, active } = req.body;

    if (!agentId) throw new AppError('Agent ID is required.', 400);

    const updateData: any = {};
    if (status) {
      updateData.status = status as SupportAgentStatus;
      updateData.online = status !== SupportAgentStatus.OFFLINE;
    }
    if (maxConcurrentChats !== undefined) updateData.maxConcurrentChats = Number(maxConcurrentChats);
    if (active !== undefined) updateData.active = Boolean(active);

    const agent = await prisma.supportAgent.update({
      where: { id: agentId },
      data: updateData,
    });

    if (departmentIds && Array.isArray(departmentIds)) {
      // Re-assign departments
      await prisma.supportAgentDepartment.deleteMany({ where: { agentId } });
      for (const dId of departmentIds) {
        await prisma.supportAgentDepartment.create({
          data: { agentId, departmentId: dId },
        });
      }
    }

    return ResponseUtil.success(res, agent, 'Agent configuration updated.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/admin/quick-replies
 * Create or update quick reply.
 */
router.post('/admin/quick-replies', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, departmentId, title, message, active } = req.body;
    if (!title || !message) throw new AppError('Title and message are required.', 400);

    let reply;
    if (id) {
      reply = await prisma.supportQuickReply.update({
        where: { id },
        data: {
          departmentId: departmentId || null,
          title,
          titleAr: title,
          message,
          messageAr: message,
          active: active !== undefined ? active : true,
        },
      });
    } else {
      reply = await prisma.supportQuickReply.create({
        data: {
          departmentId: departmentId || null,
          title,
          titleAr: title,
          message,
          messageAr: message,
          active: active !== undefined ? active : true,
        },
      });
    }

    return ResponseUtil.success(res, reply, 'Quick reply saved.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/support/admin/sla
 * Update SLA policy.
 */
router.post('/admin/sla', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { priority, firstResponseMinutes, resolutionMinutes, isActive } = req.body;
    if (!priority) throw new AppError('Priority is required.', 400);

    const updated = await prisma.supportSlaPolicy.upsert({
      where: { priority: priority as SupportPriority },
      update: {
        firstResponseMinutes: Number(firstResponseMinutes),
        resolutionMinutes: Number(resolutionMinutes),
        isActive: isActive !== undefined ? isActive : true,
      },
      create: {
        priority: priority as SupportPriority,
        firstResponseMinutes: Number(firstResponseMinutes),
        resolutionMinutes: Number(resolutionMinutes),
        isActive: isActive !== undefined ? isActive : true,
      },
    });

    return ResponseUtil.success(res, updated, 'SLA policy saved.');
  } catch (error) {
    next(error);
  }
});

export const supportRoutes = router;
