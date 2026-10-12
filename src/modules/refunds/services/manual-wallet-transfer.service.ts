import crypto from 'crypto';
import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import {
  ManualTransferStatus,
  RefundStatus,
  RefundDestination,
  NotificationType,
} from '@prisma/client';
import { WalletProviderRegistry } from '../../payments/adapters/wallet-provider.adapter';
import { storageService } from '../../../services/storage/storage.service';

export class ManualWalletTransferService {
  /**
   * Masks a wallet number for safe display (e.g. 77******123).
   */
  static maskNumber(walletNumber: string): string {
    if (!walletNumber) return '';
    const clean = walletNumber.trim();
    if (clean.length <= 4) return '****';
    const firstTwo = clean.slice(0, 2);
    const lastThree = clean.slice(-3);
    const maskedLength = Math.max(3, clean.length - 5);
    return `${firstTwo}${'*'.repeat(maskedLength)}${lastThree}`;
  }

  /**
   * Creates a ManualWalletTransferRequest for an approved refund targeting MANUAL_WALLET_TRANSFER.
   */
  static async createTransferRequest(
    params: {
      refundId: string;
      customerId: string;
      walletProvider: string;
      walletNumber: string;
      holderName?: string;
      amount: number;
      currency: string;
    },
    txClient?: any
  ) {
    const db = txClient || prisma;
    const { refundId, customerId, walletProvider, walletNumber, holderName, amount, currency } = params;

    // Validate wallet provider
    const adapter = WalletProviderRegistry.getAdapter(walletProvider);
    const validation = adapter.validateWalletNumber(walletNumber);
    if (!validation.isValid) {
      throw new AppError(validation.error || 'رقم المحفظة غير صالح للمزود المختار', 400);
    }

    const normalizedNumber = validation.normalized || walletNumber.trim();
    const maskedNumber = adapter.maskWalletNumber(normalizedNumber);

    return await db.manualWalletTransferRequest.upsert({
      where: { refundId },
      create: {
        refundId,
        customerId,
        walletProvider: adapter.code,
        walletNumberMasked: maskedNumber,
        walletNumberEncrypted: normalizedNumber, // Authoritative storage for authorized financial admins
        holderName: holderName || null,
        amount,
        currency: currency || 'YER',
        status: ManualTransferStatus.REQUESTED,
      },
      update: {
        walletProvider: adapter.code,
        walletNumberMasked: maskedNumber,
        walletNumberEncrypted: normalizedNumber,
        holderName: holderName || null,
        amount,
        currency: currency || 'YER',
        status: ManualTransferStatus.REQUESTED,
      },
    });
  }

  /**
   * Lists pending and active manual transfers with masked numbers.
   */
  static async listTransfers(params: {
    status?: ManualTransferStatus;
    provider?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.max(1, Math.min(50, params.limit || 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (params.status) where.status = params.status;
    if (params.provider) where.walletProvider = params.provider;

    const [total, transfers] = await Promise.all([
      prisma.manualWalletTransferRequest.count({ where }),
      prisma.manualWalletTransferRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: {
            select: { id: true, firstName: true, lastName: true, phone: true, email: true },
          },
          refund: {
            select: {
              id: true,
              refundNumber: true,
              orderId: true,
              reasonText: true,
              status: true,
              order: { select: { id: true, orderNumber: true } },
            },
          },
          proofs: {
            select: { id: true, fileUrl: true, fileType: true, uploadedAt: true },
          },
          assignedAdmin: {
            select: { id: true, firstName: true, lastName: true },
          },
          verifiedByAdmin: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
    ]);

    return {
      transfers: transfers.map((t) => ({
        id: t.id,
        refundId: t.refundId,
        refundNumber: t.refund.refundNumber,
        orderId: t.refund.orderId,
        orderNumber: t.refund.order.orderNumber,
        customerId: t.customerId,
        customerName: `${t.customer.firstName || ''} ${t.customer.lastName || ''}`.trim(),
        customerPhone: t.customer.phone,
        walletProvider: t.walletProvider,
        walletNumber: t.walletNumberMasked, // Masked by default
        holderName: t.holderName,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        externalTransactionReference: t.externalTransactionReference,
        adminNote: t.adminNote,
        rejectionReason: t.rejectionReason,
        proofCount: t.proofs.length,
        proofs: t.proofs,
        assignedAdmin: t.assignedAdmin,
        verifiedByAdmin: t.verifiedByAdmin,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Secure, audited endpoint to unmask the destination wallet number for authorized financial admins.
   */
  static async getUnmaskedTransferDetails(transferId: string, adminUserId: string) {
    const transfer = await prisma.manualWalletTransferRequest.findUnique({
      where: { id: transferId },
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, phone: true, email: true },
        },
        refund: {
          include: {
            order: { select: { id: true, orderNumber: true, total: true } },
          },
        },
        proofs: true,
      },
    });

    if (!transfer) throw new AppError('طلب التحويل اليدوي غير موجود', 404);

    // Audit unmask access
    await prisma.auditLog.create({
      data: {
        userId: adminUserId,
        action: 'MANUAL_TRANSFER_UNMASK_WALLET',
        resource: 'manual_wallet_transfers',
        details: JSON.stringify({
          transferId: transfer.id,
          refundId: transfer.refundId,
          walletProvider: transfer.walletProvider,
        }),
      },
    });

    return {
      ...transfer,
      fullWalletNumber: transfer.walletNumberEncrypted || transfer.walletNumberMasked,
    };
  }

  /**
   * Upload and attach transfer proof (receipt image or PDF).
   */
  static async attachProof(params: {
    transferId: string;
    adminUserId: string;
    file: Express.Multer.File;
  }) {
    const { transferId, adminUserId, file } = params;

    const transfer = await prisma.manualWalletTransferRequest.findUnique({
      where: { id: transferId },
    });
    if (!transfer) throw new AppError('طلب التحويل اليدوي غير موجود', 404);

    if (transfer.status === ManualTransferStatus.COMPLETED) {
      throw new AppError('لا يمكن تعديل أو إرفاق إثباتات لطلب تحويل مكتمل نهائياً', 400);
    }

    // Validate MIME type
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedMimes.includes(file.mimetype)) {
      throw new AppError('نوع الملف غير مسموح به. يُسمح فقط بالصور (JPEG, PNG, WEBP) وملفات PDF', 400);
    }

    // Calculate SHA-256 hash for tamper proofing
    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // Upload to secure private storage
    const uploadResult = await storageService.uploadFile(file, 'refund-proofs');

    const proof = await prisma.$transaction(async (tx) => {
      const createdProof = await tx.transferProof.create({
        data: {
          transferId: transfer.id,
          fileUrl: uploadResult.url,
          fileType: file.mimetype,
          fileHash: hash,
          fileSize: file.size,
          uploadedBy: adminUserId,
        },
      });

      await tx.manualWalletTransferRequest.update({
        where: { id: transfer.id },
        data: {
          status: ManualTransferStatus.PROOF_SUBMITTED,
          assignedAdminId: adminUserId,
        },
      });

      return createdProof;
    });

    return proof;
  }

  /**
   * Completes the manual transfer after real-world payment, reference, and proof are verified.
   * Enforces Maker-Checker dual approval if configured.
   */
  static async completeTransfer(params: {
    transferId: string;
    adminUserId: string;
    externalTransactionReference: string;
    adminNote?: string;
  }) {
    const { transferId, adminUserId, externalTransactionReference, adminNote } = params;

    if (!externalTransactionReference || externalTransactionReference.trim().length < 4) {
      throw new AppError('رقم مرجع الحوالة / العملية المصرفية الخارجية إلزامي ومطلوب للتوثيق', 400);
    }

    const transfer = await prisma.manualWalletTransferRequest.findUnique({
      where: { id: transferId },
      include: {
        proofs: true,
        refund: {
          include: {
            order: true,
            executionLock: true,
          },
        },
      },
    });

    if (!transfer) throw new AppError('طلب التحويل غير موجود', 404);

    if (transfer.status === ManualTransferStatus.COMPLETED) {
      throw new AppError('تم تأكيد واكتمال هذا التحويل مسبقاً', 400);
    }

    // Critical validation: Proof must exist
    if (!transfer.proofs || transfer.proofs.length === 0) {
      throw new AppError(
        'لا يمكن إكمال التحويل بدون إرفاق إشعار التحويل البنكي/سند الإيداع الرسمي أولاً',
        400
      );
    }

    // Check Maker-Checker Dual Approval policy
    const policy = await prisma.refundPolicyConfig.findFirst();
    if (policy?.dualApprovalEnabled && transfer.amount >= policy.dualApprovalThresholdYER) {
      if (transfer.assignedAdminId === adminUserId) {
        throw new AppError(
          'نظام الرقابة الثنائية (Dual Approval) مفعل: المسؤول الذي قام بإدخال التحويل وإرفاق الإشعار لا يمكنه اعتماد الإكمال بنفسه. يجب التحقق والاعتماد بواسطة مسؤول مالي آخر.',
          403
        );
      }
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Acquire & Check Execution Lock
      const existingLock = await tx.refundExecutionLock.findUnique({
        where: { refundId: transfer.refundId },
      });

      if (existingLock && existingLock.status === 'COMPLETED') {
        throw new AppError(
          'تم تنفيذ المعاملة المالية لهذا الاسترجاع مسبقاً ولا يمكن تكرار التحويل',
          409
        );
      }

      await tx.refundExecutionLock.upsert({
        where: { refundId: transfer.refundId },
        create: {
          refundId: transfer.refundId,
          destination: RefundDestination.MANUAL_WALLET_TRANSFER,
          completedAt: new Date(),
          status: 'COMPLETED',
        },
        update: {
          destination: RefundDestination.MANUAL_WALLET_TRANSFER,
          completedAt: new Date(),
          status: 'COMPLETED',
        },
      });

      // 2. Mark Manual Transfer as COMPLETED
      const completedTransfer = await tx.manualWalletTransferRequest.update({
        where: { id: transfer.id },
        data: {
          status: ManualTransferStatus.COMPLETED,
          externalTransactionReference: externalTransactionReference.trim(),
          adminNote: adminNote || null,
          verifiedByAdminId: adminUserId,
          completedAt: new Date(),
        },
      });

      // 3. Mark RefundRequest as REFUND_COMPLETED
      await tx.refundRequest.update({
        where: { id: transfer.refundId },
        data: {
          status: RefundStatus.REFUND_COMPLETED,
          approvedAmount: transfer.amount,
          resolvedAt: new Date(),
        },
      });

      // 4. Record Refund Status History
      await tx.refundStatusHistory.create({
        data: {
          refundRequestId: transfer.refundId,
          fromStatus: RefundStatus.REFUND_PROCESSING,
          toStatus: RefundStatus.REFUND_COMPLETED,
          changedBy: adminUserId,
          actorType: 'ADMIN',
          reason: `اكتمال التحويل اليدوي إلى محفظة ${transfer.walletProvider} (مرجع: ${externalTransactionReference})`,
          metadata: JSON.stringify({
            transferId: transfer.id,
            externalTransactionReference,
            walletProvider: transfer.walletProvider,
          }),
        },
      });

      // 5. Audit Log
      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'MANUAL_WALLET_TRANSFER_COMPLETED',
          resource: 'manual_wallet_transfers',
          details: JSON.stringify({
            transferId: transfer.id,
            refundId: transfer.refundId,
            amount: transfer.amount,
            currency: transfer.currency,
            walletProvider: transfer.walletProvider,
            externalTransactionReference,
          }),
        },
      });

      // 6. Notify Customer
      await tx.notification.create({
        data: {
          userId: transfer.customerId,
          titleAr: 'تم إيداع مبلغ الاسترجاع في محفظتك',
          titleEn: 'Refund Transferred to Your Wallet',
          bodyAr: `تم تنفيذ التحويل المالي لمبلغ ${transfer.amount} ${transfer.currency} إلى محفظتك في [${transfer.walletProvider}] برقم مرجع: ${externalTransactionReference}`,
          bodyEn: `Refund amount ${transfer.amount} ${transfer.currency} transferred to your ${transfer.walletProvider} wallet. Ref: ${externalTransactionReference}`,
          type: NotificationType.REFUND_COMPLETED,
          data: JSON.stringify({ refundId: transfer.refundId, transferId: transfer.id }),
        },
      });

      return completedTransfer;
    });
  }

  /**
   * Rejects a manual transfer request (e.g. invalid wallet number, compliance issue).
   */
  static async rejectTransfer(params: {
    transferId: string;
    adminUserId: string;
    rejectionReason: string;
  }) {
    const { transferId, adminUserId, rejectionReason } = params;

    if (!rejectionReason || rejectionReason.trim().length < 5) {
      throw new AppError('سبب رفض التحويل إلزامي ومطلوب للتوثيق', 400);
    }

    const transfer = await prisma.manualWalletTransferRequest.findUnique({
      where: { id: transferId },
    });
    if (!transfer) throw new AppError('طلب التحويل غير موجود', 404);

    if (transfer.status === ManualTransferStatus.COMPLETED) {
      throw new AppError('لا يمكن رفض طلب تحويل تم اكتماله مسبقاً', 400);
    }

    return await prisma.$transaction(async (tx) => {
      const updated = await tx.manualWalletTransferRequest.update({
        where: { id: transferId },
        data: {
          status: ManualTransferStatus.REJECTED,
          rejectionReason,
          verifiedByAdminId: adminUserId,
        },
      });

      // Notify customer that transfer failed and requires updated wallet destination
      await tx.notification.create({
        data: {
          userId: transfer.customerId,
          titleAr: 'تعذر تنفيذ التحويل للمحفظة',
          titleEn: 'Wallet Transfer Rejected',
          bodyAr: `تعذر تنفيذ التحويل إلى محفظة ${transfer.walletProvider}. السبب: ${rejectionReason}. يرجى مراجعة خدمة العملاء.`,
          bodyEn: `Wallet transfer to ${transfer.walletProvider} failed: ${rejectionReason}`,
          type: NotificationType.REFUND_FAILED,
          data: JSON.stringify({ refundId: transfer.refundId, transferId: transfer.id }),
        },
      });

      return updated;
    });
  }
}
