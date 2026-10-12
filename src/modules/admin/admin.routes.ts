import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin, requirePermission } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import bcrypt from 'bcryptjs';
import {
  SellerStatus,
  DisputeStatus,
  WithdrawalStatus,
  OrderStatus,
  SellerOrderStatus,
  PaymentStatus,
  CancellationRequestStatus,
  ReturnRequestStatus,
  DeliveryZoneType,
  RefundStatus,
  RefundActorType,
  NotificationType,
} from '@prisma/client';
import { OrderStateMachine } from '../orders/order.state-machine';
import { SocketService } from '../../services/websocket/socket.service';
import { CustomerWalletService } from '../wallet/customer-wallet.service';
import { OrderInvoiceService } from '../../services/orders/order-invoice.service';
import { redis } from '../../database/redis';
import { config } from '../../config';

import { adminDeliveryRoutes } from './delivery-zones.routes';
import { adminDeliveryScheduleRoutes } from './delivery-schedule.routes';
import { adminUsersRoutes } from './admin-users.routes';
import { notificationScheduler } from '../notifications/services/notification-scheduler';
import { notificationEventBus } from '../notifications/services/event-bus';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { setMaintenanceConfig } from '../../middleware/maintenance.middleware';
import { SellerFinancialRiskService } from '../commission/seller-financial-risk.service';
import { AdminRbacService, SYSTEM_PERMISSIONS } from './admin-rbac.service';

const router = Router();
router.use(authenticate, requireAdmin);

// Mount administrator management routes (admins CRUD, roles, activation, sessions, audit)
router.use('/users', adminUsersRoutes);

// Mount delivery-specific distance zones & settings admin routes
router.use('/delivery', adminDeliveryRoutes);
// Mount delivery scheduling admin routes (time slots, rules, capacity)
router.use('/delivery', adminDeliveryScheduleRoutes);

// Helper for audit logging
async function logAdminAction(
  userId: string | undefined,
  action: string,
  resource: string,
  details?: Record<string, any>,
  req?: Request
) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        resource,
        ipAddress: req?.ip || req?.socket?.remoteAddress || null,
        userAgent: req?.headers['user-agent'] || null,
        details: details ? JSON.stringify(details) : null,
      },
    });
  } catch (e) {
    console.error('Failed to create audit log:', e);
  }
}

// ==============================================================================
// 1. DASHBOARD & ANALYTICS AGGREGATIONS
// ==============================================================================
router.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dbStart = Date.now();
    let dbStatus = 'healthy';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'unhealthy';
    }
    const dbLatencyMs = Date.now() - dbStart;
    const redisHealth = await redis.ping();

    const [
      totalUsers,
      totalSellers,
      pendingSellers,
      totalStores,
      totalProducts,
      inactiveProducts,
      totalOrders,
      totalRevenueResult,
      totalCommissionResult,
      pendingDisputes,
      pendingWithdrawals,
      pendingCustomerWithdrawals,
      totalWithdrawnResult,
      pendingDeposits,
      totalApprovedDepositsResult,
      totalOutstandingResult,
      openOutstandingsCount,
      restrictedSellersCount,
      activeCampaigns,
      totalCampaigns,
      activeBanners,
      recentOrders,
      recentDeposits,
      recentWithdrawals,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.seller.count({ where: { status: SellerStatus.ACTIVE } }),
      prisma.seller.count({ where: { status: SellerStatus.PENDING_VERIFICATION } }),
      prisma.store.count({ where: { isActive: true } }),
      prisma.product.count(),
      prisma.product.count({ where: { isActive: false } }),
      prisma.order.count(),
      prisma.order.aggregate({ _sum: { total: true } }),
      prisma.sellerOrder.aggregate({ _sum: { commissionAmount: true } }),
      prisma.dispute.count({ where: { status: DisputeStatus.OPEN } }),
      prisma.withdrawal.count({ where: { status: WithdrawalStatus.PENDING } }),
      prisma.customerWalletWithdrawal.count({ where: { status: 'PENDING' } }).catch(() => 0),
      prisma.withdrawal.aggregate({ where: { status: WithdrawalStatus.COMPLETED }, _sum: { amount: true } }),
      prisma.walletDeposit.count({ where: { status: 'PENDING' } }).catch(() => 0),
      prisma.walletDeposit.aggregate({ where: { status: 'APPROVED' }, _sum: { amount: true } }).catch(() => ({ _sum: { amount: 0 } })),
      prisma.sellerOutstanding.aggregate({
        where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
        _sum: { remainingAmount: true },
      }).catch(() => ({ _sum: { remainingAmount: 0 } })),
      prisma.sellerOutstanding.count({
        where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
      }).catch(() => 0),
      prisma.seller.count({
        where: {
          OR: [
            { isFinanciallyRestricted: true },
            { financialRestrictionLevel: { in: ['WARNING', 'CRITICAL', 'RESTRICTED'] } },
          ],
        },
      }).catch(() => 0),
      prisma.campaign.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
      prisma.campaign.count().catch(() => 0),
      prisma.banner.count({ where: { isActive: true } }).catch(() => 0),
      prisma.order.findMany({
        take: 8,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { firstName: true, lastName: true, phone: true } },
          sellerOrders: { select: { id: true, status: true, subtotal: true } },
        },
      }),
      prisma.walletDeposit.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { firstName: true, lastName: true, phone: true } },
        },
      }).catch(() => []),
      prisma.withdrawal.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          seller: {
            include: {
              stores: { select: { name: true } },
              user: { select: { firstName: true, lastName: true, phone: true } },
            },
          },
        },
      }).catch(() => []),
    ]);

    ResponseUtil.success(res, {
      kpis: {
        totalUsers,
        totalSellers,
        pendingSellers,
        totalStores,
        totalProducts,
        pendingProducts: inactiveProducts,
        totalOrders,
        totalRevenue: totalRevenueResult._sum.total || 0,
        totalCommission: totalCommissionResult._sum.commissionAmount || 0,
        pendingDisputes,
        // Withdrawals
        pendingWithdrawals,
        pendingCustomerWithdrawals,
        totalPendingWithdrawals: pendingWithdrawals + pendingCustomerWithdrawals,
        totalWithdrawn: totalWithdrawnResult._sum.amount || 0,
        // Deposits
        pendingDeposits,
        totalDeposits: totalApprovedDepositsResult._sum.amount || 0,
        // Outstanding liabilities
        totalOutstanding: totalOutstandingResult._sum.remainingAmount || 0,
        openOutstandingsCount,
        restrictedSellersCount,
        // Campaigns & Marketing
        activeCampaigns,
        totalCampaigns,
        activeBanners,
        // Real-Time System Health
        systemHealth: {
          status: dbStatus === 'healthy' ? 'operational' : 'degraded',
          database: {
            status: dbStatus,
            latencyMs: dbLatencyMs,
          },
          cache: {
            status: redisHealth.ok ? 'healthy' : 'degraded',
            mode: redisHealth.mode,
            latencyMs: redisHealth.latencyMs,
            connected: redisHealth.connected,
          },
          uptimeSeconds: Math.floor(process.uptime()),
          memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          memoryRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
          environment: config.env,
          timestamp: new Date().toISOString(),
        },
      },
      recentOrders,
      recentDeposits,
      recentWithdrawals,
    });
  } catch (error) {
    next(error);
  }
});

// Dedicated Real-Time System Health Diagnostics Endpoint
router.get('/system-health', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dbStart = Date.now();
    let dbStatus = 'healthy';
    let dbError = null;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (e: any) {
      dbStatus = 'unhealthy';
      dbError = e?.message || 'Database query failed';
    }
    const dbLatencyMs = Date.now() - dbStart;

    const redisHealth = await redis.ping();
    const mem = process.memoryUsage();

    const [
      ordersCount,
      usersCount,
      sellersCount,
      productsCount,
      storesCount,
      campaignsCount,
      outstandingsCount,
      depositsCount,
      withdrawalsCount,
    ] = await Promise.all([
      prisma.order.count().catch(() => 0),
      prisma.user.count({ where: { role: 'CUSTOMER' } }).catch(() => 0),
      prisma.seller.count().catch(() => 0),
      prisma.product.count().catch(() => 0),
      prisma.store.count().catch(() => 0),
      prisma.campaign.count().catch(() => 0),
      prisma.sellerOutstanding.count().catch(() => 0),
      prisma.walletDeposit.count().catch(() => 0),
      prisma.withdrawal.count().catch(() => 0),
    ]);

    const uptimeSeconds = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    const formattedUptime = `${hours}h ${minutes}m ${seconds}s`;

    ResponseUtil.success(res, {
      status: dbStatus === 'healthy' ? 'operational' : 'degraded',
      service: 'souqnaa-backend-core',
      timestamp: new Date().toISOString(),
      environment: config.env,
      uptime: {
        seconds: uptimeSeconds,
        formatted: formattedUptime,
      },
      database: {
        engine: 'PostgreSQL',
        status: dbStatus,
        latencyMs: dbLatencyMs,
        error: dbError,
        records: {
          orders: ordersCount,
          users: usersCount,
          sellers: sellersCount,
          products: productsCount,
          stores: storesCount,
          campaigns: campaignsCount,
          outstandings: outstandingsCount,
          deposits: depositsCount,
          withdrawals: withdrawalsCount,
        },
      },
      cache: {
        engine: 'Redis',
        status: redisHealth.ok ? 'healthy' : 'degraded',
        mode: redisHealth.mode,
        latencyMs: redisHealth.latencyMs,
        connected: redisHealth.connected,
        error: redisHealth.error || null,
      },
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        externalMB: Math.round(mem.external / 1024 / 1024),
      },
      process: {
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
      },
      realtimeSocket: {
        status: SocketService.get() ? 'operational' : 'standby',
      },
    });
  } catch (error) {
    next(error);
  }
});

// Chart aggregations: Revenue trends
router.get('/dashboard/revenue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: fromDate } },
      select: { createdAt: true, total: true },
      orderBy: { createdAt: 'asc' },
    });

    const trendMap = new Map<string, { date: string; revenue: number; orders: number }>();
    
    // Initialize continuous days
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      trendMap.set(key, { date: key, revenue: 0, orders: 0 });
    }

    for (const o of orders) {
      const dateKey = o.createdAt.toISOString().split('T')[0];
      const existing = trendMap.get(dateKey) || { date: dateKey, revenue: 0, orders: 0 };
      existing.revenue += o.total;
      existing.orders += 1;
      trendMap.set(dateKey, existing);
    }

    ResponseUtil.success(res, Array.from(trendMap.values()));
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 2. CUSTOMER MANAGEMENT
// ==============================================================================
router.get('/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = (req.query.search as string) || '';
    const status = req.query.status as string;

    const where: any = { role: 'CUSTOMER' };
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (status !== undefined) {
      where.isActive = status === 'active';
    }

    const [total, customers] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { orders: true, productReviews: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      customers,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/customers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const customer = await prisma.user.findUnique({
      where: { id },
      include: {
        orders: { take: 10, orderBy: { createdAt: 'desc' } },
        addresses: true,
        productReviews: { take: 5, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!customer) throw new AppError('العميل غير موجود', 404);
    ResponseUtil.success(res, customer);
  } catch (error) {
    next(error);
  }
});

router.post('/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName, email, phone, password, isActive } = req.body;
    if (!email || !firstName || !lastName) {
      throw new AppError('يرجى ملء كافة الحقول الأساسية المطلوبة', 400);
    }

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase() },
          ...(phone ? [{ phone }] : []),
        ],
      },
    });

    if (existing) {
      throw new AppError('البريد الإلكتروني أو رقم الهاتف مسجل مسبقاً في النظام', 409);
    }

    const hashedPassword = await bcrypt.hash(password || 'Souqnaa@123456', 10);
    const newCustomer = await prisma.user.create({
      data: {
        firstName,
        lastName,
        email: email.toLowerCase(),
        phone: phone || null,
        passwordHash: hashedPassword,
        role: 'CUSTOMER',
        isVerified: true,
        isActive: isActive !== false,
      },
    });

    await logAdminAction(req.user?.userId, 'CUSTOMER_CREATED', 'customers', { id: newCustomer.id, email: newCustomer.email }, req);
    ResponseUtil.success(res, newCustomer, 'تم إنشاء حساب العميل بنجاح', 201);
  } catch (error) {
    next(error);
  }
});

router.put('/customers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { firstName, lastName, email, phone, password, isActive } = req.body;

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw new AppError('حساب العميل غير موجود', 404);

    const updateData: any = {};
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (email) updateData.email = email.toLowerCase();
    if (phone !== undefined) updateData.phone = phone || null;
    if (isActive !== undefined) updateData.isActive = Boolean(isActive);
    if (password && password.trim().length > 0) {
      updateData.passwordHash = await bcrypt.hash(password, 10);
    }

    const updated = await prisma.user.update({
      where: { id },
      data: updateData,
    });

    await logAdminAction(req.user?.userId, 'CUSTOMER_UPDATED', 'customers', { id, updateData }, req);
    ResponseUtil.success(res, updated, 'تم تحديث بيانات العميل بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/customers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { orders: true } } },
    });
    if (!existing) throw new AppError('حساب العميل غير موجود', 404);

    // If customer has orders, soft-delete / deactivate to preserve historical integrity
    if (existing._count.orders > 0) {
      await prisma.user.update({
        where: { id },
        data: { isActive: false },
      });
      await logAdminAction(req.user?.userId, 'CUSTOMER_SOFT_DELETED', 'customers', { id, reason: 'Had orders, deactivated' }, req);
      ResponseUtil.success(res, null, 'نظراً لوجود طلبات سابقة مرتبطة بالعميل، تم إيقاف الحساب وأرشفته للحفاظ على سجلات الفواتير');
    } else {
      await prisma.user.delete({ where: { id } });
      await logAdminAction(req.user?.userId, 'CUSTOMER_DELETED', 'customers', { id }, req);
      ResponseUtil.success(res, null, 'تم حذف حساب العميل نهائياً من قاعدة البيانات');
    }
  } catch (error) {
    next(error);
  }
});

router.patch('/customers/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { isActive, reason } = req.body;

    const updated = await prisma.user.update({
      where: { id },
      data: { isActive: Boolean(isActive) },
    });

    await logAdminAction(req.user?.userId, isActive ? 'CUSTOMER_ACTIVATED' : 'CUSTOMER_SUSPENDED', 'customers', { id, reason }, req);
    ResponseUtil.success(res, updated, isActive ? 'تم تفعيل الحساب' : 'تم إيقاف حساب العميل');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 3. SELLER MANAGEMENT & VERIFICATION
// ==============================================================================
router.get('/sellers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as SellerStatus;
    const search = (req.query.search as string) || '';

    const where: any = {};
    if (status) where.status = status;
    if (search) {
      where.user = {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    const [total, sellers, pendingCount] = await Promise.all([
      prisma.seller.count({ where }),
      prisma.seller.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { firstName: true, lastName: true, email: true, phone: true, avatar: true } },
          stores: true,
          balance: true,
          _count: { select: { sellerOrders: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.seller.count({ where: { status: SellerStatus.PENDING_VERIFICATION } }),
    ]);

    ResponseUtil.success(res, {
      sellers,
      pendingCount,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/sellers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const seller = await prisma.seller.findUnique({
      where: { id },
      include: {
        user: true,
        stores: {
          include: {
            addresses: { include: { city: true, district: true } },
            _count: { select: { products: true } },
          },
        },
        balance: { include: { transactions: { take: 10, orderBy: { createdAt: 'desc' } } } },
        withdrawals: { take: 5, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!seller) throw new AppError('التاجر غير موجود', 404);
    ResponseUtil.success(res, seller);
  } catch (error) {
    next(error);
  }
});

router.post('/sellers/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { notes } = req.body;

    const seller = await prisma.$transaction(async (tx) => {
      const updatedSeller = await (tx.seller as any).update({
        where: { id },
        data: {
          status: SellerStatus.ACTIVE,
          verifiedAt: new Date(),
          verificationNotes: notes || null,
        },
      });
      await tx.store.updateMany({
        where: { sellerId: id },
        data: { isVerified: true, isActive: true },
      });
      return updatedSeller;
    });

    await logAdminAction(req.user?.userId, 'SELLER_APPROVED', 'sellers', { id, notes }, req);
    SocketService.get()?.emitGlobal('admin:seller_updated', { id, status: SellerStatus.ACTIVE, notes });
    SocketService.get()?.emitGlobal('admin:store_updated', { sellerId: id });
    ResponseUtil.success(res, seller, 'تم اعتماد وتفعيل حساب التاجر بنجاح');
  } catch (error) {
    next(error);
  }
});

router.post('/sellers/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason } = req.body;
    if (!reason) throw new AppError('سبب الرفض مطلوب', 400);

    const seller = await (prisma.seller as any).update({
      where: { id },
      data: {
        status: SellerStatus.REJECTED,
        rejectionReason: reason,
      },
    });

    await logAdminAction(req.user?.userId, 'SELLER_REJECTED', 'sellers', { id, reason }, req);
    SocketService.get()?.emitGlobal('admin:seller_updated', { id, status: SellerStatus.REJECTED, reason });
    ResponseUtil.success(res, seller, 'تم رفض طلب التاجر');
  } catch (error) {
    next(error);
  }
});

router.post('/sellers/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason } = req.body;

    const seller = await prisma.$transaction(async (tx) => {
      const s = await tx.seller.update({
        where: { id },
        data: { status: SellerStatus.SUSPENDED },
      });
      await tx.store.updateMany({
        where: { sellerId: id },
        data: { isActive: false },
      });
      return s;
    });

    await logAdminAction(req.user?.userId, 'SELLER_SUSPENDED', 'sellers', { id, reason }, req);
    SocketService.get()?.emitGlobal('admin:seller_updated', { id, status: SellerStatus.SUSPENDED, reason });
    SocketService.get()?.emitGlobal('admin:store_updated', { sellerId: id });
    ResponseUtil.success(res, seller, 'تم إيقاف حساب التاجر ومتاجره');
  } catch (error) {
    next(error);
  }
});

router.post('/sellers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName, email, phone, password, storeName, crNumber, taxNumber, businessType, commissionRate, status } = req.body;
    if (!email || !firstName || !lastName || !storeName) {
      throw new AppError('يرجى ملء كافة الحقول الأساسية واسم المتجر', 400);
    }

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase() },
          ...(phone ? [{ phone }] : []),
        ],
      },
    });
    if (existing) throw new AppError('البريد الإلكتروني أو رقم الهاتف مسجل مسبقاً', 409);

    const slug = storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.floor(Math.random() * 1000);
    const hashedPassword = await bcrypt.hash(password || 'Souqnaa@123456', 10);
    const sellerStatus = (status as SellerStatus) || SellerStatus.ACTIVE;

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName,
          lastName,
          email: email.toLowerCase(),
          phone: phone || null,
          passwordHash: hashedPassword,
          role: 'SELLER',
          isVerified: true,
          isActive: true,
        },
      });

      const seller = await tx.seller.create({
        data: {
          userId: user.id,
          businessType: businessType || 'INDIVIDUAL',
          crNumber: crNumber || null,
          taxNumber: taxNumber || null,
          commissionRate: commissionRate !== undefined ? Number(commissionRate) : 0.10,
          status: sellerStatus,
          verifiedAt: sellerStatus === SellerStatus.ACTIVE ? new Date() : null,
        },
      });

      await tx.sellerBalance.create({
        data: {
          sellerId: seller.id,
          availableBalance: 0,
          pendingBalance: 0,
          withdrawnBalance: 0,
        },
      });

      const store = await tx.store.create({
        data: {
          sellerId: seller.id,
          name: storeName,
          slug,
          isActive: sellerStatus === SellerStatus.ACTIVE,
          isVerified: sellerStatus === SellerStatus.ACTIVE,
        },
      });

      return { user, seller, store };
    });

    await logAdminAction(req.user?.userId, 'SELLER_CREATED', 'sellers', { sellerId: result.seller.id, storeId: result.store.id }, req);
    ResponseUtil.success(res, result, 'تم إنشاء حساب التاجر ومتجره بنجاح', 201);
  } catch (error) {
    next(error);
  }
});

router.put('/sellers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { firstName, lastName, email, phone, password, storeName, crNumber, taxNumber, businessType, commissionRate, status } = req.body;

    const existingSeller = await prisma.seller.findUnique({
      where: { id },
      include: { user: true, stores: true },
    });
    if (!existingSeller) throw new AppError('حساب التاجر غير موجود', 404);

    const userUpdate: any = {};
    if (firstName) userUpdate.firstName = firstName;
    if (lastName) userUpdate.lastName = lastName;
    if (email) userUpdate.email = email.toLowerCase();
    if (phone !== undefined) userUpdate.phone = phone || null;
    if (password && password.trim().length > 0) {
      userUpdate.passwordHash = await bcrypt.hash(password, 10);
    }

    const sellerUpdate: any = {};
    if (crNumber !== undefined) sellerUpdate.crNumber = crNumber || null;
    if (taxNumber !== undefined) sellerUpdate.taxNumber = taxNumber || null;
    if (businessType) sellerUpdate.businessType = businessType;
    if (commissionRate !== undefined) sellerUpdate.commissionRate = Number(commissionRate);
    if (status) sellerUpdate.status = status as SellerStatus;

    await prisma.$transaction(async (tx) => {
      if (Object.keys(userUpdate).length > 0) {
        await tx.user.update({ where: { id: existingSeller.userId }, data: userUpdate });
      }
      if (Object.keys(sellerUpdate).length > 0) {
        await tx.seller.update({ where: { id }, data: sellerUpdate });
      }
      if (storeName && existingSeller.stores.length > 0) {
        await tx.store.update({
          where: { id: existingSeller.stores[0].id },
          data: { name: storeName },
        });
      }
    });

    await logAdminAction(req.user?.userId, 'SELLER_UPDATED', 'sellers', { id, sellerUpdate }, req);
    ResponseUtil.success(res, null, 'تم تحديث بيانات التاجر والمتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/sellers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.seller.findUnique({
      where: { id },
      include: { _count: { select: { sellerOrders: true } } },
    });
    if (!existing) throw new AppError('حساب التاجر غير موجود', 404);

    if (existing._count.sellerOrders > 0) {
      await prisma.$transaction([
        prisma.seller.update({ where: { id }, data: { status: SellerStatus.SUSPENDED } }),
        prisma.store.updateMany({ where: { sellerId: id }, data: { isActive: false } }),
        prisma.user.update({ where: { id: existing.userId }, data: { isActive: false } }),
      ]);
      await logAdminAction(req.user?.userId, 'SELLER_SOFT_DELETED', 'sellers', { id, reason: 'Has orders, suspended' }, req);
      ResponseUtil.success(res, null, 'نظراً لوجود مبيعات وطلبات سابقة، تم إيقاف وأرشفة حساب التاجر ومتاجره');
    } else {
      await prisma.user.delete({ where: { id: existing.userId } }); // cascades to Seller, Store, SellerBalance
      await logAdminAction(req.user?.userId, 'SELLER_DELETED', 'sellers', { id }, req);
      ResponseUtil.success(res, null, 'تم حذف حساب التاجر والمتجر نهائياً من النظام');
    }
  } catch (error) {
    next(error);
  }
});

router.post('/sellers/:id/activate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const seller = await prisma.$transaction(async (tx) => {
      const s = await tx.seller.update({
        where: { id },
        data: { status: SellerStatus.ACTIVE },
      });
      await tx.store.updateMany({
        where: { sellerId: id },
        data: { isActive: true },
      });
      return s;
    });

    await logAdminAction(req.user?.userId, 'SELLER_ACTIVATED', 'sellers', { id }, req);
    ResponseUtil.success(res, seller, 'تم إعادة تفعيل حساب التاجر');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 4. STORE MANAGEMENT
// ==============================================================================
router.get('/stores', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = (req.query.search as string) || '';
    const status = req.query.status as string;

    const where: any = {};
    if (status === 'active') where.isActive = true;
    if (status === 'suspended') where.isActive = false;
    if (status === 'verified') where.isVerified = true;
    if (status === 'unverified' || status === 'pending') where.isVerified = false;

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { seller: { user: { firstName: { contains: search, mode: 'insensitive' } } } },
        { seller: { user: { lastName: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    const [total, stores, pendingCount] = await Promise.all([
      prisma.store.count({ where }),
      prisma.store.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          seller: { include: { user: { select: { firstName: true, lastName: true, email: true, phone: true } } } },
          _count: { select: { products: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.store.count({ where: { isVerified: false } }),
    ]);

    ResponseUtil.success(res, {
      stores,
      pendingCount,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/stores/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const store = await prisma.store.findUnique({
      where: { id },
      include: {
        seller: { include: { user: true } },
        addresses: true,
        products: { take: 10, orderBy: { createdAt: 'desc' } },
        _count: { select: { products: true } },
      },
    });
    if (!store) throw new AppError('المتجر غير موجود', 404);
    ResponseUtil.success(res, store);
  } catch (error) {
    next(error);
  }
});

router.post('/stores/:id/feature', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const store = await prisma.store.findUnique({ where: { id } });
    if (!store) throw new AppError('المتجر غير موجود', 404);

    const updated = await prisma.store.update({
      where: { id },
      data: { isVerified: !store.isVerified },
    });

    await logAdminAction(req.user?.userId, 'STORE_FEATURE_TOGGLED', 'stores', { id, isVerified: updated.isVerified }, req);
    ResponseUtil.success(res, updated, updated.isVerified ? 'تم منح شارة التوثيق والتميز للمتجر ★' : 'تمت إزالة شارة التوثيق والتميز عن المتجر');
  } catch (error) {
    next(error);
  }
});

router.patch('/stores/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { isActive, reason } = req.body;

    const updated = await prisma.store.update({
      where: { id },
      data: { isActive: Boolean(isActive) },
    });

    await logAdminAction(req.user?.userId, isActive ? 'STORE_ACTIVATED' : 'STORE_SUSPENDED', 'stores', { id, reason }, req);
    ResponseUtil.success(res, updated, isActive ? 'تم تفعيل المتجر ونشره في السوق' : 'تم إيقاف المتجر وحجب منتجاته');
  } catch (error) {
    next(error);
  }
});

router.put('/stores/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { name, slug, description } = req.body;

    const updated = await prisma.store.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(slug ? { slug } : {}),
        ...(description !== undefined ? { description } : {}),
      },
    });

    await logAdminAction(req.user?.userId, 'STORE_UPDATED', 'stores', { id, name, slug }, req);
    ResponseUtil.success(res, updated, 'تم تحديث بيانات المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 5. PRODUCT MODERATION
// ==============================================================================
router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = (req.query.search as string) || '';
    const categoryId = req.query.categoryId as string;
    const status = req.query.status as string;

    const where: any = {};
    if (status === 'active') where.isActive = true;
    if (status === 'suspended') where.isActive = false;
    if (status === 'reported') where.reports = { some: {} };

    if (search) {
      where.OR = [
        { nameAr: { contains: search, mode: 'insensitive' } },
        { nameEn: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
        { store: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (categoryId && categoryId.length > 0) where.categoryId = categoryId;

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          category: { select: { id: true, nameAr: true, nameEn: true } },
          store: { select: { id: true, name: true, slug: true } },
          images: { take: 1, orderBy: { sortOrder: 'asc' } },
          _count: { select: { productReviews: true, orderItems: true, reports: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      products,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/products/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        store: { include: { seller: { include: { user: true } } } },
        images: { orderBy: { sortOrder: 'asc' } },
        variants: true,
        reports: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { firstName: true, lastName: true, email: true } } },
        },
        productReviews: {
          take: 5,
          orderBy: { createdAt: 'desc' },
          select: { id: true, rating: true, title: true, body: true, status: true, user: { select: { firstName: true, lastName: true } } },
        },
        _count: { select: { productReviews: true, orderItems: true, reports: true } },
      },
    });
    if (!product) throw new AppError('المنتج غير موجود', 404);
    ResponseUtil.success(res, product);
  } catch (error) {
    next(error);
  }
});

router.post('/products/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const product = await prisma.product.update({
      where: { id },
      data: { isActive: true },
    });
    await logAdminAction(req.user?.userId, 'PRODUCT_APPROVED', 'products', { id }, req);
    ResponseUtil.success(res, product, 'تم اعتماد وتفعيل نشر المنتج في السوق');
  } catch (error) {
    next(error);
  }
});

router.post('/products/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason, reportType } = req.body;
    const product = await prisma.product.update({
      where: { id },
      data: { isActive: false },
    });
    await logAdminAction(req.user?.userId, 'PRODUCT_SUSPENDED', 'products', { id, reason, reportType }, req);
    ResponseUtil.success(res, product, 'تم إيقاف وحجب المنتج عن العرض لانتهاك السياسات أو البلاغات');
  } catch (error) {
    next(error);
  }
});

router.put('/products/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { nameAr, nameEn, price, stock, categoryId, isActive } = req.body;

    const updated = await prisma.product.update({
      where: { id },
      data: {
        ...(nameAr ? { nameAr } : {}),
        ...(nameEn ? { nameEn } : {}),
        ...(price !== undefined ? { price: Number(price) } : {}),
        ...(stock !== undefined ? { stock: Number(stock) } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
      },
    });

    await logAdminAction(req.user?.userId, 'PRODUCT_UPDATED', 'products', { id, updated }, req);
    ResponseUtil.success(res, updated, 'تم تحديث بيانات المنتج بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/products/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.product.findUnique({
      where: { id },
      include: { _count: { select: { orderItems: true } } },
    });
    if (!existing) throw new AppError('المنتج غير موجود', 404);

    if (existing._count.orderItems > 0) {
      await prisma.product.update({ where: { id }, data: { isActive: false } });
      await logAdminAction(req.user?.userId, 'PRODUCT_SOFT_DELETED', 'products', { id, reason: 'Has order items' }, req);
      ResponseUtil.success(res, null, 'نظراً لوجود مبيعات سابقة للمنتج، تم حجب المنتج وأرشفته');
    } else {
      await prisma.product.delete({ where: { id } });
      await logAdminAction(req.user?.userId, 'PRODUCT_DELETED', 'products', { id }, req);
      ResponseUtil.success(res, null, 'تم حذف المنتج نهائياً من قاعدة البيانات');
    }
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 6. CATEGORIES & BRANDS
// ==============================================================================
router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await prisma.category.findMany({
      include: {
        children: true,
        _count: { select: { products: true } },
      },
      orderBy: { sortOrder: 'asc' },
    });
    ResponseUtil.success(res, categories);
  } catch (error) {
    next(error);
  }
});

router.post('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { nameAr, nameEn, slug, image, icon, parentId, sortOrder } = req.body;
    const category = await prisma.category.create({
      data: {
        nameAr,
        nameEn,
        slug,
        image: image || null,
        icon: icon || null,
        parentId: parentId || null,
        sortOrder: sortOrder ? parseInt(sortOrder) : 0,
      },
    });
    await logAdminAction(req.user?.userId, 'CATEGORY_CREATED', 'categories', { categoryId: category.id, nameAr }, req);
    ResponseUtil.created(res, category, 'تم إنشاء التصنيف بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/categories/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { nameAr, nameEn, slug, image, icon, isActive, sortOrder, parentId } = req.body;
    const category = await prisma.category.update({
      where: { id },
      data: {
        nameAr: nameAr ?? undefined,
        nameEn: nameEn ?? undefined,
        slug: slug ?? undefined,
        image: image !== undefined ? (image || null) : undefined,
        icon: icon !== undefined ? (icon || null) : undefined,
        parentId: parentId !== undefined ? (parentId || null) : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
        sortOrder: sortOrder !== undefined ? parseInt(sortOrder) : undefined,
      },
    });
    await logAdminAction(req.user?.userId, 'CATEGORY_UPDATED', 'categories', { id, nameAr }, req);
    ResponseUtil.success(res, category, 'تم تعديل بيانات التصنيف بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/categories/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const [productsCount, childrenCount] = await Promise.all([
      prisma.product.count({ where: { categoryId: id } }),
      prisma.category.count({ where: { parentId: id } }),
    ]);

    if (productsCount > 0) {
      throw new AppError(`لا يمكن حذف التصنيف لاحتوائه على ${productsCount} منتج. يرجى نقل المنتجات أولاً.`, 400);
    }
    if (childrenCount > 0) {
      throw new AppError(`لا يمكن حذف التصنيف لاحتوائه على ${childrenCount} أقسام فرعية تابعة.`, 400);
    }

    await prisma.category.delete({ where: { id } });
    await logAdminAction(req.user?.userId, 'CATEGORY_DELETED', 'categories', { id }, req);
    ResponseUtil.success(res, null, 'تم حذف التصنيف بنجاح');
  } catch (error) {
    next(error);
  }
});

// Brands
router.get('/brands', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const brands = await prisma.brand.findMany({
      include: { _count: { select: { products: true } } },
      orderBy: { nameAr: 'asc' },
    });
    ResponseUtil.success(res, brands);
  } catch (error) {
    next(error);
  }
});

router.post('/brands', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { nameAr, nameEn, slug, logo } = req.body;
    const brand = await prisma.brand.create({
      data: { nameAr, nameEn, slug, logo: logo || null },
    });
    await logAdminAction(req.user?.userId, 'BRAND_CREATED', 'brands', { id: brand.id, nameAr }, req);
    ResponseUtil.created(res, brand, 'تم إضافة الماركة التجارية بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/brands/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { nameAr, nameEn, slug, logo } = req.body;
    const brand = await prisma.brand.update({
      where: { id },
      data: {
        nameAr: nameAr ?? undefined,
        nameEn: nameEn ?? undefined,
        slug: slug ?? undefined,
        logo: logo !== undefined ? (logo || null) : undefined,
      },
    });
    await logAdminAction(req.user?.userId, 'BRAND_UPDATED', 'brands', { id, nameAr }, req);
    ResponseUtil.success(res, brand, 'تم تعديل بيانات الماركة التجارية');
  } catch (error) {
    next(error);
  }
});

router.delete('/brands/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const productsCount = await prisma.product.count({ where: { brandId: id } });
    if (productsCount > 0) {
      throw new AppError(`لا يمكن حذف الماركة لوجود ${productsCount} منتج مرتبط بها.`, 400);
    }
    await prisma.brand.delete({ where: { id } });
    await logAdminAction(req.user?.userId, 'BRAND_DELETED', 'brands', { id }, req);
    ResponseUtil.success(res, null, 'تم حذف الماركة التجارية بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 7. ORDER MANAGEMENT & STATE MACHINE
// ==============================================================================
router.get('/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as OrderStatus;
    const paymentStatus = req.query.paymentStatus as string;
    const search = (req.query.search as string) || '';
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;

    const paymentMethod = req.query.paymentMethod as string;
    const hasWalletProof = req.query.hasWalletProof === 'true';

    const where: any = {};
    if (status) where.status = status;
    if (paymentStatus) {
      where.payment = { ...(where.payment || {}), status: paymentStatus };
    }
    if (paymentMethod) {
      where.payment = { ...(where.payment || {}), method: paymentMethod as any };
    }
    if (hasWalletProof) {
      where.payment = { ...(where.payment || {}), walletTransactionRef: { not: null } };
    }
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }
    if (search) {
      const cleanSearch = search.trim();
      const numMatch = cleanSearch.match(/\d+/);
      const seqSearch = numMatch ? parseInt(numMatch[0], 10) : undefined;

      const orConditions: any[] = [
        { id: cleanSearch },
        { orderNumber: { contains: cleanSearch, mode: 'insensitive' } },
        { displayOrderNumber: { contains: cleanSearch, mode: 'insensitive' } },
        { sellerOrders: { some: { sellerOrderNumber: { contains: cleanSearch, mode: 'insensitive' } } } },
        { sellerOrders: { some: { sellerId: cleanSearch } } },
        { sellerOrders: { some: { seller: { stores: { some: { name: { contains: cleanSearch, mode: 'insensitive' } } } } } } },
        { user: { phone: { contains: cleanSearch } } },
        { user: { firstName: { contains: cleanSearch, mode: 'insensitive' } } },
        { user: { lastName: { contains: cleanSearch, mode: 'insensitive' } } },
        { user: { email: { contains: cleanSearch, mode: 'insensitive' } } },
      ];
      if (seqSearch && !isNaN(seqSearch)) {
        orConditions.push({ orderSequence: seqSearch });
      }
      where.OR = orConditions;
    }

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { firstName: true, lastName: true, phone: true, email: true } },
          sellerOrders: {
            include: {
              seller: { include: { stores: { take: 1 } } },
              items: true,
            },
          },
          payment: true,
          deliveryMethod: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      orders,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/orders/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { id },
          { orderNumber: id },
          { displayOrderNumber: id },
          { sellerOrders: { some: { sellerOrderNumber: id } } },
        ],
      },
      include: {
        user: true,
        addressSnapshot: true,
        payment: true,
        sellerOrders: {
          include: {
            seller: { include: { stores: true } },
            items: { include: { product: true, variant: true } },
            deliveryOrder: true,
          },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        cancellationRequests: { orderBy: { createdAt: 'desc' } },
        returnRequests: { orderBy: { createdAt: 'desc' } },
        refundRequests: {
          include: {
            evidence: true,
            items: true,
            reason: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!order) throw new AppError('الطلب غير موجود', 404);
    ResponseUtil.success(res, order);
  } catch (error) {
    next(error);
  }
});

// GET /orders/:id/invoice — Admin order invoice & printable receipt
router.get(['/orders/:id/invoice', '/orders/:id/receipt'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { id },
          { orderNumber: id },
          { displayOrderNumber: id },
          { sellerOrders: { some: { sellerOrderNumber: id } } },
        ],
      },
      include: {
        user: { select: { firstName: true, lastName: true, phone: true } },
        addressSnapshot: true,
        payment: true,
        sellerOrders: {
          include: {
            seller: { include: { stores: true } },
            items: true,
          },
        },
      },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    const invoiceData = OrderInvoiceService.buildInvoiceData(order);

    if (req.query.format === 'html' || req.headers.accept?.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(OrderInvoiceService.renderHtmlReceipt(invoiceData));
    }

    ResponseUtil.success(res, invoiceData, 'تم استرجاع بيانات الفاتورة بنجاح');
  } catch (error) {
    next(error);
  }
});

router.patch('/orders/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { status, reason } = req.body;
    if (!status) throw new AppError('الحالة الجديدة مطلوبة', 400);
    if (!reason) throw new AppError('سبب تغيير الحالة مطلوب للرقابة', 400);

    const updated = await prisma.$transaction(async (tx) => {
      const o = await tx.order.update({
        where: { id },
        data: { status: status as OrderStatus },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          toStatus: String(status),
          status: status as any,
          changedBy: req.user!.userId,
          changedByRole: 'ADMIN',
          note: `تغيير إداري: ${reason}`,
        },
      });

      return o;
    });

    await logAdminAction(req.user?.userId, 'ORDER_STATUS_CHANGED', 'orders', { orderId: id, newStatus: status, reason }, req);
    ResponseUtil.success(res, updated, `تم تحديث حالة الطلب إلى ${status}`);
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 7.1. LOCAL YEMENI WALLET PAYMENTS & VERIFICATION (إدارة وتأكيد حوالات المحافظ الرقمية)
// ==============================================================================

// GET /api/v1/admin/payments/wallet-transfers
// Lists all orders paid via Yemeni digital wallets or with external transfer references
const handleGetWalletTransfers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as string; // 'ALL', 'PENDING', 'PAID', 'FAILED'
    const provider = (req.query.provider as string)?.trim().toUpperCase();
    const search = (req.query.search as string)?.trim();

    const where: any = {
      OR: [
        { method: 'YEMENI_WALLET' as any },
        { walletTransactionRef: { not: null } },
        { walletReceiptUrl: { not: null } },
      ],
    };

    if (status && status !== 'ALL') {
      where.status = status as PaymentStatus;
    }

    if (provider && provider !== 'ALL') {
      where.walletProvider = { equals: provider, mode: 'insensitive' };
    }

    if (search) {
      where.AND = [
        {
          OR: [
            { walletTransactionRef: { contains: search, mode: 'insensitive' } },
            { walletSenderNumber: { contains: search } },
            { walletProvider: { contains: search, mode: 'insensitive' } },
            {
              order: {
                OR: [
                  { orderNumber: { contains: search, mode: 'insensitive' } },
                  { user: { firstName: { contains: search, mode: 'insensitive' } } },
                  { user: { lastName: { contains: search, mode: 'insensitive' } } },
                  { user: { phone: { contains: search } } },
                ],
              },
            },
          ],
        },
      ];
    }

    const [total, payments, pendingCount, pendingAmountResult] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          order: {
            include: {
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  phone: true,
                  email: true,
                },
              },
              addressSnapshot: true,
              sellerOrders: {
                include: {
                  seller: { include: { stores: { select: { name: true, logo: true } } } },
                  items: true,
                },
              },
            },
          },
          transactions: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
      }),
      prisma.payment.count({
        where: {
          OR: [
            { method: 'YEMENI_WALLET' as any },
            { walletTransactionRef: { not: null } },
            { walletReceiptUrl: { not: null } },
          ],
          status: PaymentStatus.PENDING,
        },
      }),
      prisma.payment.aggregate({
        where: {
          OR: [
            { method: 'YEMENI_WALLET' as any },
            { walletTransactionRef: { not: null } },
            { walletReceiptUrl: { not: null } },
          ],
          status: PaymentStatus.PENDING,
        },
        _sum: { amount: true },
      }),
    ]);

    ResponseUtil.success(res, {
      transfers: payments.map((p) => ({
        id: p.id,
        orderId: p.orderId,
        orderNumber: p.order?.orderNumber || '#ORD',
        orderStatus: p.order?.status || 'PENDING',
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        paidAt: p.paidAt,
        walletProvider: p.walletProvider,
        walletSenderNumber: p.walletSenderNumber,
        walletTransactionRef: p.walletTransactionRef,
        walletReceiptUrl: p.walletReceiptUrl,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        user: p.order?.user || null,
        address: p.order?.addressSnapshot || null,
        sellerOrders: p.order?.sellerOrders || [],
        transactions: p.transactions || [],
      })),
      summary: {
        pendingCount,
        pendingAmount: pendingAmountResult._sum.amount || 0,
      },
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

router.get('/payments/wallet-transfers', handleGetWalletTransfers);
router.get('/orders/wallet-transfers', handleGetWalletTransfers);

// POST /api/v1/admin/payments/:orderId/verify-wallet
// Admin approves and verifies manual wallet transfer
const handleVerifyWalletPayment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderId = String(req.params.orderId || req.params.id);
    const { note, adminReference } = req.body;

    const order = await prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderNumber: orderId }] },
      include: { payment: true, user: true, sellerOrders: true },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);
    if (!order.payment) throw new AppError('لا توجد بيانات دفع مسجلة لهذا الطلب', 404);

    const payment = order.payment;
    const effectiveProvider = payment.walletProvider || 'محفظة رقمية';

    const result = await prisma.$transaction(async (tx) => {
      // 1. Update payment to PAID
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          transactionId: adminReference || payment.walletTransactionRef || payment.transactionId || `VERIFIED-${Date.now()}`,
        },
      });

      // 2. Update existing pending paymentTransaction or create new one
      const existingTx = await tx.paymentTransaction.findFirst({
        where: { paymentId: payment.id, status: PaymentStatus.PENDING },
      });
      if (existingTx) {
        await tx.paymentTransaction.update({
          where: { id: existingTx.id },
          data: {
            status: PaymentStatus.PAID,
            rawResponse: JSON.stringify({
              verifiedBy: req.user!.userId,
              verifiedAt: new Date(),
              adminReference,
              note,
            }),
          },
        });
      } else {
        await tx.paymentTransaction.create({
          data: {
            paymentId: payment.id,
            gateway: effectiveProvider,
            referenceId: adminReference || payment.walletTransactionRef || updatedPayment.transactionId,
            amount: payment.amount,
            status: PaymentStatus.PAID,
            rawResponse: JSON.stringify({
              verifiedBy: req.user!.userId,
              verifiedAt: new Date(),
              note,
            }),
          },
        });
      }

      // 3. Keep order & sellerOrders in PENDING so they proceed to the seller side under "جديدة / بانتظار القبول" (Pending acceptance)
      let updatedOrder = order;
      if (order.status === OrderStatus.PENDING) {
        await tx.sellerOrder.updateMany({
          where: { orderId: order.id, status: SellerOrderStatus.PENDING },
          data: { status: SellerOrderStatus.PENDING },
        });
      }

      // 4. Create OrderStatusHistory
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          status: updatedOrder.status,
          toStatus: updatedOrder.status,
          changedBy: req.user!.userId,
          changedByRole: 'ADMIN',
          note: note || `تم تأكيد استلام الحوالة واعتماد الدفع بنجاح عبر (${effectiveProvider}) - المرجع: ${payment.walletTransactionRef || '-'}`,
        },
      });

      // 5. Dispatch payment verification domain event
      try {
        notificationEventBus.publish(
          NotificationEventFactory.paymentEvent({
            eventType: 'PAYMENT_SUCCESS',
            recipientId: order.userId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            amount: Number(payment.amount),
            currency: 'YER',
          })
        );
      } catch (_) {}

      return { updatedOrder, updatedPayment };
    });

    await logAdminAction(req.user?.userId, 'WALLET_PAYMENT_VERIFIED', 'payments', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      amount: payment.amount,
      walletProvider: payment.walletProvider,
      transactionRef: payment.walletTransactionRef,
      note,
    }, req);

    try {
      SocketService.get()?.emitGlobal('payment:verified', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: PaymentStatus.PAID,
      });
      // Now that payment is verified by Admin, notify sellers so it appears in real-time under "جديدة / بانتظار القبول"
      SocketService.get()?.emitGlobal('new:order', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        total: order.total,
      });
      SocketService.get()?.emitGlobal('order:created', {
        orderId: order.id,
        orderNumber: order.orderNumber,
      });
      SocketService.get()?.emitGlobal('order:status', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: result.updatedOrder.status,
      });
      SocketService.get()?.emitGlobal('order:updated', {
        orderId: order.id,
        status: result.updatedOrder.status,
      });
      SocketService.get()?.emitGlobal('seller:orders_updated', {
        orderId: order.id,
        orderNumber: order.orderNumber,
      });
    } catch (_) {}

    ResponseUtil.success(res, result, 'تم التحقق من الحوالة وتأكيد دفع الطلب بنجاح');
  } catch (error) {
    next(error);
  }
};

router.post('/payments/:orderId/verify-wallet', handleVerifyWalletPayment);
router.post('/orders/:orderId/verify-wallet', handleVerifyWalletPayment);

// POST /api/v1/admin/payments/:orderId/reject-wallet
// Admin rejects manual wallet transfer with reason
const handleRejectWalletPayment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderId = String(req.params.orderId || req.params.id);
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      throw new AppError('يرجى كتابة سبب رفض إشعار التحويل لتوضيحه للعميل', 400);
    }

    const order = await prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderNumber: orderId }] },
      include: { payment: true, user: true },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);
    if (!order.payment) throw new AppError('لا توجد بيانات دفع مسجلة لهذا الطلب', 404);

    const payment = order.payment;
    const effectiveProvider = payment.walletProvider || 'محفظة رقمية';

    const result = await prisma.$transaction(async (tx) => {
      // 1. Update payment to FAILED
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });

      // 2. Update transactions to FAILED
      await tx.paymentTransaction.updateMany({
        where: { paymentId: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.FAILED,
          rawResponse: JSON.stringify({
            rejectedBy: req.user!.userId,
            rejectedAt: new Date(),
            reason,
          }),
        },
      });

      // 3. Cancel the Order and SellerOrders so order does NOT proceed to seller
      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLED_BY_ADMIN },
      });

      const sellerOrders = await tx.sellerOrder.findMany({
        where: { orderId: order.id },
        include: { items: true },
      });

      for (const so of sellerOrders) {
        await tx.sellerOrder.update({
          where: { id: so.id },
          data: { status: SellerOrderStatus.CANCELLED_BY_ADMIN },
        });

        // Release reserved inventory
        for (const item of so.items) {
          if (item.variantId) {
            await tx.productVariant.updateMany({
              where: { id: item.variantId },
              data: {
                stockQuantity: { increment: item.quantity },
              },
            });
          }
          if (item.productId) {
            await tx.inventory.updateMany({
              where: { productId: item.productId },
              data: {
                reserved: { decrement: item.quantity },
              },
            });
          }
        }

        // Revert seller pending balance
        await tx.sellerBalance.updateMany({
          where: { sellerId: so.sellerId },
          data: { pendingBalance: { decrement: so.sellerPayout } },
        });
      }

      // 4. Create OrderStatusHistory
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          status: OrderStatus.CANCELLED_BY_ADMIN,
          toStatus: OrderStatus.CANCELLED_BY_ADMIN,
          changedBy: req.user!.userId,
          changedByRole: 'ADMIN',
          note: `تم رفض إشعار التحويل اليدوي عبر (${effectiveProvider}) وإلغاء الطلب وتحرير المخزون - السبب: ${reason}`,
        },
      });

      // 5. Dispatch payment rejection domain event
      try {
        notificationEventBus.publish(
          NotificationEventFactory.paymentEvent({
            eventType: 'PAYMENT_FAILED',
            recipientId: order.userId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            amount: Number(payment.amount),
            errorMessage: reason,
          })
        );
      } catch (_) {}

      return { updatedOrder, updatedPayment };
    });

    await logAdminAction(req.user?.userId, 'WALLET_PAYMENT_REJECTED', 'payments', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      amount: payment.amount,
      walletProvider: payment.walletProvider,
      transactionRef: payment.walletTransactionRef,
      reason,
    }, req);

    try {
      SocketService.get()?.emitGlobal('payment:rejected', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: PaymentStatus.FAILED,
        reason,
      });
      SocketService.get()?.emitGlobal('order:cancelled', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: OrderStatus.CANCELLED_BY_ADMIN,
      });
      SocketService.get()?.emitGlobal('order:status', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: OrderStatus.CANCELLED_BY_ADMIN,
      });
      SocketService.get()?.emitGlobal('order:updated', {
        orderId: order.id,
        status: OrderStatus.CANCELLED_BY_ADMIN,
      });
      SocketService.get()?.emitGlobal('seller:orders_updated', {
        orderId: order.id,
        orderNumber: order.orderNumber,
      });
    } catch (_) {}

    ResponseUtil.success(res, result, 'تم تسجيل رفض إشعار التحويل وإشعار العميل بنجاح');
  } catch (error) {
    next(error);
  }
};

router.post('/payments/:orderId/reject-wallet', handleRejectWalletPayment);
router.post('/orders/:orderId/reject-wallet', handleRejectWalletPayment);

// ==============================================================================
// ==============================================
// 8. DELIVERY ZONES & RULE ENGINE
// ==============================================
router.get('/delivery/zones', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const zones = await prisma.deliveryZone.findMany({
      include: {
        city: { select: { id: true, nameAr: true, nameEn: true } },
        rules: {
          include: { deliveryMethod: true },
        },
        _count: { select: { rules: true, boundaries: true } },
      },
      orderBy: { name: 'asc' },
    });
    ResponseUtil.success(res, zones);
  } catch (error) {
    next(error);
  }
});

router.post('/delivery/zones', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, cityId, zoneType, centerLat, centerLng, radiusKm, isActive } = req.body;
    const zone = await prisma.deliveryZone.create({
      data: {
        name,
        cityId: cityId || null,
        zoneType: zoneType || DeliveryZoneType.CITY,
        centerLat: centerLat ? parseFloat(centerLat) : null,
        centerLng: centerLng ? parseFloat(centerLng) : null,
        radiusKm: radiusKm ? parseFloat(radiusKm) : 10.0,
        isActive: isActive !== undefined ? Boolean(isActive) : true,
      },
    });
    await logAdminAction(req.user?.userId, 'DELIVERY_ZONE_CREATED', 'delivery', { id: zone.id, name }, req);
    ResponseUtil.created(res, zone, 'تم إنشاء منطقة التوصيل بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/delivery/zones/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { name, cityId, zoneType, centerLat, centerLng, radiusKm, isActive } = req.body;
    const zone = await prisma.deliveryZone.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        cityId: cityId !== undefined ? (cityId || null) : undefined,
        zoneType: zoneType !== undefined ? zoneType : undefined,
        centerLat: centerLat !== undefined ? (centerLat ? parseFloat(centerLat) : null) : undefined,
        centerLng: centerLng !== undefined ? (centerLng ? parseFloat(centerLng) : null) : undefined,
        radiusKm: radiusKm !== undefined ? (radiusKm ? parseFloat(radiusKm) : null) : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
      },
    });
    await logAdminAction(req.user?.userId, 'DELIVERY_ZONE_UPDATED', 'delivery', { id, name }, req);
    ResponseUtil.success(res, zone, 'تم تحديث منطقة التوصيل بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/delivery/zones/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.deliveryZone.delete({ where: { id } });
    await logAdminAction(req.user?.userId, 'DELIVERY_ZONE_DELETED', 'delivery', { id }, req);
    ResponseUtil.success(res, null, 'تم حذف منطقة التوصيل بنجاح');
  } catch (error) {
    next(error);
  }
});

router.get('/delivery/methods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const methods = await prisma.deliveryMethod.findMany({
      orderBy: { basePrice: 'asc' },
    });
    ResponseUtil.success(res, methods);
  } catch (error) {
    next(error);
  }
});

router.get('/delivery/rules', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rules = await prisma.deliveryRule.findMany({
      include: { deliveryZone: true, deliveryMethod: true },
      orderBy: { fee: 'asc' },
    });
    ResponseUtil.success(res, rules);
  } catch (error) {
    next(error);
  }
});

router.post('/delivery/rules', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { deliveryMethodId, deliveryZoneId, fee, freeDeliveryThreshold, pricePerKm, pricePerKg, isActive } = req.body;
    const rule = await prisma.deliveryRule.create({
      data: {
        deliveryMethodId,
        deliveryZoneId: deliveryZoneId || null,
        fee: fee ? parseFloat(fee) : 15.0,
        freeDeliveryThreshold: freeDeliveryThreshold ? parseFloat(freeDeliveryThreshold) : null,
        pricePerKm: pricePerKm ? parseFloat(pricePerKm) : null,
        pricePerKg: pricePerKg ? parseFloat(pricePerKg) : null,
        isActive: isActive !== undefined ? Boolean(isActive) : true,
      },
    });
    await logAdminAction(req.user?.userId, 'DELIVERY_RULE_CREATED', 'delivery', { id: rule.id }, req);
    ResponseUtil.created(res, rule, 'تم إنشاء قاعدة التوصيل بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/delivery/rules/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { fee, freeDeliveryThreshold, pricePerKm, pricePerKg, isActive } = req.body;
    const rule = await prisma.deliveryRule.update({
      where: { id },
      data: {
        fee: fee !== undefined ? parseFloat(fee) : undefined,
        freeDeliveryThreshold: freeDeliveryThreshold !== undefined ? (freeDeliveryThreshold ? parseFloat(freeDeliveryThreshold) : null) : undefined,
        pricePerKm: pricePerKm !== undefined ? (pricePerKm ? parseFloat(pricePerKm) : null) : undefined,
        pricePerKg: pricePerKg !== undefined ? (pricePerKg ? parseFloat(pricePerKg) : null) : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
      },
    });
    await logAdminAction(req.user?.userId, 'DELIVERY_RULE_UPDATED', 'delivery', { id }, req);
    ResponseUtil.success(res, rule, 'تم تحديث قاعدة التسعير بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/delivery/rules/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.deliveryRule.delete({ where: { id } });
    await logAdminAction(req.user?.userId, 'DELIVERY_RULE_DELETED', 'delivery', { id }, req);
    ResponseUtil.success(res, null, 'تم حذف قاعدة التسعير بنجاح');
  } catch (error) {
    next(error);
  }
});

router.get('/delivery/cities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cities = await prisma.city.findMany({
      orderBy: { nameAr: 'asc' },
    });
    ResponseUtil.success(res, cities);
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 8. ORDERS, CANCELLATIONS, RETURNS & REFUNDS MANAGEMENT
// ==============================================================================

// GET /orders — List all marketplace orders with filters
router.get('/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as OrderStatus;
    const search = (req.query.search as string)?.trim();

    const where: any = {};
    if (status && status !== ('ALL' as any)) {
      where.status = status;
    }

    if (search) {
      const cleanSearch = search.trim();
      const numMatch = cleanSearch.match(/\d+/);
      const seqSearch = numMatch ? parseInt(numMatch[0], 10) : undefined;

      const orConditions: any[] = [
        { id: cleanSearch },
        { orderNumber: { contains: cleanSearch, mode: 'insensitive' } },
        { displayOrderNumber: { contains: cleanSearch, mode: 'insensitive' } },
        { sellerOrders: { some: { sellerOrderNumber: { contains: cleanSearch, mode: 'insensitive' } } } },
        { sellerOrders: { some: { sellerId: cleanSearch } } },
        { user: { firstName: { contains: cleanSearch, mode: 'insensitive' } } },
        { user: { lastName: { contains: cleanSearch, mode: 'insensitive' } } },
        { user: { phone: { contains: cleanSearch, mode: 'insensitive' } } },
        { user: { email: { contains: cleanSearch, mode: 'insensitive' } } },
      ];
      if (seqSearch && !isNaN(seqSearch)) {
        orConditions.push({ orderSequence: seqSearch });
      }
      where.OR = orConditions;
    }

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
          sellerOrders: {
            include: {
              seller: { include: { stores: { select: { name: true } } } },
              items: true,
            },
          },
          payment: true,
          addressSnapshot: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      orders,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// GET /orders/:id — Single order full details for Admin
router.get('/orders/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);

    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { id },
          { orderNumber: id },
          { displayOrderNumber: id },
          { sellerOrders: { some: { sellerOrderNumber: id } } },
        ],
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, avatar: true } },
        sellerOrders: {
          include: {
            seller: { include: { stores: true, user: { select: { firstName: true, lastName: true, phone: true, email: true } } } },
            items: true,
            cancellationRequests: true,
            statusHistory: { orderBy: { createdAt: 'asc' } },
          },
        },
        payment: { include: { transactions: true } },
        addressSnapshot: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
        cancellationRequests: { orderBy: { createdAt: 'desc' } },
        returnRequests: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);
    ResponseUtil.success(res, order);
  } catch (error) {
    next(error);
  }
});

// POST /orders/:id/cancel — Admin cancels order with audit log
router.post('/orders/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason, note } = req.body;

    if (!reason) {
      throw new AppError('سبب إلغاء الطلب من قبل الإدارة مطلوب (CUSTOMER_REQUEST, SELLER_REQUEST, FRAUD, POLICY_VIOLATION, PAYMENT_ISSUE, SYSTEM_ERROR, OTHER)', 400);
    }

    const order = await prisma.order.findFirst({
      where: { OR: [{ id }, { orderNumber: id }] },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    const updated = await OrderStateMachine.transitionOrder({
      orderId: order.id,
      targetStatus: OrderStatus.CANCELLED_BY_ADMIN,
      changedBy: req.user!.userId,
      changedByRole: 'ADMIN',
      reason,
      note: note || `إلغاء الطلب من قبل الإدارة: ${reason}`,
    });

    await logAdminAction(req.user?.userId, 'ORDER_CANCELLED_BY_ADMIN', 'orders', { orderId: order.id, orderNumber: order.orderNumber, reason, note }, req);

    ResponseUtil.success(res, updated, 'تم إلغاء الطلب من قبل الإدارة وتحرير المخزون / استرداد المبلغ');
  } catch (error) {
    next(error);
  }
});

// GET /cancellations — List cancellation requests
router.get('/cancellations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as CancellationRequestStatus;

    const where: any = {};
    if (status) where.status = status;

    const [total, cancellations] = await Promise.all([
      prisma.cancellationRequest.count({ where }),
      prisma.cancellationRequest.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          order: {
            select: {
              orderNumber: true,
              total: true,
              user: { select: { id: true, firstName: true, lastName: true, phone: true } },
            },
          },
          sellerOrder: {
            include: {
              seller: { include: { stores: { select: { name: true } } } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      cancellations,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// POST /cancellations/:id/approve — Admin approves cancellation request
router.post('/cancellations/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { adminNote } = req.body;

    const cancelReq = await prisma.cancellationRequest.findUnique({
      where: { id },
      include: { order: true, sellerOrder: true },
    });

    if (!cancelReq) throw new AppError('طلب الإلغاء غير موجود', 404);

    await prisma.cancellationRequest.update({
      where: { id },
      data: {
        status: CancellationRequestStatus.APPROVED,
        resolvedBy: req.user!.userId,
        resolvedAt: new Date(),
        adminNote,
      },
    });

    if (cancelReq.sellerOrderId) {
      await OrderStateMachine.transitionSellerOrder({
        sellerOrderId: cancelReq.sellerOrderId,
        targetStatus: SellerOrderStatus.CANCELLED_BY_ADMIN,
        changedBy: req.user!.userId,
        changedByRole: 'ADMIN',
        reason: cancelReq.reason,
        note: adminNote || 'موافقة الإدارة على طلب الإلغاء',
      });
    } else {
      await OrderStateMachine.transitionOrder({
        orderId: cancelReq.orderId,
        targetStatus: OrderStatus.CANCELLED_BY_ADMIN,
        changedBy: req.user!.userId,
        changedByRole: 'ADMIN',
        reason: cancelReq.reason,
        note: adminNote || 'موافقة الإدارة على طلب الإلغاء',
      });
    }

    await logAdminAction(req.user?.userId, 'CANCELLATION_APPROVED', 'cancellation_requests', { id, orderId: cancelReq.orderId }, req);

    ResponseUtil.success(res, null, 'تمت الموافقة على طلب الإلغاء وتنفيذ الاسترداد المالي وتحرير المخزون');
  } catch (error) {
    next(error);
  }
});

// POST /cancellations/:id/reject — Admin rejects cancellation request
router.post('/cancellations/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { adminNote } = req.body;

    const cancelReq = await prisma.cancellationRequest.findUnique({
      where: { id },
      include: { order: true },
    });

    if (!cancelReq) throw new AppError('طلب الإلغاء غير موجود', 404);

    await prisma.cancellationRequest.update({
      where: { id },
      data: {
        status: CancellationRequestStatus.REJECTED,
        resolvedBy: req.user!.userId,
        resolvedAt: new Date(),
        adminNote: adminNote || 'رفض الطلب من قبل الإدارة',
      },
    });

    // Revert status to PROCESSING
    if (cancelReq.sellerOrderId) {
      await prisma.sellerOrder.update({
        where: { id: cancelReq.sellerOrderId },
        data: { status: SellerOrderStatus.PROCESSING },
      });
    }
    await prisma.order.update({
      where: { id: cancelReq.orderId },
      data: { status: OrderStatus.PROCESSING },
    });

    await logAdminAction(req.user?.userId, 'CANCELLATION_REJECTED', 'cancellation_requests', { id, orderId: cancelReq.orderId, note: adminNote }, req);

    ResponseUtil.success(res, null, 'تم رفض طلب الإلغاء واستئناف متابعة الطلب');
  } catch (error) {
    next(error);
  }
});

// GET /returns — List return requests
router.get('/returns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as ReturnRequestStatus;

    const where: any = {};
    if (status) where.status = status;

    const [total, returns] = await Promise.all([
      prisma.returnRequest.count({ where }),
      prisma.returnRequest.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          order: {
            select: {
              orderNumber: true,
              total: true,
              user: { select: { id: true, firstName: true, lastName: true, phone: true } },
            },
          },
          sellerOrder: {
            include: {
              seller: { include: { stores: { select: { name: true } } } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      returns,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// POST /returns/:id/approve — Admin approves return request
router.post('/returns/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { refundAmount } = req.body;

    const returnReq = await prisma.returnRequest.findUnique({
      where: { id },
      include: { order: true },
    });

    if (!returnReq) throw new AppError('طلب الإرجاع غير موجود', 404);

    const amount = refundAmount ? parseFloat(refundAmount) : returnReq.order.total;

    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: ReturnRequestStatus.APPROVED,
        refundAmount: amount,
        resolvedBy: req.user!.userId,
        resolvedAt: new Date(),
      },
    });

    await prisma.order.update({
      where: { id: returnReq.orderId },
      data: { status: OrderStatus.RETURN_APPROVED },
    });

    await logAdminAction(req.user?.userId, 'RETURN_APPROVED', 'return_requests', { id, orderId: returnReq.orderId, amount }, req);

    try {
      const socketSvc = SocketService.get();
      if (socketSvc) {
        socketSvc.emitGlobal('order:return_approved', {
          orderId: returnReq.orderId,
          returnRequestId: id,
          amount,
        });
        socketSvc.emitGlobal('order:status', {
          orderId: returnReq.orderId,
          status: 'RETURN_APPROVED',
        });
        socketSvc.emitGlobal('REFUND_APPROVED', {
          orderId: returnReq.orderId,
          returnRequestId: id,
        });
        socketSvc.emitGlobal('order:refund_updated', {
          orderId: returnReq.orderId,
          status: 'RETURN_APPROVED',
        });
      }
    } catch (_) {}

    ResponseUtil.success(res, null, 'تمت الموافقة على طلب الإرجاع بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /refunds/:id/process — Admin processes refund
router.post('/refunds/:id/process', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { amount, reason } = req.body;

    const order = await prisma.order.findFirst({
      where: { OR: [{ id }, { orderNumber: id }] },
      include: { payment: true },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    const refundAmount = amount ? parseFloat(amount) : order.total;

    const refund = await prisma.$transaction(async (tx) => {
      const ref = await tx.refund.create({
        data: {
          orderId: order.id,
          amount: refundAmount,
          reason: reason || 'استرداد مالي من قبل الإدارة',
          status: 'COMPLETED',
        },
      });

      await tx.payment.update({
        where: { orderId: order.id },
        data: { status: PaymentStatus.REFUNDED },
      });

      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.REFUNDED },
      });

      if (order.userId) {
        try {
          await CustomerWalletService.creditRefund(
            {
              customerId: order.userId,
              amount: refundAmount,
              refundId: ref.id,
              currency: 'YER',
              orderNumber: order.orderNumber,
              refundNumber: ref.id,
              adminUserId: req.user!.userId,
            },
            tx
          );
        } catch (_) {}
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: 'REFUNDED',
          status: OrderStatus.REFUNDED,
          changedBy: req.user!.userId,
          changedByRole: 'ADMIN',
          reason: reason || 'استرداد مالي من قبل الإدارة',
          note: `تم تنفيذ استرداد مالي بقيمة ${refundAmount} ر.ي`,
        },
      });

      return ref;
    });

    await logAdminAction(req.user?.userId, 'REFUND_PROCESSED', 'refunds', { orderId: order.id, refundAmount, reason }, req);

    try {
      const socketSvc = SocketService.get();
      if (socketSvc) {
        socketSvc.emitGlobal('order:status', {
          orderId: order.id,
          status: 'REFUNDED',
        });
        socketSvc.emitGlobal('REFUND_COMPLETED', {
          orderId: order.id,
          amount: refundAmount,
        });
        socketSvc.emitGlobal('refund:completed', {
          orderId: order.id,
          amount: refundAmount,
        });
        socketSvc.emitGlobal('order:refund_updated', {
          orderId: order.id,
          status: 'REFUNDED',
        });
      }
    } catch (_) {}

    ResponseUtil.success(res, refund, 'تم تنفيذ الاسترداد المالي بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 9. PAYMENTS, REFUNDS & DISPUTES
// ==============================================================================
router.get('/payments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const [total, payments] = await Promise.all([
      prisma.payment.count(),
      prisma.payment.findMany({
        skip: (page - 1) * limit,
        take: limit,
        include: {
          order: {
            include: { user: { select: { firstName: true, lastName: true, phone: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      payments,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// Debug endpoint: raw dispute count + first 5 records (no filters)
router.get('/disputes/debug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await prisma.dispute.count();
    const all = await prisma.dispute.findMany({ take: 5, orderBy: { createdAt: 'desc' } });
    ResponseUtil.success(res, { count, sample: all });
  } catch (error) {
    next(error);
  }
});

router.get('/disputes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as DisputeStatus;
    const search = (req.query.search as string)?.trim();

    // Ensure any RefundRequest in ADMIN_REVIEW or DISPUTED has a corresponding Dispute entry
    try {
      const pendingRefundDisputes = await prisma.refundRequest.findMany({
        where: {
          status: { in: [RefundStatus.ADMIN_REVIEW, RefundStatus.DISPUTED] },
        },
      });

      for (const r of pendingRefundDisputes) {
        const existing = await prisma.dispute.findFirst({
          where: {
            orderId: r.orderId,
            customerId: r.customerId,
            status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
          },
        });
        if (!existing) {
          await prisma.dispute.create({
            data: {
              customerId: r.customerId,
              sellerId: r.sellerId,
              orderId: r.orderId,
              reason: r.reasonText || 'نزاع على رفض طلب الاسترجاع',
              description: r.customerNote || r.description || 'طلب تدخل إدارة المنصة والتحكيم في رفض الاسترجاع',
              status: DisputeStatus.OPEN,
              refundAmount: Number(r.requestedAmount || 0),
              adminNotes: `تم تصعيد طلب الاسترجاع #${r.refundNumber} من العميل بعد مراجعة/رفض المتجر.`,
            },
          });
        }
      }
    } catch (_) {}

    const where: any = {};
    if (status) where.status = status;

    if (search) {
      where.OR = [
        { reason: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { orderId: { contains: search, mode: 'insensitive' } },
        { customer: { firstName: { contains: search, mode: 'insensitive' } } },
        { customer: { lastName: { contains: search, mode: 'insensitive' } } },
        { customer: { email: { contains: search, mode: 'insensitive' } } },
        { customer: { phone: { contains: search, mode: 'insensitive' } } },
        { seller: { stores: { some: { name: { contains: search, mode: 'insensitive' } } } } },
      ];
    }

    const [total, disputes] = await Promise.all([
      prisma.dispute.count({ where }),
      prisma.dispute.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatar: true } },
          seller: {
            include: {
              user: { select: { firstName: true, lastName: true, email: true, phone: true } },
              stores: { select: { id: true, name: true, logo: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Fetch order snapshots for these disputes if available
    const orderIds = disputes.map(d => d.orderId).filter(Boolean);
    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { id: { in: orderIds } },
          { orderNumber: { in: orderIds } },
        ],
      },
      select: {
        id: true,
        orderNumber: true,
        total: true,
        status: true,
        createdAt: true,
        sellerOrders: {
          include: {
            items: true,
          },
        },
        returnRequests: { orderBy: { createdAt: 'desc' } },
        refundRequests: {
          include: {
            evidence: true,
            items: true,
            reason: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    const orderMap = new Map(orders.map(o => [o.id, o]));
    orders.forEach(o => orderMap.set(o.orderNumber, o));

    const enrichedDisputes = disputes.map(d => {
      const order = orderMap.get(d.orderId) || null;
      const refReqs = (order?.refundRequests as any[]) || [];
      const retReqs = (order?.returnRequests as any[]) || [];
      const proofImages: string[] = [];
      refReqs.forEach((r: any) => {
        r.evidence?.forEach((ev: any) => {
          if (ev.fileUrl && !proofImages.includes(ev.fileUrl)) {
            proofImages.push(ev.fileUrl);
          }
        });
      });
      const resolvedReason = refReqs.find((r: any) => r.reasonText)?.reasonText ||
                             retReqs.find((r: any) => r.reason)?.reason ||
                             d.reason;
      return {
        ...d,
        reason: resolvedReason,
        proofImages,
        evidence: proofImages,
        order,
      };
    });

    ResponseUtil.success(res, {
      disputes: enrichedDisputes,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/disputes/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatar: true } },
        seller: {
          include: {
            user: { select: { firstName: true, lastName: true, email: true, phone: true } },
            stores: { select: { id: true, name: true, logo: true } },
          },
        },
      },
    });

    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id: dispute.orderId }, { orderNumber: dispute.orderId }],
      },
      include: {
        sellerOrders: { include: { items: true } },
        payment: true,
        addressSnapshot: true,
        returnRequests: { orderBy: { createdAt: 'desc' } },
        refundRequests: {
          include: {
            evidence: true,
            items: true,
            reason: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    const proofImages: string[] = [];
    (order?.refundRequests as any[])?.forEach((r: any) => {
      r.evidence?.forEach((ev: any) => {
        if (ev.fileUrl && !proofImages.includes(ev.fileUrl)) {
          proofImages.push(ev.fileUrl);
        }
      });
    });

    const resolvedReason = (order?.refundRequests as any[])?.find((r: any) => r.reasonText)?.reasonText ||
                           order?.returnRequests?.find((r: any) => r.reason)?.reason ||
                           dispute.reason;

    ResponseUtil.success(res, {
      ...dispute,
      reason: resolvedReason,
      proofImages,
      evidence: proofImages,
      order,
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/disputes/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { status, note } = req.body;
    if (!status) throw new AppError('حالة النزاع مطلوبة', 400);

    const existing = await prisma.dispute.findUnique({ where: { id } });
    if (!existing) throw new AppError('النزاع غير موجود', 404);

    let updatedNotes = existing.adminNotes || '';
    if (note && note.trim().length > 0) {
      const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
      updatedNotes = `${updatedNotes}\n[${timestamp}] تغيرت الحالة إلى ${status}: ${note.trim()}`.trim();
    }

    const dispute = await prisma.dispute.update({
      where: { id },
      data: {
        status: status as DisputeStatus,
        adminNotes: updatedNotes,
      },
    });

    await logAdminAction(req.user?.userId, 'DISPUTE_STATUS_CHANGED', 'disputes', { id, status, note }, req);
    ResponseUtil.success(res, dispute, 'تم تحديث حالة النزاع بنجاح');
  } catch (error) {
    next(error);
  }
});

router.post('/disputes/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { decision, resolution, refundAmount, note } = req.body;
    if (!resolution) throw new AppError('نص قرار النزاع والتسوية مطلوب', 400);

    const dispute = await prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    const parsedRefundAmount = refundAmount ? parseFloat(refundAmount) : 0.0;
    const finalDecision = decision || 'FULL_REFUND';
    const isRejected = finalDecision === 'REJECTED' || finalDecision === 'SELLER_FAVOR';
    const finalStatus = isRejected ? DisputeStatus.REJECTED : DisputeStatus.RESOLVED;

    let updatedNotes = dispute.adminNotes || '';
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    updatedNotes = `${updatedNotes}\n[${timestamp}] قرار الإدارة (${finalDecision}): ${resolution}`.trim();
    if (note) {
      updatedNotes = `${updatedNotes} - ملاحظة داخلية: ${note}`.trim();
    }

    const updatedDispute = await prisma.$transaction(async (tx) => {
      const d = await tx.dispute.update({
        where: { id },
        data: {
          status: finalStatus,
          decision: finalDecision,
          resolution,
          refundAmount: parsedRefundAmount > 0 ? parsedRefundAmount : null,
          adminNotes: updatedNotes,
        },
      });

      // If financial refund is granted, record Refund and deduct/adjust seller balance
      if (parsedRefundAmount > 0 && !isRejected) {
        await tx.refund.create({
          data: {
            orderId: dispute.orderId,
            amount: parsedRefundAmount,
            reason: `تسوية نزاع #${id}: ${resolution}`,
            status: 'COMPLETED',
          },
        });

        // Update order and seller order status to REFUNDED
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

        // Credit customer wallet if customerId exists
        if (dispute.customerId) {
          try {
            await CustomerWalletService.creditRefund(
              {
                customerId: dispute.customerId,
                amount: parsedRefundAmount,
                refundId: dispute.id,
                currency: 'YER',
                orderNumber: dispute.orderId,
                refundNumber: `DISPUTE-${dispute.id.substring(0, 8)}`,
                adminUserId: req.user!.userId,
              },
              tx
            );
          } catch (_) {}
        }

        // Adjust seller balance
        const balance = await tx.sellerBalance.findUnique({ where: { sellerId: dispute.sellerId } });
        if (balance) {
          await tx.sellerBalance.update({
            where: { sellerId: dispute.sellerId },
            data: {
              availableBalance: Math.max(0, balance.availableBalance - parsedRefundAmount),
            },
          });

          await tx.sellerTransaction.create({
            data: {
              sellerBalanceId: balance.id,
              amount: -parsedRefundAmount,
              type: 'REFUND',
              referenceId: dispute.orderId,
              description: `استرجاع مالي للعميل إثر تسوية نزاع (Dispute #${id})`,
            },
          });
        }
      }

      // Synchronize any related RefundRequest
      const relatedRefunds = await tx.refundRequest.findMany({
        where: {
          orderId: dispute.orderId,
          status: { in: [RefundStatus.ADMIN_REVIEW, RefundStatus.DISPUTED, RefundStatus.REQUESTED, RefundStatus.SELLER_REVIEW] },
        },
      });

      for (const rr of relatedRefunds) {
        const toStatus = isRejected ? RefundStatus.CLOSED : RefundStatus.REFUNDED;
        await tx.refundRequest.update({
          where: { id: rr.id },
          data: {
            status: toStatus,
            adminDecision: finalDecision,
            adminDecisionReason: resolution,
            resolvedAt: new Date(),
            approvedAmount: !isRejected && parsedRefundAmount > 0 ? parsedRefundAmount : undefined,
          },
        });

        await tx.refundStatusHistory.create({
          data: {
            refundRequestId: rr.id,
            fromStatus: rr.status,
            toStatus: toStatus,
            changedBy: req.user!.userId,
            actorType: RefundActorType.ADMIN,
            reason: `تسوية النزاع #${id}: ${resolution}`,
          },
        });
      }

      return d;
    });

    await logAdminAction(req.user?.userId, 'DISPUTE_RESOLVED', 'disputes', { id, decision: finalDecision, resolution, refundAmount: parsedRefundAmount }, req);

    try {
      const socketSvc = SocketService.get();
      if (socketSvc) {
        socketSvc.emitGlobal('dispute:resolved', {
          orderId: dispute.orderId,
          disputeId: dispute.id,
          decision: finalDecision,
          resolution,
          refundAmount: parsedRefundAmount,
          status: finalStatus,
        });
        socketSvc.emitGlobal('DISPUTE_RESOLVED', {
          orderId: dispute.orderId,
          disputeId: dispute.id,
          decision: finalDecision,
          resolution,
          refundAmount: parsedRefundAmount,
          status: finalStatus,
        });
        socketSvc.emitGlobal('order:status', {
          orderId: dispute.orderId,
          status: isRejected ? 'DELIVERED' : 'REFUNDED',
        });
        socketSvc.emitGlobal('order:refund_updated', {
          orderId: dispute.orderId,
          status: isRejected ? 'CLOSED' : 'REFUNDED',
        });
        socketSvc.emitGlobal('REFUND_COMPLETED', {
          orderId: dispute.orderId,
          amount: parsedRefundAmount,
        });
        socketSvc.emitGlobal('refund:completed', {
          orderId: dispute.orderId,
          amount: parsedRefundAmount,
        });
        socketSvc.emitGlobal('REFUND_ADMIN_DECISION', {
          orderId: dispute.orderId,
          decision: finalDecision,
          decisionReason: resolution,
          refundAmount: parsedRefundAmount,
          approvedAmount: parsedRefundAmount,
        });
        socketSvc.emitGlobal('refund:admin_decision', {
          orderId: dispute.orderId,
          decision: finalDecision,
          decisionReason: resolution,
          refundAmount: parsedRefundAmount,
          approvedAmount: parsedRefundAmount,
        });
        socketSvc.emitGlobal('refund:updated', {
          orderId: dispute.orderId,
          status: isRejected ? 'CLOSED' : 'REFUNDED',
        });
        socketSvc.emitGlobal('refund:status', {
          orderId: dispute.orderId,
          status: isRejected ? 'CLOSED' : 'REFUNDED',
        });

        if (dispute.customerId) {
          socketSvc.emitToUser(dispute.customerId, 'DISPUTE_RESOLVED', {
            orderId: dispute.orderId,
            disputeId: dispute.id,
            decision: finalDecision,
            resolution,
            refundAmount: parsedRefundAmount,
            status: finalStatus,
          });
          socketSvc.emitToUser(dispute.customerId, 'REFUND_ADMIN_DECISION', {
            orderId: dispute.orderId,
            decision: finalDecision,
            decisionReason: resolution,
            approvedAmount: parsedRefundAmount,
          });
          socketSvc.emitToUser(dispute.customerId, 'order:status', {
            orderId: dispute.orderId,
            status: isRejected ? 'DELIVERED' : 'REFUNDED',
          });
          socketSvc.emitToUser(dispute.customerId, 'order:refund_updated', {
            orderId: dispute.orderId,
            status: isRejected ? 'CLOSED' : 'REFUNDED',
          });
        }
      }
    } catch (_) {}

    ResponseUtil.success(res, updatedDispute, 'تم إصدار قرار النزاع وتسجيله بنجاح');
  } catch (error) {
    next(error);
  }
});

router.post('/disputes/:id/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { note } = req.body;
    if (!note || !note.trim()) throw new AppError('نص الملاحظة مطلوب', 400);

    const dispute = await prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const updatedNotes = `${dispute.adminNotes || ''}\n[${timestamp}] ملاحظة المشرف: ${note.trim()}`.trim();

    const updated = await prisma.dispute.update({
      where: { id },
      data: { adminNotes: updatedNotes },
    });

    ResponseUtil.success(res, updated, 'تمت إضافة الملاحظة الداخلية بنجاح');
  } catch (error) {
    next(error);
  }
});

router.get('/finance/refunds-ledger', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const [total, refunds] = await Promise.all([
      prisma.refund.count(),
      prisma.refund.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      refunds,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 10. FINANCE, COMMISSION & WITHDRAWALS
// ==============================================================================
router.get('/finance/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      totalVolume,
      totalCommissions,
      pendingPayouts,
      completedWithdrawals,
      pendingWithdrawalsCount,
      pendingDepositsCount,
      approvedDepositsResult,
      outstandingResult,
      openOutstandingsCount,
    ] = await Promise.all([
      prisma.order.aggregate({ _sum: { total: true } }),
      prisma.sellerOrder.aggregate({ _sum: { commissionAmount: true } }),
      prisma.sellerBalance.aggregate({ _sum: { availableBalance: true, pendingBalance: true } }),
      prisma.withdrawal.aggregate({
        where: { status: WithdrawalStatus.COMPLETED },
        _sum: { amount: true },
      }),
      prisma.withdrawal.count({ where: { status: WithdrawalStatus.PENDING } }),
      prisma.walletDeposit.count({ where: { status: 'PENDING' } }).catch(() => 0),
      prisma.walletDeposit.aggregate({ where: { status: 'APPROVED' }, _sum: { amount: true } }).catch(() => ({ _sum: { amount: 0 } })),
      prisma.sellerOutstanding.aggregate({
        where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
        _sum: { remainingAmount: true },
      }).catch(() => ({ _sum: { remainingAmount: 0 } })),
      prisma.sellerOutstanding.count({
        where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
      }).catch(() => 0),
    ]);

    ResponseUtil.success(res, {
      totalVolume: totalVolume._sum.total || 0,
      totalCommissions: totalCommissions._sum.commissionAmount || 0,
      totalAvailableBalance: pendingPayouts._sum.availableBalance || 0,
      totalPendingBalance: pendingPayouts._sum.pendingBalance || 0,
      totalWithdrawn: completedWithdrawals._sum.amount || 0,
      pendingWithdrawals: pendingWithdrawalsCount,
      pendingDeposits: pendingDepositsCount,
      totalDeposits: approvedDepositsResult._sum.amount || 0,
      totalOutstanding: outstandingResult._sum.remainingAmount || 0,
      openOutstandingsCount,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/withdrawals', requirePermission('finance:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as WithdrawalStatus;

    const where: any = {};
    if (status) where.status = status;

    const [total, withdrawals] = await Promise.all([
      prisma.withdrawal.count({ where }),
      prisma.withdrawal.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          seller: {
            include: {
              user: { select: { firstName: true, lastName: true, phone: true, email: true } },
              stores: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      withdrawals,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/withdrawals/:id/approve', requirePermission('finance:withdrawals'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { adminNote } = req.body;

    const withdrawal = await prisma.withdrawal.update({
      where: { id },
      data: { status: WithdrawalStatus.APPROVED, adminNote },
      include: { seller: { select: { id: true, userId: true } } },
    });

    if (withdrawal.seller?.userId) {
      SocketService.get()?.emitToUser(withdrawal.seller.userId, 'withdrawal:updated', {
        withdrawalId: withdrawal.id,
        sellerId: withdrawal.sellerId,
        status: 'APPROVED',
        rawStatus: 'APPROVED',
        adminNote,
      });
      SocketService.get()?.emitToUser(withdrawal.seller.userId, 'seller:finance_updated', {
        withdrawalId: withdrawal.id,
        sellerId: withdrawal.sellerId,
        status: 'APPROVED',
      });
    }

    SocketService.get()?.emitGlobal('withdrawal:updated', {
      withdrawalId: withdrawal.id,
      sellerId: withdrawal.sellerId,
      status: 'APPROVED',
    });

    await logAdminAction(req.user?.userId, 'WITHDRAWAL_APPROVED', 'withdrawals', { id, adminNote }, req);
    ResponseUtil.success(res, withdrawal, 'تمت الموافقة على طلب السحب');
  } catch (error) {
    next(error);
  }
});

router.post('/withdrawals/:id/complete', requirePermission('finance:withdrawals'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { referenceId, externalRef, proofImageUrl, adminNote } = req.body;
    const finalRef = externalRef || referenceId || null;

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.withdrawal.findUnique({ where: { id } });
      if (!existing) throw new AppError('طلب السحب غير موجود', 404);
      if (existing.status === WithdrawalStatus.COMPLETED) {
        throw new AppError('طلب السحب مكتمل بالفعل', 400);
      }

      const w = await tx.withdrawal.update({
        where: { id },
        data: {
          status: WithdrawalStatus.COMPLETED,
          adminNote: adminNote || null,
          proofImageUrl: proofImageUrl || null,
          externalRef: finalRef,
          completedAt: new Date(),
        },
      });

      // Update seller balance: decrement pending, increment withdrawn
      const balance = await tx.sellerBalance.findUnique({ where: { sellerId: w.sellerId } });
      if (balance) {
        await tx.sellerBalance.update({
          where: { sellerId: w.sellerId },
          data: {
            pendingBalance: Math.max(0, balance.pendingBalance - w.amount),
            withdrawnBalance: balance.withdrawnBalance + w.amount,
          },
        });
      }

      // Notify seller via centralized notification platform
      const seller = await tx.seller.findUnique({ where: { id: w.sellerId }, select: { userId: true } });
      if (seller?.userId) {
        try {
          notificationEventBus.publish(
            NotificationEventFactory.walletEvent({
              eventType: 'WALLET_TRANSFER_COMPLETED',
              recipientId: seller.userId,
              amount: w.amount,
              currency: w.currency,
              referenceId: w.id,
              description: `تحويل إلى ${w.walletProvider || w.bankName || 'حسابك'}`,
            })
          );
        } catch (_) {}
      }

      return { w, sellerUserId: seller?.userId };
    });

    // Real-time WebSocket event emission
    if (result.sellerUserId) {
      SocketService.get()?.emitToUser(result.sellerUserId, 'withdrawal:updated', {
        withdrawalId: result.w.id,
        sellerId: result.w.sellerId,
        status: 'COMPLETED',
        rawStatus: 'COMPLETED',
        amount: result.w.amount,
        currency: result.w.currency,
        proofImageUrl,
        externalRef: finalRef,
        adminNote,
        completedAt: result.w.completedAt,
      });

      SocketService.get()?.emitToUser(result.sellerUserId, 'withdrawal:completed', {
        withdrawalId: result.w.id,
        sellerId: result.w.sellerId,
        status: 'COMPLETED',
        amount: result.w.amount,
        currency: result.w.currency,
        proofImageUrl,
        externalRef: finalRef,
      });

      SocketService.get()?.emitToUser(result.sellerUserId, 'seller:finance_updated', {
        withdrawalId: result.w.id,
        sellerId: result.w.sellerId,
        status: 'COMPLETED',
      });
    }

    SocketService.get()?.emitGlobal('withdrawal:updated', {
      withdrawalId: result.w.id,
      sellerId: result.w.sellerId,
      status: 'COMPLETED',
      proofImageUrl,
      externalRef: finalRef,
    });

    await logAdminAction(req.user?.userId, 'WITHDRAWAL_COMPLETED', 'withdrawals', { id, referenceId: finalRef }, req);
    ResponseUtil.success(res, result.w, 'تم تأكيد تحويل الأرباح بنجاح');
  } catch (error) {
    next(error);
  }
});

router.post('/withdrawals/:id/reject', requirePermission('finance:withdrawals'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason } = req.body;
    if (!reason) throw new AppError('سبب رفض السحب مطلوب', 400);

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.withdrawal.findUnique({ where: { id } });
      if (!existing) throw new AppError('طلب السحب غير موجود', 404);
      if (existing.status === WithdrawalStatus.COMPLETED) {
        throw new AppError('لا يمكن رفض طلب تم إكماله مسبقاً', 400);
      }

      const w = await tx.withdrawal.update({
        where: { id },
        data: {
          status: WithdrawalStatus.REJECTED,
          adminNote: reason,
          rejectionReason: reason,
        },
      });

      // Restore balance to seller: increment available, decrement pending
      const balance = await tx.sellerBalance.findUnique({ where: { sellerId: w.sellerId } });
      if (balance) {
        await tx.sellerBalance.update({
          where: { sellerId: w.sellerId },
          data: {
            availableBalance: balance.availableBalance + w.amount,
            pendingBalance: Math.max(0, balance.pendingBalance - w.amount),
          },
        });

        await tx.sellerTransaction.create({
          data: {
            sellerBalanceId: balance.id,
            amount: w.amount,
            type: 'REFUND',
            referenceId: w.id,
            description: `إعادة رصيد طلب سحب مرفوض: ${reason}`,
          },
        });
      }

      // Notify seller via centralized notification platform
      const seller = await tx.seller.findUnique({ where: { id: w.sellerId }, select: { userId: true } });
      if (seller?.userId) {
        try {
          notificationEventBus.publish(
            NotificationEventFactory.walletEvent({
              eventType: 'WALLET_TRANSFER_FAILED',
              recipientId: seller.userId,
              amount: w.amount,
              currency: w.currency,
              referenceId: w.id,
              description: reason,
            })
          );
        } catch (_) {}
      }

      return { w, sellerUserId: seller?.userId };
    });

    // Real-time WebSocket event emission
    if (result.sellerUserId) {
      SocketService.get()?.emitToUser(result.sellerUserId, 'withdrawal:updated', {
        withdrawalId: result.w.id,
        sellerId: result.w.sellerId,
        status: 'REJECTED',
        rawStatus: 'REJECTED',
        amount: result.w.amount,
        currency: result.w.currency,
        reason,
        rejectionReason: reason,
      });

      SocketService.get()?.emitToUser(result.sellerUserId, 'withdrawal:rejected', {
        withdrawalId: result.w.id,
        sellerId: result.w.sellerId,
        status: 'REJECTED',
        amount: result.w.amount,
        currency: result.w.currency,
        reason,
      });

      SocketService.get()?.emitToUser(result.sellerUserId, 'seller:finance_updated', {
        withdrawalId: result.w.id,
        sellerId: result.w.sellerId,
        status: 'REJECTED',
      });
    }

    SocketService.get()?.emitGlobal('withdrawal:updated', {
      withdrawalId: result.w.id,
      sellerId: result.w.sellerId,
      status: 'REJECTED',
      reason,
    });

    await logAdminAction(req.user?.userId, 'WITHDRAWAL_REJECTED', 'withdrawals', { id, reason }, req);
    ResponseUtil.success(res, result.w, 'تم رفض طلب السحب وإعادة المبلغ لرصيد التاجر');
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// CUSTOMER WALLET WITHDRAWALS (SouqnaaPay → Yemeni Digital Wallets)
// ──────────────────────────────────────────────────────────────────────────

// GET /api/v1/admin/customer-withdrawals
router.get('/customer-withdrawals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status && status !== 'ALL') where.status = status;

    const [total, withdrawals] = await Promise.all([
      prisma.customerWalletWithdrawal.count({ where }),
      prisma.customerWalletWithdrawal.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
            },
          },
        },
      }),
    ]);

    ResponseUtil.success(res, { withdrawals, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/customer-withdrawals/:id/approve
router.post('/customer-withdrawals/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { adminNote } = req.body;
    const updated = await prisma.customerWalletWithdrawal.update({
      where: { id },
      data: { status: 'APPROVED', adminNote: adminNote || null, assignedAdminId: req.user!.userId },
    });

    SocketService.get()?.emitToUser(updated.userId, 'customer:withdrawal_updated', {
      withdrawalId: updated.id,
      status: 'APPROVED',
      rawStatus: 'APPROVED',
      adminNote: updated.adminNote,
    });
    SocketService.get()?.emitToUser(updated.userId, 'customer:withdrawal_approved', {
      withdrawalId: updated.id,
      status: 'APPROVED',
      adminNote: updated.adminNote,
    });
    SocketService.get()?.emitToUser(updated.userId, 'customer:wallet_updated', {
      withdrawalId: updated.id,
      status: 'APPROVED',
    });
    SocketService.get()?.emitGlobal('admin:customer_withdrawal_updated', updated);
    SocketService.get()?.emitGlobal('customer:withdrawal_updated', updated);

    await logAdminAction(req.user?.userId, 'CUSTOMER_WITHDRAWAL_APPROVED', 'customer_withdrawals', { id, adminNote }, req);
    ResponseUtil.success(res, updated, 'تمت الموافقة على طلب السحب');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/customer-withdrawals/:id/complete
router.post('/customer-withdrawals/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { proofImageUrl, externalRef, adminNote } = req.body;
    if (!proofImageUrl) throw new AppError('صورة إثبات التحويل مطلوبة', 400);
    const result = await CustomerWalletService.adminCompleteWithdrawal({
      withdrawalId: id, adminUserId: req.user!.userId, proofImageUrl, externalRef, adminNote,
    });

    SocketService.get()?.emitToUser(result.userId, 'customer:withdrawal_updated', {
      withdrawalId: result.id,
      status: 'COMPLETED',
      rawStatus: 'COMPLETED',
      amount: result.amount,
      currency: result.currency,
      proofImageUrl: result.proofImageUrl,
      externalRef: result.externalRef,
      adminNote: result.adminNote,
      completedAt: result.completedAt,
    });
    SocketService.get()?.emitToUser(result.userId, 'customer:withdrawal_completed', {
      withdrawalId: result.id,
      status: 'COMPLETED',
      amount: result.amount,
      currency: result.currency,
      proofImageUrl: result.proofImageUrl,
      externalRef: result.externalRef,
    });
    SocketService.get()?.emitToUser(result.userId, 'customer:wallet_updated', {
      withdrawalId: result.id,
      status: 'COMPLETED',
    });
    SocketService.get()?.emitGlobal('admin:customer_withdrawal_updated', result);
    SocketService.get()?.emitGlobal('customer:withdrawal_updated', result);

    await logAdminAction(req.user?.userId, 'CUSTOMER_WITHDRAWAL_COMPLETED', 'customer_withdrawals', { id, externalRef }, req);
    ResponseUtil.success(res, result, 'تم إتمام التحويل بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/customer-withdrawals/:id/reject
router.post('/customer-withdrawals/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;
    if (!reason) throw new AppError('سبب الرفض مطلوب', 400);
    const result = await CustomerWalletService.adminRejectWithdrawal({
      withdrawalId: id, adminUserId: req.user!.userId, reason,
    });

    SocketService.get()?.emitToUser(result.userId, 'customer:withdrawal_updated', {
      withdrawalId: result.id,
      status: 'REJECTED',
      rawStatus: 'REJECTED',
      amount: result.amount,
      currency: result.currency,
      reason: result.rejectionReason,
      rejectionReason: result.rejectionReason,
    });
    SocketService.get()?.emitToUser(result.userId, 'customer:withdrawal_rejected', {
      withdrawalId: result.id,
      status: 'REJECTED',
      amount: result.amount,
      currency: result.currency,
      reason: result.rejectionReason,
    });
    SocketService.get()?.emitToUser(result.userId, 'customer:wallet_updated', {
      withdrawalId: result.id,
      status: 'REJECTED',
    });
    SocketService.get()?.emitGlobal('admin:customer_withdrawal_updated', result);
    SocketService.get()?.emitGlobal('customer:withdrawal_updated', result);

    await logAdminAction(req.user?.userId, 'CUSTOMER_WITHDRAWAL_REJECTED', 'customer_withdrawals', { id, reason }, req);
    ResponseUtil.success(res, result, 'تم رفض طلب السحب');
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/admin/deposits ──────────────────────────────────────────────
router.get('/deposits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const status = req.query.status as any;
    const userType = req.query.userType as any;
    const search = req.query.search as string | undefined;

    const where: any = {};
    if (status && status !== 'ALL') {
      where.status = status;
    }
    if (userType && userType !== 'ALL') {
      where.userType = userType;
    }
    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { transferReference: { contains: q, mode: 'insensitive' } },
        { senderName: { contains: q, mode: 'insensitive' } },
        { senderPhone: { contains: q } },
        { user: { firstName: { contains: q, mode: 'insensitive' } } },
        { user: { lastName: { contains: q, mode: 'insensitive' } } },
        { user: { phone: { contains: q } } },
      ];
    }

    const [total, deposits] = await Promise.all([
      prisma.walletDeposit.count({ where }),
      prisma.walletDeposit.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
              avatar: true,
            },
          },
          seller: {
            include: {
              stores: {
                select: { id: true, name: true, logo: true },
              },
            },
          },
          reviewedByAdmin: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
    ]);

    ResponseUtil.success(res, {
      deposits,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/deposits/:id/approve ──────────────────────────────────
router.post('/deposits/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { adminNote } = req.body;

    const deposit = await prisma.walletDeposit.findUnique({
      where: { id },
      include: { user: true, seller: true },
    });
    if (!deposit) throw new AppError('طلب الإيداع غير موجود', 404);
    if (deposit.status !== 'PENDING') throw new AppError('تم البت في هذا الطلب مسبقاً', 400);

    const updated = await prisma.$transaction(async (tx) => {
      const lockResult = await tx.walletDeposit.updateMany({
        where: { id: deposit.id, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          reviewedByAdminId: req.user!.userId,
          reviewedAt: new Date(),
          completedAt: new Date(),
          adminNote: adminNote || 'تم التحقق من الحوالة وتأكيد الإيداع بنجاح',
        },
      });

      if (lockResult.count === 0) {
        throw new AppError('تم البت في هذا الطلب مسبقاً أو تمت معالجته بالتزامن من قبل مسؤول آخر.', 409, 'DEPOSIT_ALREADY_PROCESSED');
      }

      const dep = await tx.walletDeposit.findUniqueOrThrow({
        where: { id: deposit.id },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
          seller: { include: { stores: { select: { id: true, name: true } } } },
        },
      });

      if (deposit.userType === 'CUSTOMER') {
        let account = await tx.walletAccount.findUnique({ where: { userId: deposit.userId } });
        if (!account) {
          account = await tx.walletAccount.create({
            data: { userId: deposit.userId, currency: 'YER', availableBalance: 0, pendingBalance: 0 },
          });
        }

        const before = account.availableBalance;
        const after = before + deposit.amount;

        await tx.walletAccount.update({
          where: { id: account.id },
          data: { availableBalance: { increment: deposit.amount } },
        });

        await tx.walletLedgerEntry.create({
          data: {
            walletAccountId: account.id,
            type: 'ADJUSTMENT_CREDIT',
            direction: 'CREDIT',
            amount: deposit.amount,
            currency: deposit.currency,
            balanceBefore: before,
            balanceAfter: after,
            referenceType: 'DEPOSIT',
            referenceId: deposit.id,
            status: 'COMPLETED',
            description: `شحن رصيد المحفظة عبر ${deposit.walletProvider} - مرجع: ${deposit.transferReference}`,
            createdBy: req.user!.userId,
          },
        });

        await tx.walletTransaction.create({
          data: {
            walletAccountId: account.id,
            type: 'ADJUSTMENT_CREDIT',
            status: 'COMPLETED',
            amount: deposit.amount,
            currency: deposit.currency,
            referenceNumber: `DEP-${deposit.id.slice(0, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
            externalReference: deposit.transferReference,
            description: `شحن رصيد المحفظة عبر ${deposit.walletProvider} - مرجع: ${deposit.transferReference}`,
            completedAt: new Date(),
          },
        });
      } else if (deposit.userType === 'SELLER' && deposit.sellerId) {
        const approvedAmount = req.body.approvedAmount !== undefined ? parseFloat(String(req.body.approvedAmount)) : undefined;
        const approvalRes = await SellerFinancialRiskService.approveSellerDeposit(tx, {
          depositId: deposit.id,
          adminUserId: req.user!.userId,
          approvedAmount,
          adminNote: adminNote || 'تم التحقق من الحوالة وتأكيد الإيداع وسداد المديونية بنجاح',
        });
        return approvalRes.deposit;
      }

      // Notify user via centralized notification platform
      try {
        notificationEventBus.publish(
          NotificationEventFactory.walletEvent({
            eventType: 'WALLET_TOPUP_APPROVED',
            recipientId: deposit.userId,
            amount: deposit.amount,
            currency: 'YER',
            referenceId: deposit.id,
          })
        );
      } catch (_) {}

      return dep;
    });

    if (deposit.userType === 'CUSTOMER') {
      SocketService.get()?.emitToUser(deposit.userId, 'customer:deposit_approved', updated);
      SocketService.get()?.emitToUser(deposit.userId, 'customer:wallet_updated', { depositId: deposit.id });
      SocketService.get()?.emitToUser(deposit.userId, 'wallet:updated', { depositId: deposit.id });
      SocketService.get()?.emitGlobal('customer:deposit_approved', updated);
      SocketService.get()?.emitGlobal('deposit:approved', updated);
      SocketService.get()?.emitGlobal('deposit:completed', updated);
      SocketService.get()?.emitGlobal('customer:wallet_updated', { userId: deposit.userId, depositId: deposit.id });
      SocketService.get()?.emitGlobal('wallet:updated', { userId: deposit.userId, depositId: deposit.id });
    } else {
      SocketService.get()?.emitToUser(deposit.userId, 'seller:deposit_approved', updated);
      SocketService.get()?.emitToUser(deposit.userId, 'seller:balance_updated', { depositId: deposit.id });
      SocketService.get()?.emitGlobal('seller:deposit_approved', updated);
      SocketService.get()?.emitGlobal('seller:balance_updated', { sellerId: deposit.sellerId, depositId: deposit.id });
    }
    SocketService.get()?.emitGlobal('admin:deposit_updated', updated);
    SocketService.get()?.emitGlobal('deposit:updated', updated);

    await logAdminAction(req.user?.userId, 'WALLET_DEPOSIT_APPROVED', 'wallet_deposits', { id, amount: deposit.amount }, req);
    ResponseUtil.success(res, updated, 'تم اعتماد وتأكيد طلب شحن المحفظة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/deposits/:id/reject ───────────────────────────────────
router.post('/deposits/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason, adminNote } = req.body;

    const deposit = await prisma.walletDeposit.findUnique({
      where: { id },
      include: { user: true, seller: true },
    });
    if (!deposit) throw new AppError('طلب الإيداع غير موجود', 404);
    if (deposit.status !== 'PENDING') throw new AppError('تم البت في هذا الطلب مسبقاً', 400);

    const rejectionReason = reason || 'تعذر التحقق من الحوالة البنكية أو بيانات السند غير متطابقة';

    const updated = await prisma.$transaction(async (tx) => {
      const lockResult = await tx.walletDeposit.updateMany({
        where: { id: deposit.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          rejectionReason,
          adminNote: adminNote || null,
          reviewedByAdminId: req.user!.userId,
          reviewedAt: new Date(),
        },
      });

      if (lockResult.count === 0) {
        throw new AppError('تم البت في هذا الطلب مسبقاً أو تمت معالجته بالتزامن من قبل مسؤول آخر.', 409, 'DEPOSIT_ALREADY_PROCESSED');
      }

      const dep = await tx.walletDeposit.findUniqueOrThrow({
        where: { id: deposit.id },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
          seller: { include: { stores: { select: { id: true, name: true } } } },
        },
      });

      // Notify user via centralized notification platform
      try {
        notificationEventBus.publish(
          NotificationEventFactory.walletEvent({
            eventType: 'WALLET_TOPUP_REJECTED',
            recipientId: deposit.userId,
            amount: deposit.amount,
            currency: 'YER',
            referenceId: deposit.id,
            description: rejectionReason,
          })
        );
      } catch (_) {}

      return dep;
    });

    if (deposit.userType === 'CUSTOMER') {
      SocketService.get()?.emitToUser(deposit.userId, 'customer:deposit_rejected', updated);
      SocketService.get()?.emitToUser(deposit.userId, 'customer:wallet_updated', { depositId: deposit.id });
      SocketService.get()?.emitGlobal('customer:deposit_rejected', updated);
      SocketService.get()?.emitGlobal('deposit:rejected', updated);
      SocketService.get()?.emitGlobal('customer:wallet_updated', { userId: deposit.userId, depositId: deposit.id });
      SocketService.get()?.emitGlobal('wallet:updated', { userId: deposit.userId, depositId: deposit.id });
    } else {
      SocketService.get()?.emitToUser(deposit.userId, 'seller:deposit_rejected', updated);
      SocketService.get()?.emitToUser(deposit.userId, 'seller:balance_updated', { depositId: deposit.id });
      SocketService.get()?.emitGlobal('seller:deposit_rejected', updated);
      SocketService.get()?.emitGlobal('seller:balance_updated', { sellerId: deposit.sellerId, depositId: deposit.id });
    }
    SocketService.get()?.emitGlobal('admin:deposit_updated', updated);
    SocketService.get()?.emitGlobal('deposit:updated', updated);

    await logAdminAction(req.user?.userId, 'WALLET_DEPOSIT_REJECTED', 'wallet_deposits', { id, rejectionReason }, req);
    ResponseUtil.success(res, updated, 'تم رفض طلب شحن المحفظة');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/sellers/:id/financial-unblock ───────────────────────────
router.post('/sellers/:id/financial-unblock', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      throw new AppError('سبب رفع التقييد المالي مطلوب إجبارياً', 400);
    }
    const unblocked = await SellerFinancialRiskService.manualAdminUnblock(
      req.user!.userId,
      id,
      reason
    );
    ResponseUtil.success(res, unblocked, 'تم رفع التقييد المالي عن حساب البائع بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/admin/sellers/:id/financial-standing ───────────────────────────
router.get('/sellers/:id/financial-standing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const standing = await SellerFinancialRiskService.getSellerFinancialStanding(id);
    ResponseUtil.success(res, standing);
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/admin/sellers-financial-risk ───────────────────────────────────
router.get('/sellers-financial-risk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filter } = req.query;
    const where: any = {};
    if (filter === 'RESTRICTED') {
      where.isFinanciallyRestricted = true;
    } else if (filter === 'WARNING') {
      where.financialRestrictionLevel = { in: ['WARNING', 'CRITICAL'] };
    }
    const sellers: any = await prisma.seller.findMany({
      where,
      include: {
        stores: { select: { id: true, name: true, logo: true } },
        user: { select: { firstName: true, lastName: true, phone: true, email: true } },
        balance: true,
        outstandings: {
          orderBy: { createdAt: 'desc' },
        },
        sellerOrders: {
          select: {
            id: true,
            subtotal: true,
            commissionAmount: true,
            sellerPayout: true,
            status: true,
            order: {
              select: {
                orderNumber: true,
                createdAt: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const thresholds = await SellerFinancialRiskService.getRiskThresholds();
    const result = sellers.map((s: any) => {
      const openOutstandings = s.outstandings.filter((o: any) => o.status === 'OPEN' || o.status === 'PARTIALLY_PAID');
      const outstandingSum = openOutstandings.reduce((sum: number, o: any) => sum + o.remainingAmount, 0);
      const totalSales = s.sellerOrders.reduce((sum: number, so: any) => sum + (so.subtotal || 0), 0);
      const totalCommission = s.sellerOrders.reduce((sum: number, so: any) => sum + (so.commissionAmount || 0), 0);
      const totalPayout = s.sellerOrders.reduce((sum: number, so: any) => sum + (so.sellerPayout || 0), 0);
      const storeName = s.stores[0]?.name || (s.user ? `${s.user.firstName || ''} ${s.user.lastName || ''}`.trim() : '') || 'متجر سوقنا';

      return {
        id: s.id,
        userId: s.userId,
        storeName,
        storeLogo: s.stores[0]?.logo || null,
        ownerName: `${s.user?.firstName || ''} ${s.user?.lastName || ''}`.trim(),
        phone: s.user?.phone || 'غير مسجل',
        email: s.user?.email,
        status: s.status,
        commissionRate: s.commissionRate !== null && s.commissionRate !== undefined ? s.commissionRate : 0.10,
        totalSales,
        totalCommission,
        totalPayout,
        ordersCount: s.sellerOrders.length,
        cashOnDeliveryEnabled: s.cashOnDeliveryEnabled,
        isFinanciallyRestricted: s.isFinanciallyRestricted,
        financialRestrictionLevel: s.financialRestrictionLevel || 'NORMAL',
        financialRestrictionReason: s.financialRestrictionReason,
        availableBalance: s.balance?.availableBalance || 0,
        pendingBalance: s.balance?.pendingBalance || 0,
        outstandingCommission: outstandingSum,
        amountNeededToUnblock: Math.max(0, outstandingSum - thresholds.unblockThreshold),
        openOutstandingsCount: openOutstandings.length,
        allOutstandingsCount: s.outstandings.length,
        allOutstandings: s.outstandings.map((o: any) => ({
          id: o.id,
          sourceType: o.sourceType,
          sourceReference: o.sourceReference,
          amount: o.amount,
          paidAmount: o.paidAmount,
          remainingAmount: o.remainingAmount,
          currency: o.currency,
          status: o.status,
          warningLevel: o.warningLevel,
          createdAt: o.createdAt,
        })),
        recentOrders: s.sellerOrders.slice(0, 15).map((so: any) => ({
          id: so.id,
          orderNumber: so.order?.orderNumber || '—',
          subtotal: so.subtotal || 0,
          commissionAmount: so.commissionAmount || 0,
          sellerPayout: so.sellerPayout || 0,
          paymentMethod: so.order?.paymentMethod || 'COD',
          status: so.status,
          createdAt: so.order?.createdAt,
        })),
      };
    });

    ResponseUtil.success(res, {
      sellers: result,
      thresholds,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/finance/commissions', requirePermission('finance:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [defaultSetting, categories, sellers, products] = await Promise.all([
      prisma.systemSetting.findUnique({ where: { key: 'default_commission_rate' } }),
      prisma.category.findMany({
        where: { isActive: true },
        select: { id: true, nameAr: true, nameEn: true, icon: true, image: true, commissionRate: true },
        orderBy: { nameAr: 'asc' },
      }),
      prisma.seller.findMany({
        select: {
          id: true,
          commissionRate: true,
          status: true,
          user: { select: { firstName: true, lastName: true, email: true, phone: true } },
          stores: { select: { id: true, name: true, logo: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.product.findMany({
        where: { commissionRate: { not: null } },
        select: {
          id: true,
          nameAr: true,
          nameEn: true,
          price: true,
          commissionRate: true,
          store: { select: { name: true } },
          category: { select: { nameAr: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const defaultRate = defaultSetting ? parseFloat(defaultSetting.value) : 0.10; // 10% default

    ResponseUtil.success(res, {
      defaultRate,
      categories,
      sellers,
      products,
    });
  } catch (error) {
    next(error);
  }
});

router.put('/finance/commissions/category/:categoryId', requirePermission('finance:commissions'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const categoryId = String(req.params.categoryId);
    const { commissionRate } = req.body;
    const rate = commissionRate !== null && commissionRate !== undefined && commissionRate !== '' ? parseFloat(commissionRate) : null;

    const updated = await prisma.category.update({
      where: { id: categoryId },
      data: { commissionRate: rate },
    });

    await logAdminAction(req.user?.userId, 'CATEGORY_COMMISSION_UPDATED', 'categories', { categoryId, commissionRate: rate }, req);
    ResponseUtil.success(res, updated, 'تم تحديث نسبة عمولة القسم بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/finance/commissions/seller/:sellerId', requirePermission('finance:commissions'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = String(req.params.sellerId);
    const { commissionRate } = req.body;
    const rate = commissionRate !== null && commissionRate !== undefined && commissionRate !== '' ? parseFloat(commissionRate) : null;

    const updated = await prisma.seller.update({
      where: { id: sellerId },
      data: { commissionRate: rate !== null ? rate : 0.10 },
    });

    await logAdminAction(req.user?.userId, 'COMMISSION_RATE_UPDATED', 'sellers', { sellerId, commissionRate: rate }, req);
    ResponseUtil.success(res, updated, 'تم تحديث نسبة عمولة التاجر بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/finance/commissions/product/:productId', requirePermission('finance:commissions'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = String(req.params.productId);
    const { commissionRate } = req.body;
    const rate = commissionRate !== null && commissionRate !== undefined && commissionRate !== '' ? parseFloat(commissionRate) : null;

    const updated = await prisma.product.update({
      where: { id: productId },
      data: { commissionRate: rate },
    });

    await logAdminAction(req.user?.userId, 'PRODUCT_COMMISSION_UPDATED', 'products', { productId, commissionRate: rate }, req);
    ResponseUtil.success(res, updated, 'تم تحديث نسبة عمولة المنتج بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/finance/commissions/default', requirePermission('finance:commissions'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { defaultRate } = req.body;
    if (defaultRate === undefined) throw new AppError('نسبة العمولة الافتراضية مطلوبة', 400);

    const setting = await prisma.systemSetting.upsert({
      where: { key: 'default_commission_rate' },
      update: { value: String(defaultRate), updatedAt: new Date() },
      create: { key: 'default_commission_rate', value: String(defaultRate), group: 'finance' },
    });

    await logAdminAction(req.user?.userId, 'DEFAULT_COMMISSION_UPDATED', 'system', { defaultRate }, req);
    ResponseUtil.success(res, setting, 'تم تحديث النسبة الافتراضية لعمولة المنصة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 11. MARKETING, PROMOTIONS & COUPONS
// ==============================================================================
router.get('/coupons', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const coupons = await prisma.coupon.findMany({
      orderBy: { createdAt: 'desc' },
    });
    ResponseUtil.success(res, coupons);
  } catch (error) {
    next(error);
  }
});

router.post('/coupons', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, discountType, discountValue, validFrom, validUntil, minOrderValue, maxDiscount, usageLimit, isActive } = req.body;
    if (!code || discountValue === undefined) throw new AppError('رمز الكوبون وقيمة الخصم مطلوبة', 400);

    const coupon = await prisma.coupon.create({
      data: {
        code: code.trim().toUpperCase(),
        discountType: discountType || 'PERCENTAGE',
        discountValue: parseFloat(discountValue),
        validFrom: new Date(validFrom || Date.now()),
        validUntil: new Date(validUntil || Date.now() + 30 * 86400000),
        minOrderValue: minOrderValue ? parseFloat(minOrderValue) : null,
        maxDiscount: maxDiscount ? parseFloat(maxDiscount) : null,
        usageLimit: usageLimit ? parseInt(usageLimit) : null,
        isActive: isActive !== undefined ? Boolean(isActive) : true,
      },
    });
    await logAdminAction(req.user?.userId, 'COUPON_CREATED', 'coupons', { id: coupon.id, code }, req);
    ResponseUtil.created(res, coupon, 'تم إنشاء الكوبون بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/coupons/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { code, discountType, discountValue, validFrom, validUntil, minOrderValue, maxDiscount, usageLimit, isActive } = req.body;

    const coupon = await prisma.coupon.update({
      where: { id },
      data: {
        code: code ? code.trim().toUpperCase() : undefined,
        discountType: discountType || undefined,
        discountValue: discountValue !== undefined ? parseFloat(discountValue) : undefined,
        validFrom: validFrom ? new Date(validFrom) : undefined,
        validUntil: validUntil ? new Date(validUntil) : undefined,
        minOrderValue: minOrderValue !== undefined ? (minOrderValue ? parseFloat(minOrderValue) : null) : undefined,
        maxDiscount: maxDiscount !== undefined ? (maxDiscount ? parseFloat(maxDiscount) : null) : undefined,
        usageLimit: usageLimit !== undefined ? (usageLimit ? parseInt(usageLimit) : null) : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
      },
    });
    await logAdminAction(req.user?.userId, 'COUPON_UPDATED', 'coupons', { id }, req);
    ResponseUtil.success(res, coupon, 'تم تحديث الكوبون بنجاح');
  } catch (error) {
    next(error);
  }
});

router.patch('/coupons/:id/toggle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.coupon.findUnique({ where: { id } });
    if (!existing) throw new AppError('الكوبون غير موجود', 404);

    const coupon = await prisma.coupon.update({
      where: { id },
      data: { isActive: !existing.isActive },
    });
    await logAdminAction(req.user?.userId, 'COUPON_TOGGLED', 'coupons', { id, isActive: coupon.isActive }, req);
    ResponseUtil.success(res, coupon, 'تم تعديل حالة الكوبون بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/coupons/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.coupon.delete({ where: { id } });
    await logAdminAction(req.user?.userId, 'COUPON_DELETED', 'coupons', { id }, req);
    ResponseUtil.success(res, null, 'تم حذف الكوبون بنجاح');
  } catch (error) {
    next(error);
  }
});

router.get('/promotions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [flashSales, banners] = await Promise.all([
      prisma.flashSale.findMany({
        include: {
          products: {
            include: {
              product: {
                select: { id: true, nameAr: true, nameEn: true, price: true, store: { select: { name: true } } },
              },
            },
          },
        },
        orderBy: { startsAt: 'desc' },
      }),
      prisma.banner.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);
    ResponseUtil.success(res, { flashSales, banners });
  } catch (error) {
    next(error);
  }
});

router.post('/promotions/flash-sales', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { titleAr, titleEn, startsAt, endsAt, isActive } = req.body;
    if (!titleAr || !startsAt || !endsAt) throw new AppError('عنوان العرض وتواريخ البداية والنهاية مطلوبة', 400);

    const flashSale = await prisma.flashSale.create({
      data: {
        titleAr,
        titleEn: titleEn || titleAr,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        isActive: isActive !== undefined ? Boolean(isActive) : true,
      },
    });
    await logAdminAction(req.user?.userId, 'FLASHSALE_CREATED', 'promotions', { id: flashSale.id, titleAr }, req);
    ResponseUtil.created(res, flashSale, 'تم إنشاء حملة Flash Sale بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/promotions/flash-sales/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { titleAr, titleEn, startsAt, endsAt, isActive } = req.body;

    const flashSale = await prisma.flashSale.update({
      where: { id },
      data: {
        titleAr: titleAr || undefined,
        titleEn: titleEn || undefined,
        startsAt: startsAt ? new Date(startsAt) : undefined,
        endsAt: endsAt ? new Date(endsAt) : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
      },
    });
    await logAdminAction(req.user?.userId, 'FLASHSALE_UPDATED', 'promotions', { id }, req);
    ResponseUtil.success(res, flashSale, 'تم تحديث حملة Flash Sale بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/promotions/flash-sales/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.flashSale.delete({ where: { id } });
    await logAdminAction(req.user?.userId, 'FLASHSALE_DELETED', 'promotions', { id }, req);
    ResponseUtil.success(res, null, 'تم حذف حملة Flash Sale بنجاح');
  } catch (error) {
    next(error);
  }
});

router.post('/promotions/flash-sales/:id/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const flashSaleId = String(req.params.id);
    const { productId, discountPrice, discountPercent, limitPerUser } = req.body;
    if (!productId || discountPrice === undefined) throw new AppError('معرف المنتج وسعر الخصم مطلوبان', 400);

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new AppError('المنتج غير موجود', 404);

    const calcPercent = discountPercent !== undefined ? parseFloat(discountPercent) : Math.max(0, Math.round(((product.price - parseFloat(discountPrice)) / product.price) * 100));

    const item = await prisma.flashSaleProduct.create({
      data: {
        flashSaleId,
        productId,
        discountPrice: parseFloat(discountPrice),
        discountPercent: calcPercent,
        limitPerUser: limitPerUser ? parseInt(limitPerUser) : 1,
      },
    });

    ResponseUtil.created(res, item, 'تمت إضافة المنتج إلى عرض Flash Sale بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/promotions/flash-sales/:id/products/:productId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const flashSaleId = String(req.params.id);
    const productId = String(req.params.productId);

    await prisma.flashSaleProduct.deleteMany({
      where: { flashSaleId, productId },
    });

    ResponseUtil.success(res, null, 'تم حذف المنتج من عرض Flash Sale بنجاح');
  } catch (error) {
    next(error);
  }
});

router.get('/promotions/banners', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const banners = await prisma.banner.findMany({ orderBy: { sortOrder: 'asc' } });
    ResponseUtil.success(res, banners);
  } catch (error) {
    next(error);
  }
});

router.post('/promotions/banners', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { titleAr, titleEn, imageUrl, targetType, targetId, sortOrder, isActive } = req.body;
    if (!imageUrl) throw new AppError('رابط صورة البانر مطلوب', 400);

    const banner = await prisma.banner.create({
      data: {
        titleAr: titleAr || null,
        titleEn: titleEn || null,
        imageUrl,
        targetType: targetType || 'url',
        targetId: targetId || null,
        sortOrder: sortOrder !== undefined ? parseInt(sortOrder) : 0,
        isActive: isActive !== undefined ? Boolean(isActive) : true,
      },
    });

    await logAdminAction(req.user?.userId, 'BANNER_CREATED', 'promotions', { id: banner.id, imageUrl }, req);
    ResponseUtil.created(res, banner, 'تم إنشاء البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/promotions/banners/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { titleAr, titleEn, imageUrl, targetType, targetId, sortOrder, isActive } = req.body;

    const banner = await prisma.banner.update({
      where: { id },
      data: {
        titleAr: titleAr !== undefined ? titleAr : undefined,
        titleEn: titleEn !== undefined ? titleEn : undefined,
        imageUrl: imageUrl || undefined,
        targetType: targetType || undefined,
        targetId: targetId !== undefined ? targetId : undefined,
        sortOrder: sortOrder !== undefined ? parseInt(sortOrder) : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
      },
    });

    await logAdminAction(req.user?.userId, 'BANNER_UPDATED', 'promotions', { id }, req);
    ResponseUtil.success(res, banner, 'تم تحديث البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/promotions/banners/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.banner.delete({ where: { id } });
    await logAdminAction(req.user?.userId, 'BANNER_DELETED', 'promotions', { id }, req);
    ResponseUtil.success(res, null, 'تم حذف البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 12. REVIEWS MODERATION — see full implementation at bottom of this file
// ==============================================================================



// ==============================================================================
// 13. REPORTS & BUSINESS INTELLIGENCE (BI)
// ==============================================================================
router.get('/reports/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const period = (req.query.period as string) || '30d';
    let fromDate: Date;
    let toDate = new Date();

    if (req.query.startDate && req.query.endDate) {
      fromDate = new Date(req.query.startDate as string);
      toDate = new Date(req.query.endDate as string);
      toDate.setHours(23, 59, 59, 999);
    } else {
      fromDate = new Date();
      if (period === 'today') {
        fromDate.setHours(0, 0, 0, 0);
      } else if (period === 'yesterday') {
        fromDate.setDate(fromDate.getDate() - 1);
        fromDate.setHours(0, 0, 0, 0);
        toDate = new Date();
        toDate.setDate(toDate.getDate() - 1);
        toDate.setHours(23, 59, 59, 999);
      } else if (period === '7d') {
        fromDate.setDate(fromDate.getDate() - 7);
      } else if (period === '30d') {
        fromDate.setDate(fromDate.getDate() - 30);
      } else if (period === '90d') {
        fromDate.setDate(fromDate.getDate() - 90);
      } else if (period === 'this_year') {
        fromDate = new Date(new Date().getFullYear(), 0, 1);
      } else {
        fromDate.setDate(fromDate.getDate() - 30);
      }
    }

    const whereRange = { createdAt: { gte: fromDate, lte: toDate } };

    const [
      ordersCount,
      completedOrdersCount,
      cancelledOrdersCount,
      salesAgg,
      sellerOrdersAgg,
      newCustomersCount,
      newSellersCount,
      topProducts,
      topStores,
      recentOrders,
    ] = await Promise.all([
      prisma.order.count({ where: whereRange }),
      prisma.order.count({ where: { ...whereRange, status: OrderStatus.DELIVERED } }),
      prisma.order.count({ where: { ...whereRange, status: { in: [OrderStatus.CANCELLED_BY_CUSTOMER, OrderStatus.CANCELLED_BY_SELLER, OrderStatus.REJECTED_BY_SELLER, OrderStatus.CANCELLED_BY_ADMIN] } } }),
      prisma.order.aggregate({
        where: whereRange,
        _sum: { total: true, deliveryFee: true, discountAmount: true, taxAmount: true },
        _avg: { total: true },
      }),
      prisma.sellerOrder.aggregate({
        where: whereRange,
        _sum: { commissionAmount: true, sellerPayout: true, subtotal: true },
      }),
      prisma.user.count({ where: { role: 'CUSTOMER', ...whereRange } }),
      prisma.seller.count({ where: whereRange }),
      prisma.orderItem.groupBy({
        by: ['productId', 'productNameAr'],
        where: whereRange,
        _sum: { quantity: true, totalPrice: true },
        orderBy: { _sum: { totalPrice: 'desc' } },
        take: 5,
      }),
      prisma.sellerOrder.groupBy({
        by: ['sellerId'],
        where: whereRange,
        _sum: { subtotal: true, commissionAmount: true },
        _count: { id: true },
        orderBy: { _sum: { subtotal: 'desc' } },
        take: 5,
      }),
      prisma.order.findMany({
        where: whereRange,
        select: { id: true, orderNumber: true, total: true, deliveryFee: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
    ]);

    // Fetch store names for top sellers
    const topSellerIds = topStores.map(s => s.sellerId);
    const stores = await prisma.store.findMany({
      where: { sellerId: { in: topSellerIds } },
      select: { sellerId: true, name: true },
    });
    const storeMap = new Map(stores.map(st => [st.sellerId, st.name]));

    const enrichedTopStores = topStores.map(s => ({
      sellerId: s.sellerId,
      storeName: storeMap.get(s.sellerId) || 'متجر معتمد',
      ordersCount: s._count.id,
      totalSales: s._sum.subtotal || 0,
      totalCommission: s._sum.commissionAmount || 0,
    }));

    const totalSales = salesAgg._sum.total || 0;
    const totalDeliveryFees = salesAgg._sum.deliveryFee || 0;
    const totalCommission = sellerOrdersAgg._sum.commissionAmount || 0;
    const netSellerPayouts = sellerOrdersAgg._sum.sellerPayout || 0;
    const averageOrderValue = salesAgg._avg.total ? parseFloat(salesAgg._avg.total.toFixed(2)) : 0;

    // Daily time series
    const dailyMap = new Map<string, { date: string; sales: number; orders: number; delivery: number }>();
    recentOrders.forEach(o => {
      const day = o.createdAt.toISOString().split('T')[0];
      const existing = dailyMap.get(day) || { date: day, sales: 0, orders: 0, delivery: 0 };
      existing.sales += o.total;
      existing.delivery += o.deliveryFee;
      existing.orders += 1;
      dailyMap.set(day, existing);
    });

    const timeSeries = Array.from(dailyMap.values());

    ResponseUtil.success(res, {
      period: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        label: period,
      },
      kpis: {
        totalSales,
        totalCommission,
        totalDeliveryFees,
        netSellerPayouts,
        ordersCount,
        completedOrdersCount,
        cancelledOrdersCount,
        averageOrderValue,
        newCustomersCount,
        newSellersCount,
      },
      topProducts: topProducts.map(p => ({
        productId: p.productId,
        name: p.productNameAr,
        unitsSold: p._sum.quantity || 0,
        revenue: p._sum.totalPrice || 0,
      })),
      topStores: enrichedTopStores,
      timeSeries,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/reports/export-csv', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const type = (req.query.type as string) || 'sales';
    const period = (req.query.period as string) || '30d';

    let fromDate = new Date();
    if (req.query.startDate && req.query.endDate) {
      fromDate = new Date(req.query.startDate as string);
    } else {
      if (period === 'today') fromDate.setHours(0, 0, 0, 0);
      else if (period === '7d') fromDate.setDate(fromDate.getDate() - 7);
      else if (period === '30d') fromDate.setDate(fromDate.getDate() - 30);
      else fromDate.setDate(fromDate.getDate() - 30);
    }

    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: fromDate } },
      include: {
        user: { select: { firstName: true, lastName: true, phone: true } },
        sellerOrders: { include: { seller: { include: { stores: { select: { name: true } } } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    let csvContent = '\uFEFF'; // UTF-8 BOM for Arabic support in Excel

    if (type === 'commission') {
      csvContent += 'رقم الطلب,تاريخ الطلب,العميل,المتجر,إجمالي الطلب (YER),عمولة المنصة (YER),مستحقات التاجر (YER)\n';
      orders.forEach(o => {
        const clientName = `"${o.user.firstName} ${o.user.lastName}"`;
        o.sellerOrders.forEach(so => {
          const storeName = `"${so.seller.stores[0]?.name || 'المتجر'}"`;
          const dateStr = o.createdAt.toISOString().split('T')[0];
          csvContent += `${o.orderNumber},${dateStr},${clientName},${storeName},${so.subtotal},${so.commissionAmount},${so.sellerPayout}\n`;
        });
      });
    } else {
      csvContent += 'رقم الطلب,تاريخ الطلب,العميل,رقم الجوال,الحالة,قيمة المنتجات (YER),رسوم التوصيل (YER),الإجمالي (YER)\n';
      orders.forEach(o => {
        const clientName = `"${o.user.firstName} ${o.user.lastName}"`;
        const phone = o.user.phone || '';
        const dateStr = o.createdAt.toISOString().split('T')[0];
        csvContent += `${o.orderNumber},${dateStr},${clientName},${phone},${o.status},${o.subtotal},${o.deliveryFee},${o.total}\n`;
      });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=souqna_${type}_report_${new Date().toISOString().split('T')[0]}.csv`);
    res.status(200).send(csvContent);
  } catch (error) {
    next(error);
  }
});

router.get('/notifications/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaigns = await prisma.broadcastCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    ResponseUtil.success(res, campaigns);
  } catch (error) {
    next(error);
  }
});

router.post('/notifications/broadcast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { titleAr, titleEn, bodyAr, bodyEn, target, scheduledAt } = req.body;
    if (!titleAr || !bodyAr) throw new AppError('عنوان ونص الإشعار بالعربية مطلوبان', 400);

    const targetAudience = target || 'ALL';
    const isScheduled = scheduledAt && new Date(scheduledAt).getTime() > Date.now();

    if (isScheduled) {
      const campaign = await prisma.broadcastCampaign.create({
        data: {
          titleAr,
          titleEn: titleEn || titleAr,
          bodyAr,
          bodyEn: bodyEn || bodyAr,
          target: targetAudience,
          status: 'SCHEDULED',
          scheduledAt: new Date(scheduledAt),
          sentCount: 0,
        },
      });

      await logAdminAction(req.user?.userId, 'BROADCAST_SCHEDULED', 'notifications', { id: campaign.id, scheduledAt, target: targetAudience }, req);
      return ResponseUtil.created(res, campaign, 'تمت جدولة الحملة الإعلانية بنجاح');
    }

    const campaign = await prisma.broadcastCampaign.create({
      data: {
        titleAr,
        titleEn: titleEn || titleAr,
        bodyAr,
        bodyEn: bodyEn || bodyAr,
        target: targetAudience,
        status: 'PROCESSING',
        sentCount: 0,
      },
    });

    // Run asynchronously via centralized notification scheduler & dispatcher with multi-channel support
    setImmediate(() => {
      notificationScheduler.executeBroadcastCampaign(campaign).catch((err) => {
        console.error(`[AdminBroadcast] Error executing broadcast campaign ${campaign.id}:`, err);
      });
    });

    await logAdminAction(req.user?.userId, 'BROADCAST_SENT', 'notifications', { target: targetAudience, campaignId: campaign.id }, req);
    ResponseUtil.success(res, campaign, 'تم إرسال الحملة الإعلانية وتوزيعها عبر منصة الإشعارات الموحدة');
  } catch (error) {
    next(error);
  }
});

router.delete('/notifications/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.broadcastCampaign.delete({ where: { id } });
    await logAdminAction(req.user?.userId, 'BROADCAST_DELETED', 'notifications', { id }, req);
    ResponseUtil.success(res, null, 'تم إلغاء وحذف حملة الإشعار بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 14. ROLES, SETTINGS & AUDIT LOGS
// ==============================================================================
const DEFAULT_PERMISSIONS = SYSTEM_PERMISSIONS;

router.get('/permissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let permissions = await prisma.permission.findMany({
      orderBy: { action: 'asc' },
    });

    if (permissions.length < SYSTEM_PERMISSIONS.length) {
      await AdminRbacService.ensureSystemRolesAndPermissions();
      permissions = await prisma.permission.findMany({ orderBy: { action: 'asc' } });
    }

    ResponseUtil.success(res, permissions);
  } catch (error) {
    next(error);
  }
});

router.get('/roles', requirePermission('roles:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roles = await prisma.role.findMany({
      include: {
        permissions: { include: { permission: true } },
        userRoles: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    ResponseUtil.success(res, roles);
  } catch (error) {
    next(error);
  }
});

router.post('/roles', requirePermission('roles:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description, permissionIds } = req.body;
    if (!name || !name.trim()) throw new AppError('اسم الدور الوظيفي مطلوب', 400);

    const formattedName = name.trim().toUpperCase().replace(/\s+/g, '_');

    const role = await prisma.$transaction(async (tx) => {
      const r = await tx.role.create({
        data: {
          name: formattedName,
          description: description || null,
        },
      });

      if (Array.isArray(permissionIds) && permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((pId: string) => ({
            roleId: r.id,
            permissionId: pId,
          })),
        });
      }

      return r;
    });

    await logAdminAction(req.user?.userId, 'ROLE_CREATED', 'roles', { id: role.id, name: formattedName }, req);
    ResponseUtil.created(res, role, 'تم إنشاء الدور الوظيفي بنجاح');
  } catch (error) {
    next(error);
  }
});

router.put('/roles/:id', requirePermission('roles:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { name, description, permissionIds } = req.body;

    const role = await prisma.$transaction(async (tx) => {
      const r = await tx.role.update({
        where: { id },
        data: {
          name: name ? name.trim().toUpperCase().replace(/\s+/g, '_') : undefined,
          description: description !== undefined ? description : undefined,
        },
      });

      if (Array.isArray(permissionIds)) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        if (permissionIds.length > 0) {
          await tx.rolePermission.createMany({
            data: permissionIds.map((pId: string) => ({
              roleId: id,
              permissionId: pId,
            })),
          });
        }
      }

      return r;
    });

    await logAdminAction(req.user?.userId, 'ROLE_UPDATED', 'roles', { id }, req);
    ResponseUtil.success(res, role, 'تم تحديث الدور والصلاحيات بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/roles/:id', requirePermission('roles:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw new AppError('الدور غير موجود', 404);

    if (role.name === 'ADMIN' || role.name === 'SUPER_ADMIN' || role.name === 'CUSTOMER' || role.name === 'SELLER') {
      throw new AppError('لا يمكن حذف الأدوار الأساسية المدمجة في النظام', 400);
    }

    await prisma.role.delete({ where: { id } });
    await logAdminAction(req.user?.userId, 'ROLE_DELETED', 'roles', { id, name: role.name }, req);
    ResponseUtil.success(res, null, 'تم حذف الدور الوظيفي بنجاح');
  } catch (error) {
    next(error);
  }
});

router.get('/permissions', requirePermission('roles:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const permissions = await prisma.permission.findMany({
      orderBy: { action: 'asc' },
    });
    ResponseUtil.success(res, permissions);
  } catch (error) {
    next(error);
  }
});

router.get('/audit-logs', requirePermission('audit:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const action = req.query.action as string;
    const search = (req.query.search as string)?.trim();

    const where: any = {};
    if (action && action !== 'ALL') {
      where.action = { contains: action, mode: 'insensitive' };
    }

    if (search) {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { resource: { contains: search, mode: 'insensitive' } },
        { ipAddress: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { id: true, email: true, role: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      logs,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

const DEFAULT_SYSTEM_SETTINGS = [
  { key: 'app_name', value: 'سوقناا', type: 'string', group: 'general' },
  { key: 'support_email', value: 'support@souqnaa.online', type: 'string', group: 'general' },
  { key: 'support_phone', value: '+966500000000', type: 'string', group: 'general' },
  { key: 'maintenance_mode', value: 'false', type: 'boolean', group: 'general' },
  { key: 'default_commission_rate', value: '10', type: 'number', group: 'finance' },
  { key: 'vat_rate', value: '15', type: 'number', group: 'finance' },
  { key: 'min_withdrawal_amount', value: '100', type: 'number', group: 'finance' },
  { key: 'default_delivery_fee', value: '25', type: 'number', group: 'delivery' },
  { key: 'free_delivery_threshold', value: '200', type: 'number', group: 'delivery' },
  { key: 'android_min_version', value: '1.0.0', type: 'string', group: 'app' },
  { key: 'ios_min_version', value: '1.0.0', type: 'string', group: 'app' },
  { key: 'force_app_update', value: 'false', type: 'boolean', group: 'app' },
];

router.get('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let settings = await prisma.systemSetting.findMany({
      orderBy: { group: 'asc' },
    });

    // Ensure all critical platform setting keys exist in the database
    const existingKeys = new Set(settings.map((s) => s.key));
    const missingDefaults = DEFAULT_SYSTEM_SETTINGS.filter((d) => !existingKeys.has(d.key));

    if (missingDefaults.length > 0) {
      await Promise.all(
        missingDefaults.map((d) =>
          prisma.systemSetting.upsert({
            where: { key: d.key },
            update: {},
            create: {
              key: d.key,
              value: d.value,
              type: d.type,
              group: d.group,
            },
          })
        )
      );

      settings = await prisma.systemSetting.findMany({
        orderBy: { group: 'asc' },
      });
    }

    // Sync maintenance mode state if present
    const maintenanceSetting = settings.find((s) => s.key === 'maintenance_mode');
    if (maintenanceSetting) {
      setMaintenanceConfig({ enabled: maintenanceSetting.value.toLowerCase() === 'true' });
    }

    ResponseUtil.success(res, settings);
  } catch (error) {
    next(error);
  }
});

router.put('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { settings } = req.body; // Array of { key, value, type, group }
    if (Array.isArray(settings) && settings.length > 0) {
      await Promise.all(
        settings.map((s) =>
          prisma.systemSetting.upsert({
            where: { key: s.key },
            update: {
              value: String(s.value),
              type: s.type || 'string',
              group: s.group || 'general',
              updatedAt: new Date(),
            },
            create: {
              key: s.key,
              value: String(s.value),
              type: s.type || 'string',
              group: s.group || 'general',
            },
          })
        )
      );

      // Check if maintenance mode was updated
      const maintenance = settings.find((s) => s.key === 'maintenance_mode');
      if (maintenance) {
        const isEnabled = String(maintenance.value).toLowerCase() === 'true';
        setMaintenanceConfig({ enabled: isEnabled });
      }
    }

    await logAdminAction(req.user?.userId, 'SETTINGS_UPDATED', 'settings', { count: settings?.length }, req);

    const updatedSettings = await prisma.systemSetting.findMany({
      orderBy: { group: 'asc' },
    });

    ResponseUtil.success(res, updatedSettings, 'تم حفظ وتطبيق إعدادات وسياسات النظام بنجاح');
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — REVIEWS MODERATION
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/admin/reviews — paginated review list with multi-filter
router.get('/reviews', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ReviewStatus, ReviewMediaModerationStatus, ReviewSellerResponseStatus } = await import('@prisma/client');

    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 30, 100);
    const skip = (page - 1) * limit;

    const search = (req.query.search as string)?.trim();
    const rating = req.query.rating ? parseInt(req.query.rating as string, 10) : undefined;
    const isPublished = req.query.isPublished;
    const status = req.query.status as string;
    const reported = req.query.reported === 'true';
    const verified = req.query.verified === 'true' ? true : req.query.verified === 'false' ? false : undefined;
    const hasMedia = req.query.has_media === 'true';
    const dateFrom = req.query.dateFrom as string;
    const dateTo = req.query.dateTo as string;
    const productId = req.query.productId as string;
    const sellerId = req.query.sellerId as string;
    const customerId = req.query.customerId as string;

    const where: any = {};
    if (productId) where.productId = productId;
    if (sellerId) where.sellerId = sellerId;
    if (customerId) where.userId = customerId;
    if (rating) where.rating = rating;
    if (verified !== undefined) where.verifiedPurchase = verified;
    if (reported) where.reportCount = { gt: 0 };
    if (hasMedia) where.media = { some: {} };
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    // Status filter
    if (status && status !== 'ALL') {
      where.status = status as any;
    } else if (isPublished !== undefined) {
      // Legacy support
      where.status = isPublished === 'true' ? ReviewStatus.PUBLISHED : ReviewStatus.PENDING;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { body: { contains: search, mode: 'insensitive' } },
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName: { contains: search, mode: 'insensitive' } } },
        { product: { nameAr: { contains: search, mode: 'insensitive' } } },
        { product: { nameEn: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, reviews, stats] = await Promise.all([
      prisma.productReview.count({ where }),
      prisma.productReview.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          productId: true,
          sellerId: true,
          orderId: true,
          orderItemId: true,
          rating: true,
          title: true,
          body: true,
          status: true,
          verifiedPurchase: true,
          helpfulCount: true,
          reportCount: true,
          sellerResponseExists: true,
          createdAt: true,
          updatedAt: true,
          publishedAt: true,
          user: { select: { id: true, firstName: true, lastName: true, email: true, avatar: true } },
          product: { select: { id: true, nameAr: true, nameEn: true, images: { where: { isPrimary: true }, take: 1, select: { url: true } } } },
          media: {
            select: { id: true, mediaType: true, url: true, thumbnailUrl: true, moderationStatus: true, sortOrder: true },
            orderBy: { sortOrder: 'asc' },
          },
          sellerResponse: {
            select: { id: true, body: true, status: true, createdAt: true, sellerId: true },
          },
          reports: {
            select: { id: true, reason: true, status: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
          moderationHistory: {
            select: { id: true, adminUserId: true, previousStatus: true, newStatus: true, reason: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      prisma.productReview.aggregate({
        where: { status: ReviewStatus.PUBLISHED },
        _avg: { rating: true },
        _count: { id: true },
      }),
    ]);

    ResponseUtil.success(res, {
      reviews,
      stats: {
        averageRating: stats._avg.rating ? parseFloat(stats._avg.rating.toFixed(2)) : 0,
        totalPublished: stats._count.id,
      },
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/reviews/reports — reported reviews queue
router.get('/reviews/reports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const skip = (page - 1) * limit;
    const status = (req.query.status as string) || 'PENDING';

    const where: any = {};
    if (status !== 'ALL') where.status = status;

    const [total, reports] = await Promise.all([
      prisma.reviewReport.count({ where }),
      prisma.reviewReport.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          reporter: { select: { id: true, firstName: true, lastName: true, email: true } },
          review: {
            select: {
              id: true, rating: true, title: true, body: true, status: true, productId: true, userId: true,
              user: { select: { firstName: true, lastName: true } },
              product: { select: { nameAr: true, nameEn: true } },
            },
          },
        },
      }),
    ]);

    ResponseUtil.success(res, {
      reports,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/reviews/reports/:id/resolve
router.post('/reviews/reports/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { adminNote } = req.body;
    const { resolveReport } = await import('../reviews/reviews.service');
    await resolveReport(id, req.user!.userId, adminNote);
    await logAdminAction(req.user?.userId, 'REVIEW_REPORT_RESOLVED', 'reviews', { id, adminNote }, req);
    ResponseUtil.success(res, null, 'تم حل البلاغ بنجاح');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/reviews/analytics
router.get('/reviews/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getAdminAnalytics } = await import('../reviews/reviews.service');
    const analytics = await getAdminAnalytics();
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/reviews/settings
router.get('/reviews/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getReviewPolicy } = await import('../reviews/reviews.service');
    const policy = await getReviewPolicy();
    ResponseUtil.success(res, policy);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/admin/reviews/settings
router.patch('/reviews/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { saveReviewPolicy } = await import('../reviews/reviews.service');
    await saveReviewPolicy(req.body);
    await logAdminAction(req.user?.userId, 'REVIEW_SETTINGS_CHANGED', 'reviews', req.body, req);
    ResponseUtil.success(res, null, 'تم حفظ إعدادات التقييمات بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/reviews/seller-responses/:responseId/hide
router.post('/reviews/seller-responses/:responseId/hide', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const responseId = String(req.params.responseId);
    const { reason } = req.body;
    const { moderateSellerResponse } = await import('../reviews/reviews.service');
    const { ReviewSellerResponseStatus } = await import('@prisma/client');
    await moderateSellerResponse(responseId, req.user!.userId, ReviewSellerResponseStatus.HIDDEN, reason);
    await logAdminAction(req.user?.userId, 'SELLER_RESPONSE_HIDDEN', 'reviews', { responseId, reason }, req);
    ResponseUtil.success(res, null, 'تم إخفاء رد البائع');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/reviews/seller-responses/:responseId/restore
router.post('/reviews/seller-responses/:responseId/restore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const responseId = String(req.params.responseId);
    const { moderateSellerResponse } = await import('../reviews/reviews.service');
    const { ReviewSellerResponseStatus } = await import('@prisma/client');
    await moderateSellerResponse(responseId, req.user!.userId, ReviewSellerResponseStatus.PUBLISHED);
    await logAdminAction(req.user?.userId, 'SELLER_RESPONSE_RESTORED', 'reviews', { responseId }, req);
    ResponseUtil.success(res, null, 'تم استعادة رد البائع');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/reviews/:id — single review detail
router.get('/reviews/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const review = await prisma.productReview.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, avatar: true } },
        product: { include: { store: { select: { name: true, sellerId: true } } } },
        media: true,
        sellerResponse: true,
        reports: { include: { reporter: { select: { firstName: true, lastName: true, email: true } } } },
        moderationHistory: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!review) throw new AppError('التقييم غير موجود', 404);
    ResponseUtil.success(res, review);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/reviews/:id/approve
router.post('/reviews/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason } = req.body;
    const { approveReview } = await import('../reviews/reviews.service');
    await approveReview(id, req.user!.userId, reason);
    await logAdminAction(req.user?.userId, 'REVIEW_APPROVED', 'reviews', { id, reason }, req);
    ResponseUtil.success(res, null, 'تم اعتماد التقييم ونشره بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/reviews/:id/reject
router.post('/reviews/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason } = req.body;
    const { rejectReview } = await import('../reviews/reviews.service');
    await rejectReview(id, req.user!.userId, reason);
    await logAdminAction(req.user?.userId, 'REVIEW_REJECTED', 'reviews', { id, reason }, req);
    ResponseUtil.success(res, null, 'تم رفض التقييم');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/reviews/:id/hide
router.post('/reviews/:id/hide', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason } = req.body;
    const { hideReview } = await import('../reviews/reviews.service');
    await hideReview(id, req.user!.userId, reason);
    await logAdminAction(req.user?.userId, 'REVIEW_HIDDEN', 'reviews', { id, reason }, req);
    ResponseUtil.success(res, null, 'تم إخفاء التقييم');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/reviews/:id/restore
router.post('/reviews/:id/restore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason } = req.body;
    const { restoreReview } = await import('../reviews/reviews.service');
    await restoreReview(id, req.user!.userId, reason);
    await logAdminAction(req.user?.userId, 'REVIEW_RESTORED', 'reviews', { id, reason }, req);
    ResponseUtil.success(res, null, 'تم استعادة التقييم ونشره');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/reviews/:id/toggle (legacy compat)
router.patch('/reviews/:id/toggle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { ReviewStatus } = await import('@prisma/client');
    const review = await prisma.productReview.findUnique({ where: { id } });
    if (!review) throw new AppError('التقييم غير موجود', 404);
    const { approveReview, hideReview } = await import('../reviews/reviews.service');
    if (review.status === ReviewStatus.PUBLISHED) {
      await hideReview(id, req.user!.userId, 'Admin toggled');
    } else {
      await approveReview(id, req.user!.userId, 'Admin toggled');
    }
    ResponseUtil.success(res, null, 'تم تغيير حالة التقييم');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/reviews/:id
router.delete('/reviews/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason } = req.body;
    const { adminDeleteReview } = await import('../reviews/reviews.service');
    await adminDeleteReview(id, req.user!.userId, reason);
    await logAdminAction(req.user?.userId, 'REVIEW_DELETED', 'reviews', { id, reason }, req);
    ResponseUtil.success(res, null, 'تم حذف التقييم نهائياً');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/reviews/:id/reply (legacy compat)
router.post('/reviews/:id/reply', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { replyText } = req.body;
    if (!replyText?.trim()) throw new AppError('نص الرد مطلوب', 400);
    // Admin uses a special system seller response tagged with their user id as seller
    // For admin replies we just store directly
    await prisma.productReview.findUniqueOrThrow({ where: { id } });
    // Store as an audit entry, not a seller response (admins don't impersonate sellers)
    await logAdminAction(req.user?.userId, 'REVIEW_ADMIN_REPLY', 'reviews', { id, replyText }, req);
    ResponseUtil.success(res, null, 'تم تسجيل رد المشرف');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 14. WISHLIST ANALYTICS & SETTINGS
// ==============================================================================
// GET /api/v1/admin/wishlist/analytics
router.get('/wishlist/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { WishlistService } = await import('../wishlist/wishlist.service');
    const analytics = await WishlistService.getAdminWishlistAnalytics();
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/wishlist/settings
router.get('/wishlist/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { WishlistService } = await import('../wishlist/wishlist.service');
    const settings = await WishlistService.getWishlistSettings();
    ResponseUtil.success(res, settings);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/admin/wishlist/settings
router.patch('/wishlist/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { WishlistService } = await import('../wishlist/wishlist.service');
    const updated = await WishlistService.updateWishlistSettings(req.body);
    await logAdminAction(req.user?.userId, 'WISHLIST_SETTINGS_CHANGED', 'wishlist', req.body, req);
    ResponseUtil.success(res, updated, 'تم حفظ إعدادات المفضلة بنجاح');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/sellers/:id/wishlist-analytics
router.get('/sellers/:id/wishlist-analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = String(req.params.id);
    const { WishlistService } = await import('../wishlist/wishlist.service');
    const analytics = await WishlistService.getSellerWishlistAnalytics(sellerId);
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// ADMIN: SOCIAL FOLLOW MANAGEMENT
// ==============================================================================

// GET /api/v1/admin/social/follows — Stats + paginated relationships
router.get('/social/follows', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
    const skip = (page - 1) * limit;
    const type = req.query.type as string | undefined;
    const status = req.query.status as string | undefined;

    const where: any = {
      ...(type && { relationshipType: type }),
      ...(status && { status }),
    };

    const [follows, total, totalCustomerToSeller, totalSellerToCustomer] = await Promise.all([
      prisma.socialFollow.findMany({
        where,
        include: {
          follower: { select: { id: true, firstName: true, lastName: true, role: true, email: true } },
          followed: { select: { id: true, firstName: true, lastName: true, role: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.socialFollow.count({ where }),
      prisma.socialFollow.count({ where: { relationshipType: 'CUSTOMER_TO_SELLER', status: 'FOLLOWING' } }),
      prisma.socialFollow.count({ where: { relationshipType: 'SELLER_TO_CUSTOMER', status: 'FOLLOWING' } }),
    ]);

    ResponseUtil.paginated(res, follows, total, page, limit, undefined);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/social/follows/:id — Remove an abusive follow relationship
router.delete('/social/follows/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const followId = String(req.params.id);
    const follow = await prisma.socialFollow.findUnique({ where: { id: followId } });
    if (!follow) throw new AppError('Follow relationship not found', 404);

    await prisma.$transaction(async (tx) => {
      await tx.socialFollow.delete({ where: { id: followId } });
      // Decrement counters
      await tx.followCounter.updateMany({
        where: { userId: follow.followedUserId, relationshipType: follow.relationshipType },
        data: { followerCount: { decrement: 1 } },
      });
      await tx.followCounter.updateMany({
        where: { userId: follow.followerUserId, relationshipType: follow.relationshipType },
        data: { followingCount: { decrement: 1 } },
      });
    });

    await logAdminAction(req.user?.userId, 'DELETE_FOLLOW', 'SocialFollow', { followId }, req);
    ResponseUtil.success(res, null, 'Follow relationship removed');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/social/blocks — Block list with pagination
router.get('/social/blocks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
    const skip = (page - 1) * limit;

    const [blocks, total] = await Promise.all([
      prisma.userBlock.findMany({
        include: {
          blocker: { select: { id: true, firstName: true, lastName: true, role: true, email: true } },
          blocked: { select: { id: true, firstName: true, lastName: true, role: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.userBlock.count(),
    ]);

    ResponseUtil.paginated(res, blocks, total, page, limit, undefined);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/social/users/:id/block — Admin-block a user (blocks all follow/chat)
router.post('/social/users/:id/block', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetId = String(req.params.id);
    const { reason } = req.body;

    const adminUserId = req.user!.userId;

    // Use admin's own userId as blocker (or a system sentinel) + block the target
    await prisma.userBlock.upsert({
      where: { blockerUserId_blockedUserId: { blockerUserId: adminUserId, blockedUserId: targetId } },
      update: { reason },
      create: { blockerUserId: adminUserId, blockedUserId: targetId, reason },
    });

    await logAdminAction(req.user?.userId, 'BLOCK_USER', 'User', { targetId, reason }, req);
    ResponseUtil.success(res, null, 'User blocked successfully');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/social/users/:id/block — Admin-unblock a user
router.delete('/social/users/:id/block', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetId = String(req.params.id);
    const adminUserId = req.user!.userId;

    await prisma.userBlock.deleteMany({
      where: { blockerUserId: adminUserId, blockedUserId: targetId },
    });

    await logAdminAction(req.user?.userId, 'UNBLOCK_USER', 'User', { targetId }, req);
    ResponseUtil.success(res, null, 'User unblocked successfully');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/social/analytics — Aggregate follow analytics
router.get('/social/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [
      totalFollows,
      totalBlocks,
      newFollowsLast7d,
      newFollowsLast30d,
      customerToSellerTotal,
      sellerToCustomerTotal,
      topFollowedStores,
    ] = await Promise.all([
      prisma.socialFollow.count({ where: { status: 'FOLLOWING' } }),
      prisma.userBlock.count(),
      prisma.socialFollow.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.socialFollow.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.socialFollow.count({ where: { relationshipType: 'CUSTOMER_TO_SELLER', status: 'FOLLOWING' } }),
      prisma.socialFollow.count({ where: { relationshipType: 'SELLER_TO_CUSTOMER', status: 'FOLLOWING' } }),
      prisma.followCounter.findMany({
        where: { relationshipType: 'CUSTOMER_TO_SELLER', followerCount: { gt: 0 } },
        orderBy: { followerCount: 'desc' },
        take: 10,
        include: {
          user: {
            select: {
              seller: { select: { stores: { select: { id: true, name: true, slug: true, logo: true }, take: 1 } } },
            },
          },
        },
      }),
    ]);

    ResponseUtil.success(res, {
      totalFollows,
      totalBlocks,
      newFollowsLast7d,
      newFollowsLast30d,
      customerToSellerTotal,
      sellerToCustomerTotal,
      topFollowedStores: topFollowedStores.map((fc) => ({
        followerCount: fc.followerCount,
        store: fc.user.seller?.stores[0] ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

export const adminRoutes = router;





