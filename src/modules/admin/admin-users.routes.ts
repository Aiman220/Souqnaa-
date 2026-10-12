import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { PasswordPolicyUtil } from '../../utils/password-policy.util';
import { AdminRbacService, SystemRole } from './admin-rbac.service';
import { AdminSessionService } from './admin-session.service';
import { requirePermission } from '../../middleware/rbac.middleware';
import { smtpEmailProvider } from '../notifications/providers/email.provider';

const router = Router();

// ==============================================================================
// 1. LIST ADMINISTRATORS (PAGINATED WITH ROLE FILTER & SEARCH)
// ==============================================================================
router.get('/', requirePermission('admins:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const search = (req.query.search as string)?.trim();
    const roleFilter = (req.query.role as string)?.trim();
    const status = req.query.status as string;

    const where: any = {
      role: 'ADMIN',
    };

    if (status !== undefined && status !== 'ALL') {
      where.isActive = status === 'active';
    }

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (roleFilter && roleFilter !== 'ALL') {
      where.userRoles = {
        some: {
          role: {
            name: roleFilter,
          },
        },
      };
    }

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          userRoles: {
            include: {
              role: {
                include: {
                  permissions: {
                    include: { permission: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formattedUsers = users.map((u) => {
      const roles = u.userRoles.map((ur) => ur.role.name);
      const isSuperAdmin = roles.includes(SystemRole.SUPER_ADMIN);
      const permissionActions = new Set<string>();

      for (const ur of u.userRoles) {
        for (const rp of ur.role.permissions) {
          if (rp.permission?.action) {
            permissionActions.add(rp.permission.action);
          }
        }
      }

      return {
        id: u.id,
        email: u.email,
        phone: u.phone || '',
        firstName: u.firstName,
        lastName: u.lastName,
        fullName: `${u.firstName} ${u.lastName}`.trim(),
        avatar: u.avatar,
        isActive: u.isActive,
        isVerified: u.isVerified,
        roles,
        isSuperAdmin,
        permissionsCount: isSuperAdmin ? 21 : permissionActions.size,
        createdAt: u.createdAt.toISOString(),
        updatedAt: u.updatedAt.toISOString(),
      };
    });

    ResponseUtil.success(res, {
      admins: formattedUsers,
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

// ==============================================================================
// 2. CREATE NEW ADMINISTRATOR (WITH ROLE ASSIGNMENT & RE-AUTHENTICATION)
// ==============================================================================
router.post('/', requirePermission('admins:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, firstName, lastName, phone, password, roles, currentPassword } = req.body;

    // 1. Re-authenticate acting administrator
    await AdminSessionService.reauthenticate(req.user!.userId, currentPassword);

    // 2. Validate Email
    if (!email || typeof email !== 'string') {
      throw new AppError('البريد الإلكتروني مطلوب.', 400);
    }
    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(cleanEmail)) {
      throw new AppError('صيغة البريد الإلكتروني غير صحيحة.', 400);
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanEmail },
          ...(phone ? [{ phone: String(phone).trim() }] : []),
        ],
      },
    });

    if (existingUser) {
      throw new AppError('يوجد حساب مسجل مسبقاً بهذا البريد الإلكتروني أو رقم الهاتف.', 409);
    }

    // 3. Validate Password Policy
    const passwordValidation = PasswordPolicyUtil.validateAdminPassword(password);
    if (!passwordValidation.valid) {
      throw new AppError(
        `كلمة المرور لا تستوفي المعايير الأمنية:\n• ${passwordValidation.errors.join('\n• ')}`,
        400,
        'PASSWORD_POLICY_VIOLATION'
      );
    }

    // 4. Validate & Authorize Roles to Assign
    const rolesToAssign: string[] = Array.isArray(roles) && roles.length > 0 ? roles : [SystemRole.CUSTOMER_SUPPORT];
    await AdminRbacService.assertCanAssignRoles(req.user!.userId, rolesToAssign);

    // Ensure system roles exist
    await AdminRbacService.ensureSystemRolesAndPermissions();

    const dbRoles = await prisma.role.findMany({
      where: { name: { in: rolesToAssign } },
    });

    if (dbRoles.length !== rolesToAssign.length) {
      const foundNames = new Set(dbRoles.map((r) => r.name));
      const missing = rolesToAssign.filter((r) => !foundNames.has(r));
      throw new AppError(`الأدوار التالية غير موجودة في النظام: ${missing.join(', ')}`, 400);
    }

    // 5. Hash Password & Create User inside Transaction
    const passwordHash = await PasswordPolicyUtil.hashPassword(password);

    const newAdmin = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: cleanEmail,
          phone: phone ? String(phone).trim() : null,
          passwordHash,
          firstName: firstName?.trim() || 'مدير',
          lastName: lastName?.trim() || 'نظام',
          role: 'ADMIN',
          isActive: true,
          isVerified: true,
        },
      });

      await tx.userRole.createMany({
        data: dbRoles.map((r) => ({
          userId: createdUser.id,
          roleId: r.id,
        })),
      });

      return createdUser;
    });

    // 6. Log Audit Safely
    await AdminSessionService.logAudit({
      actorId: req.user!.userId,
      action: 'ADMIN_CREATED',
      resource: 'administrators',
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      details: {
        createdAdminId: newAdmin.id,
        email: newAdmin.email,
        assignedRoles: rolesToAssign,
      },
    });

    ResponseUtil.created(res, {
      id: newAdmin.id,
      email: newAdmin.email,
      firstName: newAdmin.firstName,
      lastName: newAdmin.lastName,
      roles: rolesToAssign,
      isActive: newAdmin.isActive,
      createdAt: newAdmin.createdAt.toISOString(),
    }, 'تم إنشاء حساب المشرف بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 3. GET SINGLE ADMINISTRATOR DETAILS
// ==============================================================================
router.get('/:id', requirePermission('admins:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
      },
    });

    if (!user || user.role !== 'ADMIN') {
      throw new AppError('المشرف غير موجود.', 404);
    }

    const roles = user.userRoles.map((ur) => ur.role.name);
    const isSuperAdmin = roles.includes(SystemRole.SUPER_ADMIN);
    const permissionActions = new Set<string>();

    for (const ur of user.userRoles) {
      for (const rp of ur.role.permissions) {
        if (rp.permission?.action) {
          permissionActions.add(rp.permission.action);
        }
      }
    }

    ResponseUtil.success(res, {
      id: user.id,
      email: user.email,
      phone: user.phone || '',
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: `${user.firstName} ${user.lastName}`.trim(),
      avatar: user.avatar,
      isActive: user.isActive,
      isVerified: user.isVerified,
      roles,
      isSuperAdmin,
      permissions: isSuperAdmin ? ['* (All System Permissions)'] : Array.from(permissionActions),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 4. ASSIGN / REPLACE ROLES (WITH LAST SUPER_ADMIN & ESCALATION GUARDS)
// ==============================================================================
router.put('/:id/roles', requirePermission('admins:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.id);
    const { roles, currentPassword } = req.body;

    // 1. Re-authenticate acting administrator
    await AdminSessionService.reauthenticate(req.user!.userId, currentPassword);

    if (!Array.isArray(roles) || roles.length === 0) {
      throw new AppError('يجب تحديد دور وظيفي واحد على الأقل.', 400);
    }

    // 2. Validate privilege escalation
    await AdminRbacService.assertCanAssignRoles(req.user!.userId, roles);

    // 3. Target User Existence Check
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: { userRoles: { include: { role: true } } },
    });

    if (!targetUser || targetUser.role !== 'ADMIN') {
      throw new AppError('المشرف غير موجود.', 404);
    }

    // 4. Last Active SUPER_ADMIN Protection:
    // If target currently holds SUPER_ADMIN and new roles do NOT include SUPER_ADMIN:
    const currentlyHasSuperAdmin = targetUser.userRoles.some((ur) => ur.role.name === SystemRole.SUPER_ADMIN);
    const willHaveSuperAdmin = roles.includes(SystemRole.SUPER_ADMIN);

    if (currentlyHasSuperAdmin && !willHaveSuperAdmin) {
      await AdminRbacService.assertNotLastActiveSuperAdmin(targetUserId, 'إلغاء دور المدير العام (SUPER_ADMIN)');
    }

    // 5. Ensure system roles exist
    await AdminRbacService.ensureSystemRolesAndPermissions();

    const dbRoles = await prisma.role.findMany({
      where: { name: { in: roles } },
    });

    if (dbRoles.length !== roles.length) {
      const foundNames = new Set(dbRoles.map((r) => r.name));
      const missing = roles.filter((r) => !foundNames.has(r));
      throw new AppError(`الأدوار التالية غير موجودة: ${missing.join(', ')}`, 400);
    }

    // 6. Update Roles in Transaction
    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({
        where: { userId: targetUserId },
      });

      await tx.userRole.createMany({
        data: dbRoles.map((r) => ({
          userId: targetUserId,
          roleId: r.id,
        })),
      });
    });

    // 7. Revoke Target User's Active Sessions immediately so privilege changes apply instantly
    await AdminSessionService.revokeAllSessions(targetUserId);

    // 8. Log Audit
    await AdminSessionService.logAudit({
      actorId: req.user!.userId,
      action: 'ADMIN_ROLES_UPDATED',
      resource: 'administrators',
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      details: {
        targetUserId,
        previousRoles: targetUser.userRoles.map((ur) => ur.role.name),
        newRoles: roles,
      },
    });

    ResponseUtil.success(res, {
      id: targetUserId,
      roles,
    }, 'تم تحديث أدوار المشرف وإلغاء جلساته النشطة لتطبيق الصلاحيات الجديدة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 5. ACTIVATE / DEACTIVATE ADMINISTRATOR (WITH LAST SUPER_ADMIN PROTECTION)
// ==============================================================================
router.patch('/:id/status', requirePermission('admins:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.id);
    const { isActive, reason, currentPassword } = req.body;

    if (typeof isActive !== 'boolean') {
      throw new AppError('حالة التفعيل (isActive) مطلوبة وتكون قيمة منطقية.', 400);
    }

    // 1. Re-authenticate acting administrator
    await AdminSessionService.reauthenticate(req.user!.userId, currentPassword);

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: { userRoles: { include: { role: true } } },
    });

    if (!targetUser || targetUser.role !== 'ADMIN') {
      throw new AppError('المشرف غير موجود.', 404);
    }

    // 2. Prevent self-deactivation
    if (!isActive && req.user!.userId === targetUserId) {
      throw new AppError('لا يمكنك تجميد أو إيقاف حسابك الإداري الخاص.', 400, 'SELF_DEACTIVATION_PROHIBITED');
    }

    // 3. Last Active SUPER_ADMIN Protection:
    if (!isActive) {
      await AdminRbacService.assertNotLastActiveSuperAdmin(targetUserId, 'تعطيل حساب المشرف');
    }

    // 4. Update status
    await prisma.user.update({
      where: { id: targetUserId },
      data: { isActive },
    });

    // 5. If deactivating, immediately revoke all active sessions
    if (!isActive) {
      await AdminSessionService.revokeAllSessions(targetUserId);
    }

    // 6. Log Audit
    await AdminSessionService.logAudit({
      actorId: req.user!.userId,
      action: 'ADMIN_STATUS_CHANGED',
      resource: 'administrators',
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      details: {
        targetUserId,
        targetEmail: targetUser.email,
        newStatus: isActive ? 'ACTIVE' : 'DEACTIVATED',
        reason: reason || null,
      },
    });

    ResponseUtil.success(res, {
      id: targetUserId,
      isActive,
    }, isActive ? 'تم تفعيل حساب المشرف بنجاح' : 'تم تعطيل حساب المشرف وإلغاء جميع جلساته بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 6. REVOKE ADMINISTRATOR SESSIONS
// ==============================================================================
router.post('/:id/revoke-sessions', requirePermission('admins:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.id);

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser || targetUser.role !== 'ADMIN') {
      throw new AppError('المشرف غير موجود.', 404);
    }

    await AdminSessionService.revokeAllSessions(targetUserId);

    await AdminSessionService.logAudit({
      actorId: req.user!.userId,
      action: 'ADMIN_SESSIONS_REVOKED',
      resource: 'administrators',
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      details: {
        targetUserId,
        targetEmail: targetUser.email,
      },
    });

    ResponseUtil.success(res, null, 'تم إلغاء وإنهاء جميع الجلسات النشطة للمشرف بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 7. INITIATE SECURE PASSWORD RESET FOR ADMINISTRATOR
// ==============================================================================
router.post('/:id/reset-password', requirePermission('admins:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.id);
    const { currentPassword } = req.body;

    // 1. Re-authenticate acting administrator
    await AdminSessionService.reauthenticate(req.user!.userId, currentPassword);

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser || targetUser.role !== 'ADMIN') {
      throw new AppError('المشرف غير موجود.', 404);
    }

    // 2. Generate secure one-time cryptographic reset token (15 mins TTL)
    const resetToken = crypto.randomBytes(32).toString('hex');
    await redis.set(`admin_pwd_reset:${resetToken}`, targetUser.id, 900);

    // 3. Revoke target user's existing sessions immediately
    await AdminSessionService.revokeAllSessions(targetUserId);

    // 4. Dispatch localized notification email via Email Provider Abstraction
    await smtpEmailProvider.sendTemplate(targetUser.email, 'PASSWORD_RESET', 'ar', {
      email: targetUser.email,
      name: `${targetUser.firstName} ${targetUser.lastName}`.trim(),
      otpCode: resetToken.slice(0, 8).toUpperCase(),
    }).catch((err) => console.error('[Admin Reset Password] Email dispatch warning:', err));

    // 5. Log Audit Safely (Token is NOT logged)
    await AdminSessionService.logAudit({
      actorId: req.user!.userId,
      action: 'ADMIN_PASSWORD_RESET_INITIATED',
      resource: 'administrators',
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      details: {
        targetUserId,
        targetEmail: targetUser.email,
      },
    });

    ResponseUtil.success(res, {
      message: 'تم إرسال رابط وإشعار إعادة تعيين كلمة المرور إلى البريد الإلكتروني للمشرف وإنهاء جلساته الحالية.',
    });
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 8. VIEW ADMINISTRATOR AUDIT HISTORY
// ==============================================================================
router.get('/:id/audit', requirePermission('audit:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.id);
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 30, 100);

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { email: true },
    });

    if (!targetUser) {
      throw new AppError('المشرف غير موجود.', 404);
    }

    const where: any = {
      OR: [
        { userId: targetUserId },
        { details: { contains: targetUserId } },
        { details: { contains: targetUser.email } },
      ],
    };

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      }),
    ]);

    ResponseUtil.success(res, {
      logs,
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

export const adminUsersRoutes = router;
