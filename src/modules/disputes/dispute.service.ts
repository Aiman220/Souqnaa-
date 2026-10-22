import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import {
  DisputeStatus,
  RefundStatus,
  RefundActorType,
  OrderStatus,
  PaymentStatus,
  UserRoleType,
  NotificationType,
} from '@prisma/client';
import { SocketService } from '../../services/websocket/socket.service';
import { notificationDispatcher } from '../notifications/services/notification-dispatcher';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { adminNotificationRouter } from '../notifications/services/admin-notification-router.service';
import { NotificationCategory, NotificationPriority } from '../notifications/notification.types';
import { CustomerWalletService } from '../wallet/customer-wallet.service';
import { RefundService } from '../refunds/services/refund.service';
import { redis } from '../../database/redis';

export interface CreateDisputeInput {
  customerId: string;
  orderId: string;
  reason: string;
  description: string;
  refundRequestId?: string;
  evidence?: Array<{
    fileUrl: string;
    fileType?: string;
    fileSize?: number;
    mimeType?: string;
    description?: string;
  }>;
}

export interface SellerRespondInput {
  disputeId: string;
  sellerUserId: string;
  response: string;
  acceptClaim?: boolean;
  evidence?: Array<{
    fileUrl: string;
    fileType?: string;
    fileSize?: number;
    mimeType?: string;
    description?: string;
  }>;
}

export interface SubmitEvidenceInput {
  disputeId: string;
  userId: string;
  role: RefundActorType;
  fileUrl: string;
  fileType?: string;
  fileSize?: number;
  mimeType?: string;
  description?: string;
}

export interface AdminResolveInput {
  disputeId: string;
  adminUserId: string;
  decision: 'FULL_REFUND' | 'PARTIAL_REFUND' | 'REJECTED' | 'SELLER_FAVOR';
  resolution: string;
  refundAmount?: number;
  note?: string;
}

export interface AppealDisputeInput {
  disputeId: string;
  userId: string;
  role: 'CUSTOMER' | 'SELLER';
  appealReason: string;
  evidence?: Array<{
    fileUrl: string;
    fileType?: string;
    fileSize?: number;
    mimeType?: string;
    description?: string;
  }>;
}

export class DisputeService {
  /**
   * Allowed MIME types and size limit (15MB) for dispute evidence files
   */
  private static readonly ALLOWED_EVIDENCE_MIMES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'application/pdf',
    'video/mp4',
    'video/quicktime',
  ];
  private static readonly MAX_EVIDENCE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

  /**
   * Validate single evidence upload
   */
  public static validateEvidenceFile(file: {
    fileUrl: string;
    fileSize?: number;
    mimeType?: string;
  }) {
    if (!file.fileUrl || !file.fileUrl.trim()) {
      throw new AppError('رابط الملف مطلوب لرفع الدليل', 400);
    }
    if (file.fileSize && file.fileSize > this.MAX_EVIDENCE_SIZE_BYTES) {
      throw new AppError('حجم الملف يتجاوز الحد الأقصى المسموح به (15 ميغابايت)', 400);
    }
    if (file.mimeType && !this.ALLOWED_EVIDENCE_MIMES.includes(file.mimeType.toLowerCase())) {
      throw new AppError(
        'نوع الملف غير مدعوم. الأنواع المدعومة: صور (JPEG, PNG, WEBP)، مستندات PDF، أو مقاطع فيديو قصيرة',
        400
      );
    }
  }

  /**
   * 1. Customer opens a dispute on an order or after a refund rejection.
   */
  static async openDispute(input: CreateDisputeInput) {
    const { customerId, orderId, reason, description, refundRequestId, evidence } = input;

    if (!reason || reason.trim().length < 3) {
      throw new AppError('سبب النزاع إلزامي ويجب ألا يقل عن 3 أحرف', 400);
    }
    if (!description || description.trim().length < 5) {
      throw new AppError('يرجى تقديم تفاصيل واضحة للنزاع لا تقل عن 5 أحرف', 400);
    }

    // Verify order ownership
    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id: orderId }, { orderNumber: orderId }],
        userId: customerId,
      },
      include: {
        addressSnapshot: true,
        sellerOrders: {
          include: {
            seller: { select: { id: true, userId: true } },
          },
        },
      },
    });

    if (!order) {
      throw new AppError('الطلب غير موجود أو غير مرتبط بحسابك', 404);
    }

    // Check if dispute already exists and is active
    const activeDispute = await prisma.dispute.findFirst({
      where: {
        orderId: order.id,
        status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
      },
    });
    if (activeDispute) {
      throw new AppError('يوجد نزاع مفتوح بالفعل لهذا الطلب وهو قيد المتابعة حالياً', 400);
    }

    // Check if previously resolved
    const resolvedDispute = await prisma.dispute.findFirst({
      where: {
        orderId: order.id,
        status: { in: [DisputeStatus.RESOLVED, DisputeStatus.REJECTED] },
      },
    });
    if (resolvedDispute) {
      throw new AppError(
        'تم البت في نزاع سابق لهذا الطلب. إذا كان لديك مستندات جديدة، يمكنك تقديم طلب استئناف على النزاع السابق.',
        400
      );
    }

    // Identify target seller
    const targetSeller = order.sellerOrders[0]?.seller;
    if (!targetSeller) {
      throw new AppError('لا يوجد متجر مرتبط بهذا الطلب لمعالجة النزاع', 400);
    }

    // Validate evidence files
    if (evidence && evidence.length > 0) {
      if (evidence.length > 10) {
        throw new AppError('لا يمكن إرفاق أكثر من 10 ملفات دفعة واحدة', 400);
      }
      for (const ev of evidence) {
        this.validateEvidenceFile(ev);
      }
    }

    // Find or correlate related RefundRequest
    let refundReq = refundRequestId
      ? await prisma.refundRequest.findUnique({ where: { id: refundRequestId } })
      : await prisma.refundRequest.findFirst({
          where: { orderId: order.id, customerId },
          orderBy: { createdAt: 'desc' },
        });

    const result = await prisma.$transaction(async (tx) => {
      // Create canonical Dispute record
      const dispute = await tx.dispute.create({
        data: {
          customerId,
          sellerId: targetSeller.id,
          orderId: order.id,
          reason,
          description,
          status: DisputeStatus.OPEN,
          refundAmount: order.total,
          adminNotes: `[${new Date().toISOString()}] تم فتح النزاع من قبل العميل على الطلب #${order.orderNumber}.`,
        },
      });

      if (!refundReq) {
        refundReq = await tx.refundRequest.create({
          data: {
            refundNumber: `REF-DSP-${dispute.id.substring(0, 8)}`,
            orderId: order.id,
            customerId,
            sellerId: targetSeller.id,
            status: RefundStatus.ADMIN_REVIEW,
            reasonText: reason,
            description,
            requestedAmount: order.total,
          },
        });
      } else {
        await tx.refundRequest.update({
          where: { id: refundReq.id },
          data: { status: RefundStatus.ADMIN_REVIEW },
        });
      }

      await tx.refundStatusHistory.create({
        data: {
          refundRequestId: refundReq.id,
          fromStatus: refundReq.status,
          toStatus: RefundStatus.ADMIN_REVIEW,
          changedBy: customerId,
          actorType: RefundActorType.CUSTOMER,
          reason: `تصعيد نزاع #${dispute.id}: ${reason}`,
        },
      });

      // Attach evidence if provided
      if (evidence && evidence.length > 0) {
        for (const ev of evidence) {
          await tx.refundEvidence.create({
            data: {
              refundRequestId: refundReq.id,
              uploadedBy: customerId,
              uploadedByRole: RefundActorType.CUSTOMER,
              fileUrl: ev.fileUrl,
              fileType: ev.fileType || 'image/jpeg',
              fileSize: ev.fileSize || 0,
              mimeType: ev.mimeType || 'image/jpeg',
              description: ev.description || 'دليل إثبات النزاع',
            },
          });
        }
      }

      // Record Audit Log
      await tx.auditLog.create({
        data: {
          userId: customerId,
          action: 'DISPUTE_OPENED',
          resource: 'disputes',
          details: JSON.stringify({
            disputeId: dispute.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            reason,
            sellerId: targetSeller.id,
          }),
        },
      });

      return { dispute, order, targetSeller, refundReq };
    });

    const { dispute, refundReq: finalRefundReq } = result;

    // Real-time broadcasts
    try {
      const socket = SocketService.get();
      if (socket) {
        // Broadcast to dispute detail room
        socket.emitDisputeUpdate(dispute.id, 'dispute:created', {
          disputeId: dispute.id,
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerId,
          sellerId: targetSeller.id,
          reason,
          status: dispute.status,
          createdAt: dispute.createdAt,
        });

        // Broadcast to admin team
        socket.emitToRoom('admin:disputes', 'admin:new_dispute', {
          disputeId: dispute.id,
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerName: `${order.addressSnapshot?.recipientName || 'العميل'}`,
          reason,
          refundAmount: order.total,
          createdAt: dispute.createdAt,
        });

        // Update live status for the order
        socket.emitGlobal('dispute:created', {
          orderId: order.id,
          disputeId: dispute.id,
          refundId: finalRefundReq?.id,
        });

        // Targeted alerts for seller
        if (targetSeller.userId) {
          socket.emitToUser(targetSeller.userId, 'dispute:created', {
            disputeId: dispute.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            refundId: finalRefundReq?.id,
            reason,
            status: dispute.status,
            createdAt: dispute.createdAt,
          });
          socket.emitToUser(targetSeller.userId, 'refund:disputed', {
            disputeId: dispute.id,
            orderId: order.id,
            refundId: finalRefundReq?.id,
            status: 'ADMIN_REVIEW',
          });
        }
      }
    } catch (sockErr) {
      console.error('[DisputeService] Socket broadcast error:', sockErr);
    }

    // Durable In-App & Push Notifications (Guaranteed persistence)
    try {
      const dispatches: Promise<any>[] = [
        notificationDispatcher.dispatch(
          NotificationEventFactory.disputeEvent({
            eventType: 'DISPUTE_CREATED',
            recipientId: customerId,
            disputeId: dispute.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            refundId: finalRefundReq?.id,
            reason,
            recipientRole: 'CUSTOMER',
          })
        ),
      ];

      if (targetSeller.userId) {
        dispatches.push(
          notificationDispatcher.dispatch(
            NotificationEventFactory.disputeEvent({
              eventType: 'DISPUTE_SELLER_NOTIFIED',
              recipientId: targetSeller.userId,
              disputeId: dispute.id,
              orderId: order.id,
              orderNumber: order.orderNumber,
              refundId: finalRefundReq?.id,
              reason,
              deadline: '48h',
              recipientRole: 'SELLER',
            })
          )
        );
      }

      // Notify authorized administrators via RBAC
      dispatches.push(
        adminNotificationRouter.routeAndDispatch({
          eventType: 'DISPUTE_CREATED',
          category: NotificationCategory.REFUND,
          priority: NotificationPriority.HIGH,
          titleAr: `نزاع جديد على الطلب #${order.orderNumber}`,
          titleEn: `New dispute on order #${order.orderNumber}`,
          messageAr: `تم فتح نزاع جديد للطلب #${order.orderNumber} بسبب: ${reason}`,
          messageEn: `New dispute opened for order #${order.orderNumber} for reason: ${reason}`,
          referenceId: dispute.id,
          data: {
            disputeId: dispute.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            reason,
            deepLink: `souqnaa://admin/disputes/${dispute.id}`,
          },
        })
      );

      await Promise.allSettled(dispatches);
    } catch (notifErr) {
      console.error('[DisputeService] Notification dispatch error:', notifErr);
    }

    return dispute;
  }

  /**
   * 2. Seller responds to dispute with explanation and optional counter-evidence.
   */
  static async sellerRespond(input: SellerRespondInput) {
    const { disputeId, sellerUserId, response, acceptClaim, evidence } = input;

    if (!response || response.trim().length < 5) {
      throw new AppError('رد وتوضيح المتجر إلزامي ولا يقل عن 5 أحرف', 400);
    }

    // Verify seller ownership
    const seller = await prisma.seller.findFirst({
      where: { userId: sellerUserId },
    });
    if (!seller) {
      throw new AppError('حساب التاجر غير موجود أو غير مفعل', 403);
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { customer: true },
    });
    if (!dispute) {
      throw new AppError('النزاع غير موجود', 404);
    }
    if (dispute.sellerId !== seller.id) {
      throw new AppError('غير مصرح لك بالرد على هذا النزاع', 403);
    }

    if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.REJECTED) {
      throw new AppError('لا يمكن تقديم رد جديد؛ تم البت في النزاع وإغلاقه مسبقاً', 400);
    }

    if (evidence && evidence.length > 0) {
      for (const ev of evidence) {
        this.validateEvidenceFile(ev);
      }
    }

    const updatedDispute = await prisma.$transaction(async (tx) => {
      const timestamp = new Date().toISOString();
      const updatedNotes = `${dispute.adminNotes || ''}\n[${timestamp}] رد المتجر: ${response}`.trim();

      const updated = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: DisputeStatus.UNDER_REVIEW,
          adminNotes: updatedNotes,
        },
      });

      // Find related RefundRequest to attach seller response & evidence
      const refundReq = await tx.refundRequest.findFirst({
        where: { orderId: dispute.orderId },
        orderBy: { createdAt: 'desc' },
      });

      if (refundReq) {
        await tx.refundMessage.create({
          data: {
            refundRequestId: refundReq.id,
            senderId: sellerUserId,
            senderRole: RefundActorType.SELLER,
            message: response,
          },
        });

        if (evidence && evidence.length > 0) {
          for (const ev of evidence) {
            await tx.refundEvidence.create({
              data: {
                refundRequestId: refundReq.id,
                uploadedBy: sellerUserId,
                uploadedByRole: RefundActorType.SELLER,
                fileUrl: ev.fileUrl,
                fileType: ev.fileType || 'image/jpeg',
                fileSize: ev.fileSize || 0,
                mimeType: ev.mimeType || 'image/jpeg',
                description: ev.description || 'مستند أو دليل من المتجر',
              },
            });
          }
        }

        await tx.refundStatusHistory.create({
          data: {
            refundRequestId: refundReq.id,
            fromStatus: refundReq.status,
            toStatus: RefundStatus.UNDER_SELLER_REVIEW,
            changedBy: sellerUserId,
            actorType: RefundActorType.SELLER,
            reason: `رد المتجر على النزاع: ${response.substring(0, 80)}`,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId: sellerUserId,
          action: 'DISPUTE_SELLER_RESPONDED',
          resource: 'disputes',
          details: JSON.stringify({
            disputeId,
            response,
            acceptClaim: !!acceptClaim,
            evidenceCount: evidence?.length || 0,
          }),
        },
      });

      return updated;
    });

    // Real-time broadcasts
    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitDisputeUpdate(dispute.id, 'dispute:seller_responded', {
          disputeId: dispute.id,
          orderId: dispute.orderId,
          sellerResponse: response,
          status: updatedDispute.status,
          updatedAt: updatedDispute.updatedAt,
        });

        socket.emitToUser(dispute.customerId, 'dispute:updated', {
          disputeId: dispute.id,
          orderId: dispute.orderId,
          status: updatedDispute.status,
        });
      }
    } catch (_) {}

    // Notifications
    try {
      // Notify Customer
      notificationDispatcher.dispatch(
        NotificationEventFactory.disputeEvent({
          eventType: 'DISPUTE_SELLER_RESPONDED',
          recipientId: dispute.customerId,
          disputeId: dispute.id,
          orderId: dispute.orderId,
          recipientRole: 'CUSTOMER',
        })
      );
    } catch (_) {}

    return updatedDispute;
  }

  /**
   * 3. Submit new evidence to an existing dispute (Customer or Seller).
   */
  static async submitEvidence(input: SubmitEvidenceInput) {
    const { disputeId, userId, role, fileUrl, fileType, fileSize, mimeType, description } = input;

    this.validateEvidenceFile({ fileUrl, fileSize, mimeType });

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        seller: { select: { id: true, userId: true } },
      },
    });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    // Authorization
    if (role === RefundActorType.CUSTOMER && dispute.customerId !== userId) {
      throw new AppError('غير مصرح لك بإرفاق أدلة لهذا النزاع', 403);
    }
    if (role === RefundActorType.SELLER && dispute.seller?.userId !== userId) {
      throw new AppError('غير مصرح لك بإرفاق أدلة لهذا النزاع', 403);
    }

    if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.REJECTED) {
      throw new AppError('لا يمكن إرفاق أدلة جديدة بعد إغلاق النزاع', 400);
    }

    // Find correlated refund request
    let refundReq = await prisma.refundRequest.findFirst({
      where: { orderId: dispute.orderId },
      orderBy: { createdAt: 'desc' },
    });

    if (!refundReq) {
      // Create minimal refund request record to preserve relational integrity
      refundReq = await prisma.refundRequest.create({
        data: {
          refundNumber: `REF-DSP-${dispute.id.substring(0, 8)}`,
          orderId: dispute.orderId,
          customerId: dispute.customerId,
          sellerId: dispute.sellerId,
          status: RefundStatus.ADMIN_REVIEW,
          reasonText: dispute.reason,
          description: dispute.description,
          requestedAmount: dispute.refundAmount || 0,
        },
      });
    }

    const evidence = await prisma.refundEvidence.create({
      data: {
        refundRequestId: refundReq.id,
        uploadedBy: userId,
        uploadedByRole: role,
        fileUrl,
        fileType: fileType || 'image/jpeg',
        fileSize: fileSize || 0,
        mimeType: mimeType || 'image/jpeg',
        description: description || null,
      },
    });

    // Real-time broadcasts
    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitDisputeUpdate(dispute.id, 'dispute:evidence', {
          disputeId: dispute.id,
          evidence,
        });
      }
    } catch (_) {}

    // Notify other party
    try {
      const counterpartyId =
        role === RefundActorType.CUSTOMER ? dispute.seller.userId : dispute.customerId;
      const counterpartyRole = role === RefundActorType.CUSTOMER ? 'SELLER' : 'CUSTOMER';

      if (counterpartyId) {
        notificationDispatcher.dispatch(
          NotificationEventFactory.disputeEvent({
            eventType: 'DISPUTE_EVIDENCE_SUBMITTED',
            recipientId: counterpartyId,
            disputeId: dispute.id,
            orderId: dispute.orderId,
            recipientRole: counterpartyRole,
          })
        );
      }
    } catch (_) {}

    return evidence;
  }

  /**
   * 4. Send a message in dispute case thread.
   */
  static async sendMessage(params: {
    disputeId: string;
    senderId: string;
    senderRole: RefundActorType;
    message: string;
    isPrivateAdminNote?: boolean;
  }) {
    const { disputeId, senderId, senderRole, message, isPrivateAdminNote = false } = params;

    if (!message || !message.trim()) {
      throw new AppError('نص الرسالة مطلوب', 400);
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { seller: { select: { userId: true } } },
    });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    // Enforce authorization
    if (senderRole === RefundActorType.CUSTOMER && dispute.customerId !== senderId) {
      throw new AppError('غير مصرح لك بالمشاركة في هذا النزاع', 403);
    }
    if (senderRole === RefundActorType.SELLER && dispute.seller.userId !== senderId) {
      throw new AppError('غير مصرح لك بالمشاركة في هذا النزاع', 403);
    }

    let refundReq = await prisma.refundRequest.findFirst({
      where: { orderId: dispute.orderId },
      orderBy: { createdAt: 'desc' },
    });

    if (!refundReq) {
      refundReq = await prisma.refundRequest.create({
        data: {
          refundNumber: `REF-DSP-${dispute.id.substring(0, 8)}`,
          orderId: dispute.orderId,
          customerId: dispute.customerId,
          sellerId: dispute.sellerId,
          status: RefundStatus.ADMIN_REVIEW,
          reasonText: dispute.reason,
          description: dispute.description,
          requestedAmount: dispute.refundAmount || 0,
        },
      });
    }

    const createdMsg = await prisma.refundMessage.create({
      data: {
        refundRequestId: refundReq.id,
        senderId,
        senderRole,
        message,
        isPrivateAdminNote: senderRole === RefundActorType.ADMIN && isPrivateAdminNote,
      },
      include: {
        sender: { select: { id: true, firstName: true, lastName: true, role: true } },
      },
    });

    // Real-time broadcast
    try {
      const socket = SocketService.get();
      if (socket) {
        if (createdMsg.isPrivateAdminNote) {
          socket.emitToRoom('admin:disputes', 'dispute:message', createdMsg);
        } else {
          socket.emitDisputeUpdate(dispute.id, 'dispute:message', createdMsg);
        }
      }
    } catch (_) {}

    return createdMsg;
  }

  /**
   * 5. Admin requests additional information from Customer or Seller.
   */
  static async requestInformation(params: {
    disputeId: string;
    adminUserId: string;
    targetRole: 'CUSTOMER' | 'SELLER';
    requestNote: string;
    deadlineHours?: number;
  }) {
    const { disputeId, adminUserId, targetRole, requestNote, deadlineHours = 48 } = params;

    if (!requestNote || requestNote.trim().length < 5) {
      throw new AppError('نص طلب المعلومات مطلوب ولا يقل عن 5 أحرف', 400);
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { seller: { select: { userId: true } } },
    });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    const timestamp = new Date().toISOString();
    const updatedNotes = `${dispute.adminNotes || ''}\n[${timestamp}] طلب المشرف (${targetRole}): ${requestNote}`.trim();

    await prisma.dispute.update({
      where: { id: disputeId },
      data: {
        status: DisputeStatus.UNDER_REVIEW,
        adminNotes: updatedNotes,
      },
    });

    // Log message in thread
    let refundReq = await prisma.refundRequest.findFirst({
      where: { orderId: dispute.orderId },
    });
    if (refundReq) {
      await prisma.refundMessage.create({
        data: {
          refundRequestId: refundReq.id,
          senderId: adminUserId,
          senderRole: RefundActorType.ADMIN,
          message: `طلب توضيح من الإدارة موجه إلى (${targetRole}): ${requestNote}`,
        },
      });
    }

    // Real-time broadcast
    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitDisputeUpdate(dispute.id, 'dispute:info_requested', {
          disputeId,
          targetRole,
          note: requestNote,
          deadline: `${deadlineHours}h`,
        });
      }
    } catch (_) {}

    // Dispatch Notification
    const recipientId =
      targetRole === 'CUSTOMER' ? dispute.customerId : dispute.seller?.userId;
    if (recipientId) {
      notificationDispatcher.dispatch(
        NotificationEventFactory.disputeEvent({
          eventType: 'DISPUTE_INFO_REQUESTED',
          recipientId,
          disputeId: dispute.id,
          orderId: dispute.orderId,
          note: requestNote,
          recipientRole: targetRole,
        })
      );
    }

    return { success: true, message: 'تم إرسال طلب المعلومات الإضافية بنجاح' };
  }

  /**
   * 6. Admin resolves dispute with authoritative financial resolution.
   */
  static async resolveDispute(input: AdminResolveInput) {
    const { disputeId, adminUserId, decision, resolution, refundAmount = 0, note } = input;

    if (!resolution || resolution.trim().length < 5) {
      throw new AppError('نص قرار التسوية والتحكيم مطلوب ولا يقل عن 5 أحرف', 400);
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        seller: { select: { id: true, userId: true } },
      },
    });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    const relatedOrder = await prisma.order.findFirst({
      where: { OR: [{ id: dispute.orderId }, { orderNumber: dispute.orderId }] },
      select: { id: true, orderNumber: true },
    });
    const orderNumber = relatedOrder?.orderNumber || dispute.orderId;

    const parsedRefundAmount = Math.max(0, Number(refundAmount) || 0);
    const isRejected = decision === 'REJECTED' || decision === 'SELLER_FAVOR';
    const finalStatus = isRejected ? DisputeStatus.REJECTED : DisputeStatus.RESOLVED;

    const updatedDispute = await prisma.$transaction(async (tx) => {
      const timestamp = new Date().toISOString();
      let updatedNotes = dispute.adminNotes || '';
      updatedNotes = `${updatedNotes}\n[${timestamp}] قرار الإدارة (${decision}): ${resolution}`.trim();
      if (note) {
        updatedNotes = `${updatedNotes} - ملاحظة داخلية: ${note}`.trim();
      }

      const d = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: finalStatus,
          decision,
          resolution,
          refundAmount: parsedRefundAmount > 0 ? parsedRefundAmount : null,
          adminNotes: updatedNotes,
        },
      });

      // Financial resolution if customer favor with amount
      if (parsedRefundAmount > 0 && !isRejected) {
        // Record canonical Refund
        await tx.refund.create({
          data: {
            orderId: dispute.orderId,
            amount: parsedRefundAmount,
            reason: `تسوية نزاع #${disputeId}: ${resolution}`,
            status: 'COMPLETED',
          },
        });

        // Update Order status
        await tx.order.updateMany({
          where: { OR: [{ id: dispute.orderId }, { orderNumber: dispute.orderId }] },
          data: { status: OrderStatus.REFUNDED },
        });

        await tx.sellerOrder.updateMany({
          where: { OR: [{ orderId: dispute.orderId }, { id: dispute.orderId }] },
          data: { status: 'REFUNDED' },
        });

        await tx.payment.updateMany({
          where: { orderId: dispute.orderId },
          data: { status: PaymentStatus.REFUNDED },
        });

        // Resolve correlated RefundRequest
        let targetRefund = await tx.refundRequest.findFirst({
          where: { orderId: dispute.orderId },
          orderBy: { createdAt: 'desc' },
        });

        if (!targetRefund) {
          targetRefund = await tx.refundRequest.create({
            data: {
              refundNumber: `REF-DSP-${dispute.id.substring(0, 8)}`,
              orderId: dispute.orderId,
              customerId: dispute.customerId,
              sellerId: dispute.sellerId,
              status: isRejected ? RefundStatus.CLOSED : RefundStatus.REFUNDED,
              reasonText: dispute.reason,
              description: dispute.description,
              requestedAmount: dispute.refundAmount || parsedRefundAmount,
              approvedAmount: parsedRefundAmount,
            },
          });
        }

        // Credit customer wallet
        if (dispute.customerId) {
          await CustomerWalletService.creditRefund(
            {
              customerId: dispute.customerId,
              amount: parsedRefundAmount,
              refundId: targetRefund.id,
              currency: 'YER',
              orderNumber: dispute.orderId,
              refundNumber: `DISPUTE-${dispute.id.substring(0, 8)}`,
              adminUserId,
            },
            tx
          );
        }

        // Adjust seller balance / settlement ledger
        try {
          await RefundService.adjustSellerSettlement(
            {
              sellerId: dispute.sellerId,
              orderId: dispute.orderId,
              currency: 'YER',
              refundNumber: `DISPUTE-${dispute.id.substring(0, 8)}`,
            },
            parsedRefundAmount,
            tx
          );
        } catch (settleErr) {
          console.error('[DisputeService] Seller settlement adjustment warning:', settleErr);
        }
      }

      // Synchronize related RefundRequest
      const relatedRefunds = await tx.refundRequest.findMany({
        where: {
          orderId: dispute.orderId,
          status: {
            in: [
              RefundStatus.ADMIN_REVIEW,
              RefundStatus.CUSTOMER_DISPUTED,
              RefundStatus.DISPUTED,
              RefundStatus.REQUESTED,
              RefundStatus.SELLER_REVIEW,
            ],
          },
        },
      });

      for (const rr of relatedRefunds) {
        const toStatus = isRejected ? RefundStatus.CLOSED : RefundStatus.REFUNDED;
        await tx.refundRequest.update({
          where: { id: rr.id },
          data: {
            status: toStatus,
            adminDecision: decision,
            adminDecisionReason: resolution,
            resolvedAt: new Date(),
            approvedAmount: !isRejected && parsedRefundAmount > 0 ? parsedRefundAmount : undefined,
          },
        });

        await tx.refundStatusHistory.create({
          data: {
            refundRequestId: rr.id,
            fromStatus: rr.status,
            toStatus,
            changedBy: adminUserId,
            actorType: RefundActorType.ADMIN,
            reason: `تسوية النزاع #${disputeId}: ${resolution}`,
          },
        });
      }

      // In-App Notification for Customer
      await tx.notification.create({
        data: {
          userId: dispute.customerId,
          recipientType: 'CUSTOMER',
          category: 'REFUND',
          priority: 'HIGH',
          titleAr: isRejected
            ? `قرار الإدارة بشأن النزاع للطلب #${orderNumber} ⚖️`
            : (decision === 'PARTIAL_REFUND'
                ? `قرار الإدارة: استرداد جزئي للطلب #${orderNumber} 💰`
                : `قرار الإدارة: استرداد كامل للطلب #${orderNumber} 💰`),
          titleEn: `Dispute Decision for order #${orderNumber} ⚖️`,
          bodyAr: isRejected
            ? `أصدرت إدارة المنصة قراراً برفض النزاع للطلب #${orderNumber}: ${resolution}`
            : (decision === 'PARTIAL_REFUND'
                ? `أصدرت إدارة المنصة قراراً باسترداد جزئي بمبلغ ${parsedRefundAmount} ر.ي للطلب #${orderNumber}: ${resolution}`
                : `أصدرت إدارة المنصة قراراً باسترداد كامل بمبلغ ${parsedRefundAmount} ر.ي للطلب #${orderNumber}: ${resolution}`),
          bodyEn: `Dispute decision finalized for order #${orderNumber}: ${resolution}`,
          type: isRejected ? NotificationType.REFUND_ADMIN_REJECTED : NotificationType.REFUND_ADMIN_APPROVED,
          data: JSON.stringify({
            disputeId: dispute.id,
            orderId: dispute.orderId,
            orderNumber,
            decision,
            resolution,
            refundAmount: parsedRefundAmount,
          }),
          deepLink: isRejected ? `souqnaa://disputes/${dispute.id}` : 'souqnaa://wallet',
          status: 'SENT',
          isRead: false,
        },
      });

      // In-App Notification for Seller
      if (dispute.seller?.userId) {
        await tx.notification.create({
          data: {
            userId: dispute.seller.userId,
            recipientType: 'SELLER',
            category: 'REFUND',
            priority: 'HIGH',
            titleAr: `قرار التحكيم الإداري للطلب #${orderNumber} ⚖️`,
            titleEn: `Admin Decision for order #${orderNumber} ⚖️`,
            bodyAr: `أصدرت إدارة المنصة قرارها النهائي بشأن النزاع للطلب #${orderNumber}: ${resolution}`,
            bodyEn: `Admin finalized dispute decision for order #${orderNumber}: ${resolution}`,
            type: isRejected ? NotificationType.REFUND_ADMIN_REJECTED : NotificationType.REFUND_ADMIN_APPROVED,
            data: JSON.stringify({
              disputeId: dispute.id,
              orderId: dispute.orderId,
              orderNumber,
              decision,
              resolution,
              refundAmount: parsedRefundAmount,
            }),
            deepLink: `souqnaa://seller/refunds/${dispute.id}`,
            status: 'SENT',
            isRead: false,
          },
        });
      }

      return d;
    }, { maxWait: 5000, timeout: 10000 });

    // Audit Log (outside transaction so database connection lock is released immediately)
    prisma.auditLog.create({
      data: {
        userId: adminUserId,
        action: 'DISPUTE_RESOLVED',
        resource: 'disputes',
        details: JSON.stringify({
          disputeId,
          decision,
          resolution,
          refundAmount: parsedRefundAmount,
          status: finalStatus,
        }),
      },
    }).catch((auditErr) => console.error('[DisputeService] Audit log write warning:', auditErr));

    // Real-time broadcasts
    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitDisputeUpdate(dispute.id, 'dispute:resolved', {
          disputeId: dispute.id,
          orderId: dispute.orderId,
          decision,
          resolution,
          refundAmount: parsedRefundAmount,
          status: finalStatus,
        });

        socket.emitGlobal('dispute:resolved', {
          disputeId: dispute.id,
          orderId: dispute.orderId,
          status: finalStatus,
        });

        socket.emitGlobal('order:status', {
          orderId: dispute.orderId,
          status: isRejected ? 'DELIVERED' : 'REFUNDED',
        });
      }
    } catch (_) {}

    // Dispatch Notifications to Customer and Seller
    try {
      // Customer notification
      notificationDispatcher.dispatch(
        NotificationEventFactory.disputeEvent({
          eventType: 'DISPUTE_RESOLVED',
          recipientId: dispute.customerId,
          disputeId: dispute.id,
          orderId: dispute.orderId,
          orderNumber,
          decision,
          resolution,
          refundAmount: parsedRefundAmount,
          recipientRole: 'CUSTOMER',
        })
      );

      // Seller notification
      if (dispute.seller?.userId) {
        notificationDispatcher.dispatch(
          NotificationEventFactory.disputeEvent({
            eventType: 'DISPUTE_RESOLVED',
            recipientId: dispute.seller.userId,
            disputeId: dispute.id,
            orderId: dispute.orderId,
            orderNumber,
            decision,
            resolution,
            refundAmount: parsedRefundAmount,
            recipientRole: 'SELLER',
          })
        );
      }
    } catch (notifErr) {
      console.error('[DisputeService] Notification dispatch error on resolve:', notifErr);
    }

    return updatedDispute;
  }

  /**
   * 7. Appeal / Reopen a decided dispute within policy window (e.g. 7 days).
   */
  static async appealDispute(input: AppealDisputeInput) {
    const { disputeId, userId, role, appealReason, evidence } = input;

    if (!appealReason || appealReason.trim().length < 5) {
      throw new AppError('سبب ودفوع الاستئناف إلزامية ولا تقل عن 5 أحرف', 400);
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { seller: { select: { userId: true } } },
    });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    // Verify appeal eligibility
    if (role === 'CUSTOMER' && dispute.customerId !== userId) {
      throw new AppError('غير مصرح لك باستئناف هذا النزاع', 403);
    }
    if (role === 'SELLER' && dispute.seller?.userId !== userId) {
      throw new AppError('غير مصرح لك باستئناف هذا النزاع', 403);
    }

    if (dispute.status !== DisputeStatus.RESOLVED && dispute.status !== DisputeStatus.REJECTED) {
      throw new AppError('النزاع لا يزال قيد التحقيق حالياً ولا يحتاج إلى استئناف', 400);
    }

    // Validate 7-day policy appeal window
    const daysSinceDecision = Math.floor(
      (Date.now() - new Date(dispute.updatedAt).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysSinceDecision > 7) {
      throw new AppError('انتهت المهلة المحددة لتقديم طلب الاستئناف (7 أيام من تاريخ القرار)', 400);
    }

    if (evidence && evidence.length > 0) {
      for (const ev of evidence) {
        this.validateEvidenceFile(ev);
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const timestamp = new Date().toISOString();
      const updatedNotes = `${dispute.adminNotes || ''}\n[${timestamp}] طلب استئناف (${role}): ${appealReason}`.trim();

      const d = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: DisputeStatus.UNDER_REVIEW,
          adminNotes: updatedNotes,
        },
      });

      // Attach evidence if present
      const refundReq = await tx.refundRequest.findFirst({
        where: { orderId: dispute.orderId },
      });
      if (refundReq && evidence && evidence.length > 0) {
        for (const ev of evidence) {
          await tx.refundEvidence.create({
            data: {
              refundRequestId: refundReq.id,
              uploadedBy: userId,
              uploadedByRole: role === 'CUSTOMER' ? RefundActorType.CUSTOMER : RefundActorType.SELLER,
              fileUrl: ev.fileUrl,
              fileType: ev.fileType || 'image/jpeg',
              fileSize: ev.fileSize || 0,
              mimeType: ev.mimeType || 'image/jpeg',
              description: ev.description || 'مستندات دعم طلب الاستئناف',
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: 'DISPUTE_APPEALED',
          resource: 'disputes',
          details: JSON.stringify({
            disputeId,
            role,
            appealReason,
          }),
        },
      });

      return d;
    }, { maxWait: 20000, timeout: 45000 });

    // Real-time broadcasts
    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitDisputeUpdate(dispute.id, 'dispute:appealed', {
          disputeId,
          role,
          appealReason,
          status: updated.status,
        });
        socket.emitToRoom('admin:disputes', 'admin:dispute_appealed', {
          disputeId,
          orderId: dispute.orderId,
          role,
        });
      }
    } catch (_) {}

    // Notifications
    try {
      notificationDispatcher.dispatch(
        NotificationEventFactory.disputeEvent({
          eventType: 'DISPUTE_APPEALED',
          recipientId: userId,
          disputeId: dispute.id,
          orderId: dispute.orderId,
          recipientRole: role,
        })
      );
    } catch (_) {}

    return updated;
  }

  /**
   * 8. Live Reconciliation Sync for reconnect / foreground resume (§E)
   */
  static async syncDispute(disputeId: string, userId: string, userRole: string, since?: Date) {
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        seller: {
          include: {
            stores: { select: { id: true, name: true, logo: true } },
            user: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    // Authorization
    const isAdmin = userRole === 'ADMIN';
    const isCustomer = dispute.customerId === userId;
    const isSeller = dispute.seller.userId === userId;

    if (!isAdmin && !isCustomer && !isSeller) {
      throw new AppError('غير مصرح لك بالوصول إلى بيانات هذا النزاع', 403);
    }

    const whereSince = since ? { createdAt: { gt: since } } : {};

    const refundReq = await prisma.refundRequest.findFirst({
      where: { orderId: dispute.orderId },
      include: {
        evidence: {
          where: whereSince,
          orderBy: { createdAt: 'desc' },
        },
        messages: {
          where: {
            ...whereSince,
            ...(isAdmin ? {} : { isPrivateAdminNote: false }),
          },
          include: {
            sender: { select: { id: true, firstName: true, lastName: true, role: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        statusHistory: {
          where: whereSince,
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return {
      dispute,
      evidence: refundReq?.evidence || [],
      messages: refundReq?.messages || [],
      statusHistory: refundReq?.statusHistory || [],
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * 9. Scheduled Routine: Check dispute SLA deadlines (36h reminder & 48h auto-escalation) (§Phase 5)
   */
  static async checkDisputeDeadlines(): Promise<{ remindersSent: number; escalatedCount: number }> {
    let remindersSent = 0;
    let escalatedCount = 0;

    try {
      const openDisputes = await prisma.dispute.findMany({
        where: {
          status: DisputeStatus.OPEN,
        },
        include: {
          seller: { select: { id: true, userId: true } },
        },
        take: 50,
      });

      if (!openDisputes.length) return { remindersSent: 0, escalatedCount: 0 };

      const now = Date.now();

      for (const dispute of openDisputes) {
        const elapsedHours = (now - new Date(dispute.createdAt).getTime()) / (1000 * 60 * 60);

        // A. 36-Hour Warning: Approaching Deadline
        if (elapsedHours >= 36 && elapsedHours < 48) {
          const reminderKey = `dispute_reminder_36h:${dispute.id}`;
          const alreadyReminded = await redis.get(reminderKey);

          if (!alreadyReminded) {
            await redis.set(reminderKey, '1', 7 * 24 * 60 * 60);

            if (dispute.seller?.userId) {
              notificationDispatcher.dispatch(
                NotificationEventFactory.disputeEvent({
                  eventType: 'DISPUTE_DEADLINE_APPROACHING',
                  recipientId: dispute.seller.userId,
                  disputeId: dispute.id,
                  orderId: dispute.orderId,
                  orderNumber: dispute.orderId,
                  recipientRole: 'SELLER',
                  deadline: '12h',
                })
              );
            }

            try {
              const socket = SocketService.get();
              if (socket) {
                socket.emitDisputeUpdate(dispute.id, 'dispute:deadline_approaching', {
                  disputeId: dispute.id,
                  orderId: dispute.orderId,
                  remainingHours: Math.max(0, Math.round(48 - elapsedHours)),
                });
              }
            } catch (_) {}

            remindersSent++;
          }
        }

        // B. 48-Hour Deadline Exceeded: Auto-Escalate to Admin
        if (elapsedHours >= 48) {
          const escalateKey = `dispute_escalated_48h:${dispute.id}`;
          const alreadyEscalated = await redis.get(escalateKey);

          if (!alreadyEscalated) {
            await redis.set(escalateKey, '1', 7 * 24 * 60 * 60);

            const timestamp = new Date().toISOString();
            const noteText = `\n[${timestamp}] [تصعيد تلقائي] انتهاء مهلة الرد (48 ساعة) دون استجابة من المتجر، تم تصعيد النزاع للتحكيم الإداري.`;
            const currentNotes = dispute.adminNotes || '';

            await prisma.dispute.update({
              where: { id: dispute.id },
              data: {
                status: DisputeStatus.UNDER_REVIEW,
                adminNotes: `${currentNotes}${noteText}`.trim(),
              },
            });

            // Notify Customer & Seller
            notificationDispatcher.dispatch(
              NotificationEventFactory.disputeEvent({
                eventType: 'DISPUTE_ESCALATED',
                recipientId: dispute.customerId,
                disputeId: dispute.id,
                orderId: dispute.orderId,
                orderNumber: dispute.orderId,
                recipientRole: 'CUSTOMER',
              })
            );

            if (dispute.seller?.userId) {
              notificationDispatcher.dispatch(
                NotificationEventFactory.disputeEvent({
                  eventType: 'DISPUTE_ESCALATED',
                  recipientId: dispute.seller.userId,
                  disputeId: dispute.id,
                  orderId: dispute.orderId,
                  orderNumber: dispute.orderId,
                  recipientRole: 'SELLER',
                })
              );
            }

            // Notify authorized administrators via RBAC upon auto-escalation
            adminNotificationRouter.routeAndDispatch({
              eventType: 'DISPUTE_ESCALATED',
              category: NotificationCategory.REFUND,
              priority: NotificationPriority.P0_CRITICAL,
              titleAr: `تصعيد نزاع تلقائياً: الطلب #${dispute.orderId}`,
              titleEn: `Dispute Auto-Escalated: Order #${dispute.orderId}`,
              messageAr: `تم تصعيد النزاع للإدارة بعد تجاوز مهلة الـ 48 ساعة دون استجابة المتجر.`,
              messageEn: `Dispute auto-escalated to admin after 48h deadline exceeded without seller response.`,
              referenceId: dispute.id,
              data: {
                disputeId: dispute.id,
                orderId: dispute.orderId,
                deepLink: `souqnaa://admin/disputes/${dispute.id}`,
              },
            }).catch((err) => console.error('[DisputeService] Admin dispute escalation notify error:', err));

            // Real-time broadcast
            try {
              const socket = SocketService.get();
              if (socket) {
                socket.emitDisputeUpdate(dispute.id, 'dispute:escalated', {
                  disputeId: dispute.id,
                  orderId: dispute.orderId,
                  status: DisputeStatus.UNDER_REVIEW,
                  autoEscalated: true,
                });
                socket.emitToRoom('admin:disputes', 'admin:dispute_escalated', {
                  disputeId: dispute.id,
                  orderId: dispute.orderId,
                  autoEscalated: true,
                });
              }
            } catch (_) {}

            escalatedCount++;
          }
        }
      }
    } catch (err) {
      console.error('[DisputeService] checkDisputeDeadlines error:', err);
    }

    return { remindersSent, escalatedCount };
  }
}
