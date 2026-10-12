/**
 * SOUQNAA Marketplace — Financial Statements Engine Routes
 * Implements strict role-based endpoints for:
 * - Seller Statements (SELLER_STATEMENT)
 * - Settlement Statements (SETTLEMENT_STATEMENT)
 * - Commission Statements (COMMISSION_STATEMENT)
 * - Tax Statements (TAX_STATEMENT)
 * Customers are strictly blocked with 403 Forbidden.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { requireSeller, requireAdmin } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { StatementType, StatementPeriodType, StatementAuditAction, StatementStatus } from '@prisma/client';
import { SellerStatementService } from './seller-statement.service';
import { SettlementStatementService } from './settlement-statement.service';
import { CommissionStatementService } from './commission-statement.service';
import { TaxStatementService } from './tax-statement.service';
import { StatementAccessService } from './statement-access.service';
import { StatementSnapshotService } from './statement-snapshot.service';
import { StatementPdfService } from './statement-pdf.service';
import { StatementExportService } from './statement-export.service';
import { StatementAuditService } from './statement-audit.service';
import { SettlementEngine } from '../settlement/settlement.service';

export const sellerStatementsRouter = Router();
export const adminStatementsRouter = Router();

// Helper to resolve seller ID for authenticated user
async function resolveSellerId(userId: string): Promise<string> {
  const seller = await prisma.seller.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!seller) throw new AppError('حساب البائع غير موجود', 404);
  return seller.id;
}

// ============================================================================
// 1. SELLER ROUTES (Mounted under /api/v1/seller)
// ============================================================================

sellerStatementsRouter.use(authenticate, requireSeller);

// ── SELLER_STATEMENT Endpoints ──────────────────────────────────────────────

// GET /api/v1/seller/statements
sellerStatementsRouter.get('/statements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req.user!.userId);
    const { statementNumber, status, dateFrom, dateTo, page, limit } = req.query;

    const result = await SellerStatementService.listStatements({
      sellerId,
      statementNumber: statementNumber ? String(statementNumber) : undefined,
      status: status ? (String(status) as StatementStatus) : undefined,
      dateFrom: dateFrom ? new Date(String(dateFrom)) : undefined,
      dateTo: dateTo ? new Date(String(dateTo)) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 20,
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/seller/statements/generate
sellerStatementsRouter.post('/statements/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req.user!.userId);
    const { periodType, referenceDate, customStart, customEnd } = req.body;

    const result = await SellerStatementService.generateStatement({
      sellerId,
      periodType: periodType ? (periodType as StatementPeriodType) : undefined,
      referenceDate: referenceDate ? new Date(referenceDate) : undefined,
      customStart: customStart ? new Date(customStart) : undefined,
      customEnd: customEnd ? new Date(customEnd) : undefined,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      autoFinalize: true,
    });

    ResponseUtil.created(res, result, 'تم إنشاء وتجميد كشف حساب البائع بنجاح');
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/statements/:id
sellerStatementsRouter.get('/statements/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);
    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statementId
    );

    const result = await SellerStatementService.getStatementById(statementId);

    await StatementAuditService.log({
      statementId,
      statementType: StatementType.SELLER_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_VIEWED,
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/statements/:id/pdf
sellerStatementsRouter.get('/statements/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);
    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statementId
    );

    const { snapshot } = await SellerStatementService.getStatementById(statementId);
    if (!snapshot) {
      throw new AppError('الكشف المالي غير معتمد أو لا يحتوي على لقطة مجمدة', 400);
    }

    await StatementAuditService.log({
      statementId,
      statementType: StatementType.SELLER_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_DOWNLOADED,
    });

    const exportUrl = `/api/v1/seller/statements/${statementId}/export?token=${encodeURIComponent(String(req.query.token || ''))}`;
    const autoPrint = req.query.autoPrint === 'true';
    const html = await StatementPdfService.renderStatementHtml(snapshot, { autoPrint, exportUrl });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/statements/:id/export
sellerStatementsRouter.get('/statements/:id/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);
    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statementId
    );

    const { snapshot } = await SellerStatementService.getStatementById(statementId);
    if (!snapshot) {
      throw new AppError('الكشف المالي غير معتمد بعد للتصدير', 400);
    }

    await StatementAuditService.log({
      statementId,
      statementType: StatementType.SELLER_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_EXPORTED,
    });

    const csv = StatementExportService.generateCsv(snapshot);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.statementNumber}.csv"`);
    return res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ── SETTLEMENT_STATEMENT Endpoints ──────────────────────────────────────────

// GET /api/v1/seller/settlements
sellerStatementsRouter.get('/settlements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req.user!.userId);
    const { status, page, limit } = req.query;

    const result = await SettlementEngine.listSettlements({
      sellerId,
      status: status ? (String(status) as any) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 20,
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/settlements/:id/statement
sellerStatementsRouter.get('/settlements/:id/statement', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settlementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);

    const generated = await SettlementStatementService.generateStatement({
      settlementId,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      autoFinalize: true,
    });

    if (!generated.statement) {
      throw new AppError('فشل إنشاء كشف التسوية', 500);
    }

    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      generated.statement
    );

    await StatementAuditService.log({
      statementId: generated.statement.id,
      statementType: StatementType.SETTLEMENT_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_VIEWED,
    });

    ResponseUtil.success(res, generated);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/settlements/:id/statement/pdf
sellerStatementsRouter.get('/settlements/:id/statement/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settlementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);

    const { statement, snapshot } = await SettlementStatementService.getStatementByIdOrSettlementId(settlementId);

    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statement
    );

    if (!snapshot) {
      throw new AppError('كشف التسوية لا يحتوي على لقطة مجمدة', 400);
    }

    await StatementAuditService.log({
      statementId: statement.id,
      statementType: StatementType.SETTLEMENT_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_DOWNLOADED,
    });

    const html = await StatementPdfService.renderStatementHtml(snapshot);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/settlement-statements
sellerStatementsRouter.get('/settlement-statements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req.user!.userId);
    const { statementNumber, status, page, limit } = req.query;

    const result = await SettlementStatementService.listStatements({
      sellerId,
      statementNumber: statementNumber ? String(statementNumber) : undefined,
      status: status ? (String(status) as StatementStatus) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 20,
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/seller/settlement-statements/generate
sellerStatementsRouter.post('/settlement-statements/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req.user!.userId);
    const { periodType, customStart, customEnd, settlementId } = req.body;

    let targetSettlementId = settlementId ? String(settlementId) : undefined;
    if (!targetSettlementId) {
      const latestSettlement = await prisma.settlement.findFirst({
        where: { sellerId },
        orderBy: { createdAt: 'desc' },
      });

      if (latestSettlement) {
        targetSettlementId = latestSettlement.id;
      } else {
        const now = new Date();
        const start = customStart ? new Date(customStart) : new Date(now.getTime() - 30 * 24 * 3600 * 1000);
        const end = customEnd ? new Date(customEnd) : now;
        const newSettlement = await SettlementEngine.createSettlement({
          sellerId,
          periodStart: start,
          periodEnd: end,
          notes: 'تسوية دورية تم إنشاؤها آلياً لتوليد كشف التسوية المعتمد',
        });
        targetSettlementId = newSettlement.id;
      }
    }

    const result = await SettlementStatementService.generateStatement({
      settlementId: String(targetSettlementId),
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      autoFinalize: true,
    });

    ResponseUtil.created(res, result, 'تم إنشاء وتجميد كشف التسوية المالية بنجاح');
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/settlement-statements/:id
sellerStatementsRouter.get('/settlement-statements/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);

    const { statement, snapshot } = await SettlementStatementService.getStatementByIdOrSettlementId(statementId);

    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statement
    );

    await StatementAuditService.log({
      statementId: statement.id,
      statementType: StatementType.SETTLEMENT_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_VIEWED,
    });

    ResponseUtil.success(res, { statement, snapshot });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/settlement-statements/:id/pdf
sellerStatementsRouter.get('/settlement-statements/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);

    const { statement, snapshot } = await SettlementStatementService.getStatementByIdOrSettlementId(statementId);

    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statement
    );

    if (!snapshot) {
      throw new AppError('كشف التسوية لا يحتوي على لقطة مجمدة', 400);
    }

    await StatementAuditService.log({
      statementId: statement.id,
      statementType: StatementType.SETTLEMENT_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_DOWNLOADED,
    });

    const exportUrl = `/api/v1/seller/settlement-statements/${statement.id}/export?token=${encodeURIComponent(String(req.query.token || ''))}`;
    const autoPrint = req.query.autoPrint === 'true';
    const html = await StatementPdfService.renderStatementHtml(snapshot, { autoPrint, exportUrl });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/settlement-statements/:id/export
sellerStatementsRouter.get('/settlement-statements/:id/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);

    const { statement, snapshot } = await SettlementStatementService.getStatementByIdOrSettlementId(statementId);

    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statement
    );

    if (!snapshot) {
      throw new AppError('كشف التسوية لا يحتوي على لقطة مجمدة', 400);
    }

    await StatementAuditService.log({
      statementId: statement.id,
      statementType: StatementType.SETTLEMENT_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_EXPORTED,
    });

    const csv = StatementExportService.generateCsv(snapshot);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.statementNumber}.csv"`);
    return res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ── COMMISSION_STATEMENT Endpoints ──────────────────────────────────────────

// GET /api/v1/seller/commission-statements
sellerStatementsRouter.get('/commission-statements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req.user!.userId);
    const { statementNumber, status, page, limit } = req.query;

    const result = await CommissionStatementService.listStatements({
      sellerId,
      statementNumber: statementNumber ? String(statementNumber) : undefined,
      status: status ? (String(status) as StatementStatus) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 20,
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/seller/commission-statements/generate
sellerStatementsRouter.post('/commission-statements/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req.user!.userId);
    const { periodType, referenceDate, customStart, customEnd } = req.body;

    const result = await CommissionStatementService.generateStatement({
      sellerId,
      periodType: periodType ? (periodType as StatementPeriodType) : undefined,
      referenceDate: referenceDate ? new Date(referenceDate) : undefined,
      customStart: customStart ? new Date(customStart) : undefined,
      customEnd: customEnd ? new Date(customEnd) : undefined,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      autoFinalize: true,
    });

    ResponseUtil.created(res, result, 'تم إنشاء وتجميد كشف العمولات بنجاح');
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/commission-statements/:id
sellerStatementsRouter.get('/commission-statements/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);
    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statementId
    );

    const result = await CommissionStatementService.getStatementById(statementId);

    await StatementAuditService.log({
      statementId,
      statementType: StatementType.COMMISSION_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_VIEWED,
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/commission-statements/:id/pdf
sellerStatementsRouter.get('/commission-statements/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);
    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statementId
    );

    const { snapshot } = await CommissionStatementService.getStatementById(statementId);
    if (!snapshot) {
      throw new AppError('الكشف المالي غير معتمد أو لا يحتوي على لقطة مجمدة', 400);
    }

    await StatementAuditService.log({
      statementId,
      statementType: StatementType.COMMISSION_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_DOWNLOADED,
    });

    const exportUrl = `/api/v1/seller/commission-statements/${statementId}/export?token=${encodeURIComponent(String(req.query.token || ''))}`;
    const autoPrint = req.query.autoPrint === 'true';
    const html = await StatementPdfService.renderStatementHtml(snapshot, { autoPrint, exportUrl });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/commission-statements/:id/export
sellerStatementsRouter.get('/commission-statements/:id/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);
    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statementId
    );

    const { snapshot } = await CommissionStatementService.getStatementById(statementId);
    if (!snapshot) {
      throw new AppError('الكشف المالي غير معتمد بعد للتصدير', 400);
    }

    await StatementAuditService.log({
      statementId,
      statementType: StatementType.COMMISSION_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_EXPORTED,
    });

    const csv = StatementExportService.generateCsv(snapshot);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.statementNumber}.csv"`);
    return res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ── TAX_STATEMENT Endpoints ─────────────────────────────────────────────────

// GET /api/v1/seller/tax-statements
sellerStatementsRouter.get('/tax-statements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req.user!.userId);
    const { statementNumber, status, page, limit } = req.query;

    const result = await TaxStatementService.listStatements({
      sellerId,
      statementNumber: statementNumber ? String(statementNumber) : undefined,
      status: status ? (String(status) as StatementStatus) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 20,
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/seller/tax-statements/generate
sellerStatementsRouter.post('/tax-statements/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req.user!.userId);
    const { periodType, referenceDate, customStart, customEnd } = req.body;

    const result = await TaxStatementService.generateStatement({
      sellerId,
      periodType: periodType ? (periodType as StatementPeriodType) : undefined,
      referenceDate: referenceDate ? new Date(referenceDate) : undefined,
      customStart: customStart ? new Date(customStart) : undefined,
      customEnd: customEnd ? new Date(customEnd) : undefined,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      autoFinalize: true,
    });

    ResponseUtil.created(res, result, 'تم إنشاء وتجميد كشف الإقرار الضريبي بنجاح');
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/tax-statements/:id
sellerStatementsRouter.get('/tax-statements/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);
    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statementId
    );

    const result = await TaxStatementService.getStatementById(statementId);

    await StatementAuditService.log({
      statementId,
      statementType: StatementType.TAX_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_VIEWED,
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/tax-statements/:id/pdf
sellerStatementsRouter.get('/tax-statements/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);
    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statementId
    );

    const { snapshot } = await TaxStatementService.getStatementById(statementId);
    if (!snapshot) {
      throw new AppError('الكشف المالي غير معتمد أو لا يحتوي على لقطة مجمدة', 400);
    }

    await StatementAuditService.log({
      statementId,
      statementType: StatementType.TAX_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_DOWNLOADED,
    });

    const exportUrl = `/api/v1/seller/tax-statements/${statementId}/export?token=${encodeURIComponent(String(req.query.token || ''))}`;
    const autoPrint = req.query.autoPrint === 'true';
    const html = await StatementPdfService.renderStatementHtml(snapshot, { autoPrint, exportUrl });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/seller/tax-statements/:id/export
sellerStatementsRouter.get('/tax-statements/:id/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const sellerId = await resolveSellerId(req.user!.userId);
    await StatementAccessService.assertCanAccessStatement(
      { userId: req.user!.userId, role: req.user!.role, sellerId },
      statementId
    );

    const { snapshot } = await TaxStatementService.getStatementById(statementId);
    if (!snapshot) {
      throw new AppError('الكشف المالي غير معتمد بعد للتصدير', 400);
    }

    await StatementAuditService.log({
      statementId,
      statementType: StatementType.TAX_STATEMENT,
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      action: StatementAuditAction.STATEMENT_EXPORTED,
    });

    const csv = StatementExportService.generateCsv(snapshot);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.statementNumber}.csv"`);
    return res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 2. ADMIN ROUTES (Mounted under /api/v1/admin)
// ============================================================================

adminStatementsRouter.use(authenticate, requireAdmin);

// GET /api/v1/admin/statements
adminStatementsRouter.get('/statements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sellerId, statementType, status, statementNumber, search, page, limit } = req.query;

    const where: any = {};
    if (sellerId) where.sellerId = String(sellerId);
    if (statementType) where.statementType = String(statementType) as StatementType;
    if (status) where.status = String(status) as any;

    const rawQuery = String(search || statementNumber || '').trim();
    if (rawQuery) {
      const orConditions: any[] = [
        { statementNumber: { contains: rawQuery, mode: 'insensitive' } },
        { settlement: { settlementNumber: { contains: rawQuery, mode: 'insensitive' } } },
        {
          seller: {
            stores: {
              some: {
                name: { contains: rawQuery, mode: 'insensitive' },
              },
            },
          },
        },
        {
          seller: {
            user: {
              OR: [
                { firstName: { contains: rawQuery, mode: 'insensitive' } },
                { lastName: { contains: rawQuery, mode: 'insensitive' } },
                { email: { contains: rawQuery, mode: 'insensitive' } },
                { phone: { contains: rawQuery, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];

      const qLower = rawQuery.toLowerCase();
      const typeMatches: StatementType[] = [];
      if (rawQuery.includes('تسوي') || qLower.includes('settle')) typeMatches.push(StatementType.SETTLEMENT_STATEMENT);
      if (rawQuery.includes('عمول') || qLower.includes('commiss')) typeMatches.push(StatementType.COMMISSION_STATEMENT);
      if (rawQuery.includes('ضريب') || qLower.includes('tax')) typeMatches.push(StatementType.TAX_STATEMENT);
      if (rawQuery.includes('تاجر') || rawQuery.includes('بائع') || qLower.includes('seller')) typeMatches.push(StatementType.SELLER_STATEMENT);

      if (typeMatches.length > 0) {
        orConditions.push({ statementType: { in: typeMatches } });
      }

      where.OR = orConditions;
    }

    const pageNum = page ? parseInt(String(page), 10) : 1;
    const limitNum = limit ? parseInt(String(limit), 10) : 20;

    const [total, statements] = await Promise.all([
      prisma.financialStatement.count({ where }),
      prisma.financialStatement.findMany({
        where,
        include: {
          snapshot: true,
          seller: { select: { id: true, stores: { select: { name: true } } } },
          settlement: { select: { settlementNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ]);

    ResponseUtil.success(res, {
      statements,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/admin/statements/generate
adminStatementsRouter.post('/statements/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sellerId, statementType, periodType, referenceDate, customStart, customEnd, settlementId } = req.body;

    if (!sellerId) throw new AppError('معرف التاجر مطلوب لإنشاء الكشف المالي', 400);
    if (!statementType) throw new AppError('نوع الكشف المالي مطلوب', 400);

    let result: any;
    if (statementType === StatementType.SELLER_STATEMENT) {
      result = await SellerStatementService.generateStatement({
        sellerId: String(sellerId),
        periodType: periodType ? (periodType as StatementPeriodType) : undefined,
        referenceDate: referenceDate ? new Date(referenceDate) : undefined,
        customStart: customStart ? new Date(customStart) : undefined,
        customEnd: customEnd ? new Date(customEnd) : undefined,
        actorId: req.user!.userId,
        actorRole: 'ADMIN',
        autoFinalize: true,
      });
    } else if (statementType === StatementType.SETTLEMENT_STATEMENT) {
      if (!settlementId) throw new AppError('معرف التسوية مطلوب', 400);
      result = await SettlementStatementService.generateStatement({
        settlementId: String(settlementId),
        actorId: req.user!.userId,
        actorRole: 'ADMIN',
        autoFinalize: true,
      });
    } else if (statementType === StatementType.COMMISSION_STATEMENT) {
      result = await CommissionStatementService.generateStatement({
        sellerId: String(sellerId),
        periodType: periodType ? (periodType as StatementPeriodType) : undefined,
        referenceDate: referenceDate ? new Date(referenceDate) : undefined,
        customStart: customStart ? new Date(customStart) : undefined,
        customEnd: customEnd ? new Date(customEnd) : undefined,
        actorId: req.user!.userId,
        actorRole: 'ADMIN',
        autoFinalize: true,
      });
    } else if (statementType === StatementType.TAX_STATEMENT) {
      result = await TaxStatementService.generateStatement({
        sellerId: String(sellerId),
        periodType: periodType ? (periodType as StatementPeriodType) : undefined,
        referenceDate: referenceDate ? new Date(referenceDate) : undefined,
        customStart: customStart ? new Date(customStart) : undefined,
        customEnd: customEnd ? new Date(customEnd) : undefined,
        actorId: req.user!.userId,
        actorRole: 'ADMIN',
        autoFinalize: true,
      });
    } else {
      throw new AppError(`نوع الكشف المالي غير مدعوم: ${statementType}`, 400);
    }

    ResponseUtil.created(res, result, 'تم إنشاء وتجميد الكشف المالي بنجاح من قبل الإدارة');
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/statements/:id
adminStatementsRouter.get('/statements/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    const statement = await prisma.financialStatement.findUnique({
      where: { id: statementId },
      include: {
        snapshot: true,
        lines: { orderBy: { lineIndex: 'asc' } },
        auditLogs: { orderBy: { createdAt: 'desc' } },
        seller: {
          include: {
            stores: true,
            user: { select: { firstName: true, lastName: true, email: true, phone: true } },
          },
        },
        settlement: true,
      },
    });

    if (!statement) {
      throw new AppError('الكشف المالي غير موجود', 404);
    }

    const snapshot = statement.snapshot
      ? await StatementSnapshotService.getSnapshot(statement.id)
      : null;

    await StatementAuditService.log({
      statementId: statement.id,
      statementType: statement.statementType,
      actorId: req.user!.userId,
      actorRole: 'ADMIN',
      action: StatementAuditAction.STATEMENT_VIEWED,
    });

    ResponseUtil.success(res, { statement, snapshot });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/statements/:id/pdf
adminStatementsRouter.get('/statements/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    let snapshot = await StatementSnapshotService.getSnapshot(statementId);
    if (!snapshot) {
      const statement = await prisma.financialStatement.findUnique({
        where: { id: statementId },
        include: {
          lines: { orderBy: { lineIndex: 'asc' } },
          seller: {
            include: {
              stores: true,
              user: { select: { firstName: true, lastName: true, email: true, phone: true } },
            },
          },
        },
      });
      if (!statement) {
        throw new AppError('الكشف المالي غير موجود', 404);
      }
      snapshot = StatementSnapshotService.buildFallbackSnapshot(statement);
    }

    await StatementAuditService.log({
      statementId,
      statementType: snapshot.statementType,
      actorId: req.user!.userId,
      actorRole: 'ADMIN',
      action: StatementAuditAction.STATEMENT_DOWNLOADED,
    });

    const exportUrl = `/api/v1/admin/statements/${statementId}/export?token=${encodeURIComponent(String(req.query.token || ''))}`;
    const autoPrint = req.query.autoPrint === 'true';
    const html = await StatementPdfService.renderStatementHtml(snapshot, { autoPrint, exportUrl });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/statements/:id/export
adminStatementsRouter.get('/statements/:id/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statementId = String(req.params.id);
    let snapshot = await StatementSnapshotService.getSnapshot(statementId);
    if (!snapshot) {
      const statement = await prisma.financialStatement.findUnique({
        where: { id: statementId },
        include: {
          lines: { orderBy: { lineIndex: 'asc' } },
          seller: {
            include: {
              stores: true,
              user: { select: { firstName: true, lastName: true, email: true, phone: true } },
            },
          },
        },
      });
      if (!statement) {
        throw new AppError('الكشف المالي غير معتمد بعد للتصدير', 404);
      }
      snapshot = StatementSnapshotService.buildFallbackSnapshot(statement);
    }

    await StatementAuditService.log({
      statementId,
      statementType: snapshot.statementType,
      actorId: req.user!.userId,
      actorRole: 'ADMIN',
      action: StatementAuditAction.STATEMENT_EXPORTED,
    });

    const csv = StatementExportService.generateCsv(snapshot);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.statementNumber}.csv"`);
    return res.send(csv);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/statement-audit
adminStatementsRouter.get('/statement-audit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { statementType, action, actorId, page, limit } = req.query;

    const result = await StatementAuditService.listAdminAuditLogs({
      statementType: statementType ? (String(statementType) as StatementType) : undefined,
      action: action ? (String(action) as StatementAuditAction) : undefined,
      actorId: actorId ? String(actorId) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 50,
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});
