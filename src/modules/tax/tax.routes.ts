/**
 * SOUQNAA Marketplace — Production-Grade Tax Engine API Routes
 * Endpoints for calculation, checkout validation, admin rule management,
 * exemptions, audit trails, and reporting.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate, optionalAuth, authorize } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { TaxEngine } from './tax.service';
import {
  CreateTaxRuleDto,
  UpdateTaxRuleDto,
  CreateTaxExemptionDto,
  UpdateTaxConfigDto,
} from './tax.types';

const publicRouter = Router();
const adminRouter = Router();

// ==========================================
// 1. PUBLIC & CUSTOMER CALCULATION ENDPOINTS
// ==========================================

/**
 * POST /api/v1/tax/calculate
 * Calculate authoritative tax breakdown for cart items, shipping, and fees.
 */
publicRouter.post('/calculate', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { items, shippingAmount, platformFee, paymentFee, sellerShippingAmounts, currency } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new AppError('يرجى تزويد قائمة عناصر السلة للحساب الضريبي', 400);
    }

    // Input sanitization and safety checks
    const sanitizedItems = items.map((item: any, idx: number) => {
      const unitPrice = Number(item.unitPrice);
      const quantity = Number(item.quantity) || 1;
      const discountAmount = Number(item.discountAmount) || 0;

      if (isNaN(unitPrice) || unitPrice < 0) {
        throw new AppError(`سعر غير صالح للعنصر في الموضع ${idx}`, 400);
      }
      if (quantity <= 0) {
        throw new AppError(`كمية غير صالحة للعنصر في الموضع ${idx}`, 400);
      }

      return {
        id: String(item.id || `item_${idx}`),
        productId: String(item.productId),
        variantId: item.variantId ? String(item.variantId) : null,
        sellerId: String(item.sellerId),
        categoryId: item.categoryId ? String(item.categoryId) : null,
        productNameAr: String(item.productNameAr || 'منتج'),
        productNameEn: String(item.productNameEn || 'Product'),
        unitPrice,
        quantity,
        discountAmount,
      };
    });

    const result = await TaxEngine.calculateCartTax({
      items: sanitizedItems,
      shippingAmount: Number(shippingAmount) || 0,
      platformFee: Number(platformFee) || 0,
      paymentFee: Number(paymentFee) || 0,
      sellerShippingAmounts,
      customerId: req.user?.userId,
      currency: currency || 'YER',
    });

    return ResponseUtil.success(res, result, 'تم احتساب الضرائب بنجاح');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/tax/validate
 * Server-side validation to verify client checkout calculation integrity
 */
publicRouter.post('/validate', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { items, shippingAmount, platformFee, paymentFee, clientTaxAmount, currency } = req.body;

    if (!items || !Array.isArray(items)) {
      throw new AppError('عناصر السلة مطلوبة للتحقق من الضريبة', 400);
    }

    const validation = await TaxEngine.validateTax(
      {
        items,
        shippingAmount,
        platformFee,
        paymentFee,
        customerId: req.user?.userId,
        currency,
      },
      clientTaxAmount !== undefined ? Number(clientTaxAmount) : undefined
    );

    return ResponseUtil.success(res, validation, 'تم فحص دقة الحساب الضريبي');
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tax/rules
 * Active rules list (public summary)
 */
publicRouter.get('/rules', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rules = await prisma.taxRule.findMany({
      where: { active: true, isArchived: false },
      select: {
        id: true,
        name: true,
        code: true,
        description: true,
        rate: true,
        calculationMethod: true,
        priceIncludesTax: true,
        appliesToProducts: true,
        appliesToShipping: true,
        appliesToPlatformFees: true,
        targetType: true,
        priority: true,
      },
      orderBy: { priority: 'asc' },
    });

    return ResponseUtil.success(res, rules);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tax/config
 * Public overview of tax configuration
 */
publicRouter.get('/config', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await TaxEngine.getEffectiveTaxConfiguration();
    return ResponseUtil.success(res, {
      taxEnabled: config.taxEnabled,
      taxInclusivePrices: config.taxInclusivePrices,
      taxOnShippingEnabled: config.taxOnShippingEnabled,
      defaultRate: config.defaultRate,
      currency: config.currency,
      discountTreatment: config.discountTreatment,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tax/orders/:id/snapshot
 * Retrieve immutable tax snapshot for a specific order
 */
publicRouter.get('/orders/:id/snapshot', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderId = String(req.params.id);

    // Authorization check
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true },
    });

    if (!order) {
      throw new AppError('الطلب غير موجود', 404);
    }

    if (order.userId !== req.user!.userId && req.user!.role !== 'ADMIN' && req.user!.role !== 'SELLER') {
      throw new AppError('غير مصرح لك بعرض بيانات هذا الطلب', 403);
    }

    const snapshotData = await TaxEngine.getOrderTaxSnapshot(orderId);
    return ResponseUtil.success(res, snapshotData);
  } catch (error) {
    next(error);
  }
});

// ==========================================
// 2. ADMIN TAX MANAGEMENT ENDPOINTS (ADMIN ONLY)
// ==========================================

/**
 * GET /api/v1/admin/tax/overview
 * Executive summary for admin tax dashboard
 */
adminRouter.get('/overview', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await TaxEngine.getEffectiveTaxConfiguration();
    const [activeRulesCount, exemptionsCount, totalSnapshots, recentAuditLogs] = await Promise.all([
      prisma.taxRule.count({ where: { active: true, isArchived: false } }),
      prisma.taxExemption.count({ where: { active: true } }),
      prisma.orderTaxSnapshot.aggregate({
        _sum: { taxAmount: true, taxableAmount: true },
        _count: true,
      }),
      prisma.taxAuditLog.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return ResponseUtil.success(res, {
      config,
      stats: {
        activeRulesCount,
        exemptionsCount,
        totalTaxCollected: totalSnapshots._sum.taxAmount || 0,
        totalTaxableVolume: totalSnapshots._sum.taxableAmount || 0,
        totalTaxSnapshots: totalSnapshots._count || 0,
      },
      recentAuditLogs,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/admin/tax/rules
 * List all rules including inactive and versioned rules
 */
adminRouter.get('/rules', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { includeArchived, targetType } = req.query;

    const where: any = {};
    if (includeArchived !== 'true') {
      where.isArchived = false;
    }
    if (targetType) {
      where.targetType = String(targetType);
    }

    const rules = await prisma.taxRule.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });

    return ResponseUtil.success(res, rules);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/admin/tax/rules/:id
 * Get single rule details with version history
 */
adminRouter.get('/rules/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ruleId = String(req.params.id);
    const rule = await prisma.taxRule.findUnique({
      where: { id: ruleId },
      include: {
        auditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!rule) {
      throw new AppError('القاعدة الضريبية غير موجودة', 404);
    }

    // Look for other versions
    const allVersions = await prisma.taxRule.findMany({
      where: {
        OR: [
          { id: rule.id },
          { parentRuleId: rule.parentRuleId || rule.id },
          { id: rule.parentRuleId || undefined },
        ],
      },
      orderBy: { version: 'desc' },
    });

    return ResponseUtil.success(res, { rule, versions: allVersions });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/admin/tax/rules
 * Create a new Tax Rule
 */
adminRouter.post('/rules', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: CreateTaxRuleDto = req.body;
    if (!dto.name || !dto.code || dto.rate === undefined) {
      throw new AppError('الاسم ورمز القاعدة ومعدل الضريبة حقول إلزامية', 400);
    }

    const rule = await TaxEngine.createTaxRule(dto, req.user!.userId, {
      ipAddress: String(req.ip || ''),
      userAgent: req.get('user-agent'),
    });

    return ResponseUtil.created(res, rule, 'تم إنشاء القاعدة الضريبية بنجاح');
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/admin/tax/rules/:id
 * Update rule (spawns new version if historical orders exist)
 */
adminRouter.put('/rules/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: UpdateTaxRuleDto = req.body;
    const ruleId = String(req.params.id);
    const rule = await TaxEngine.updateTaxRule(ruleId, dto, req.user!.userId, {
      ipAddress: String(req.ip || ''),
      userAgent: req.get('user-agent'),
    });

    return ResponseUtil.success(res, rule, 'تم تحديث القاعدة الضريبية بنجاح');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/admin/tax/rules/:id/activate
 */
adminRouter.post('/rules/:id/activate', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ruleId = String(req.params.id);
    const rule = await TaxEngine.activateTaxRule(ruleId, req.user!.userId, {
      ipAddress: String(req.ip || ''),
      userAgent: req.get('user-agent'),
    });
    return ResponseUtil.success(res, rule, 'تم تفعيل القاعدة الضريبية');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/admin/tax/rules/:id/deactivate
 */
adminRouter.post('/rules/:id/deactivate', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ruleId = String(req.params.id);
    const rule = await TaxEngine.deactivateTaxRule(ruleId, req.user!.userId, {
      ipAddress: String(req.ip || ''),
      userAgent: req.get('user-agent'),
    });
    return ResponseUtil.success(res, rule, 'تم تعطيل القاعدة الضريبية');
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/admin/tax/rules/:id
 */
adminRouter.delete('/rules/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ruleId = String(req.params.id);
    await TaxEngine.deleteTaxRule(ruleId, req.user!.userId, {
      ipAddress: String(req.ip || ''),
      userAgent: req.get('user-agent'),
    });
    return ResponseUtil.success(res, null, 'تمت معالجة القاعدة الضريبية بنجاح');
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/admin/tax/exemptions
 */
adminRouter.get('/exemptions', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const exemptions = await prisma.taxExemption.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return ResponseUtil.success(res, exemptions);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/admin/tax/exemptions
 */
adminRouter.post('/exemptions', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: CreateTaxExemptionDto = req.body;
    if (!dto.entityType || !dto.entityId || !dto.reason) {
      throw new AppError('نوع الكيان، ومعرف الكيان، وسبب الإعفاء حقول مطلوبة', 400);
    }

    const exemption = await TaxEngine.createTaxExemption(dto, req.user!.userId, {
      ipAddress: String(req.ip || ''),
      userAgent: req.get('user-agent'),
    });

    return ResponseUtil.created(res, exemption, 'تم إنشاء الإعفاء الضريبي بنجاح');
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/admin/tax/exemptions/:id
 */
adminRouter.delete('/exemptions/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const exemptionId = String(req.params.id);
    await TaxEngine.removeTaxExemption(exemptionId, req.user!.userId, {
      ipAddress: String(req.ip || ''),
      userAgent: req.get('user-agent'),
    });
    return ResponseUtil.success(res, null, 'تم حذف الإعفاء الضريبي');
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/admin/tax/audit-logs
 */
adminRouter.get('/audit-logs', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10)));
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.taxAuditLog.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          taxRule: { select: { id: true, name: true, code: true } },
          taxExemption: { select: { id: true, entityType: true, reason: true } },
        },
      }),
      prisma.taxAuditLog.count(),
    ]);

    return ResponseUtil.paginated(res, logs, page, limit, total);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/admin/tax/reports
 */
adminRouter.get('/reports', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate, sellerId } = req.query;
    const reports = await TaxEngine.getTaxReports({
      startDate: startDate ? String(startDate) : undefined,
      endDate: endDate ? String(endDate) : undefined,
      sellerId: sellerId ? String(sellerId) : undefined,
    });
    return ResponseUtil.success(res, reports);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/admin/tax/reports/export
 * Download tax report as standard CSV spreadsheet
 */
adminRouter.get(
  '/reports/export',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate, sellerId } = req.query;
      const reports = await TaxEngine.getTaxReports({
        startDate: startDate ? String(startDate) : undefined,
        endDate: endDate ? String(endDate) : undefined,
        sellerId: sellerId ? String(sellerId) : undefined,
      });

      const lines: string[] = [];
      // UTF-8 BOM for Microsoft Excel Arabic support
      lines.push('\uFEFF');

      // Section 1: Title & Header
      lines.push('تقرير الضرائب والمحاسبة المالية لمنصة سوقناا');
      lines.push(`تاريخ الاستخراج,${new Date().toISOString()}`);
      lines.push(`الفترة الزمنية,${reports.period.startDate || 'البداية'} إلى ${reports.period.endDate || 'الآن'}`);
      lines.push('');

      // Section 2: Financial KPIs
      lines.push('المؤشرات المالية الكلية,القيمة بالريال (YER)');
      lines.push(`إجمالي القيمة الخاضعة للضريبة,${reports.summary.totalTaxableVolume.toFixed(2)}`);
      lines.push(`إجمالي الضرائب المحصلة (Gross Tax),${reports.summary.totalGrossTax.toFixed(2)}`);
      lines.push(`الضرائب المسترجعة (Refunds),${reports.summary.totalRefundedTax.toFixed(2)}`);
      lines.push(`صافي الالتزام الضريبي (Net Tax),${reports.summary.netTaxCollected.toFixed(2)}`);
      lines.push(`إجمالي المعاملات الضريبية,${reports.summary.totalTransactions}`);
      lines.push('');

      // Section 3: Seller Summary Breakdown
      lines.push('تفاصيل الضرائب المحصلة لكل بائع');
      lines.push('معرف البائع,عدد الطلبات,حجم المبيعات الخاضع للضريبة (YER),الضريبة المحصلة (أمانات المنصة) (YER)');
      for (const s of reports.sellerSummary) {
        lines.push(`"${s.sellerId}",${s.orderCount},${s.taxableVolume.toFixed(2)},${s.taxCollected.toFixed(2)}`);
      }
      lines.push('');

      // Section 4: Rule Summary Breakdown
      lines.push('تفاصيل الضرائب حسب القواعد الضريبية');
      lines.push('اسم القاعدة الضريبية,نسبة الضريبة (%),إجمالي الضريبة المحصلة (YER),عدد العمليات');
      for (const r of reports.ruleSummary) {
        const pct = (r.taxRate * 100).toFixed(1);
        lines.push(`"${r.taxName}",${pct}%,${r.totalTax.toFixed(2)},${r.count}`);
      }

      const csvContent = lines.join('\r\n');
      const filename = `souqnaa-tax-report-${new Date().toISOString().slice(0, 10)}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(csvContent);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/admin/tax/config
 */
adminRouter.get('/config', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await TaxEngine.getEffectiveTaxConfiguration();
    return ResponseUtil.success(res, config);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/admin/tax/config
 */
adminRouter.put('/config', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: UpdateTaxConfigDto = req.body;
    const updated = await TaxEngine.updateTaxConfiguration(dto, req.user!.userId, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return ResponseUtil.success(res, updated, 'تم تحديث إعدادات النظام الضريبي');
  } catch (error) {
    next(error);
  }
});

// Mount adminRouter on publicRouter at '/admin' as well for seamless compatibility with /api/v1/tax/admin/*
publicRouter.use('/admin', adminRouter);

export { publicRouter as taxRoutes, adminRouter as taxAdminRoutes };
export default publicRouter;
