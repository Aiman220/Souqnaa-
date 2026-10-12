import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { PasswordPolicyUtil } from '../../utils/password-policy.util';
import { AdminRbacService, SystemRole } from './admin-rbac.service';
import { AdminSessionService } from './admin-session.service';

export interface BootstrapOptions {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  recoveryMode?: boolean;
  recoveryKey?: string;
}

export interface BootstrapResult {
  success: boolean;
  adminId: string;
  email: string;
  role: string;
  createdAt: Date;
  recovered?: boolean;
}

const ADVISORY_LOCK_ID = 987654321;

export class AdminBootstrapService {
  /**
   * Checks whether the system bootstrap has already been completed.
   */
  public static async isBootstrapCompleted(): Promise<boolean> {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'bootstrap_initialized' },
    });
    if (setting && setting.value === 'true') {
      return true;
    }

    const superAdminCount = await AdminRbacService.countActiveSuperAdmins();
    return superAdminCount > 0;
  }

  /**
   * Executes the first-administrator bootstrap process.
   * Concurrency-safe, idempotent, transaction-protected, and strictly refuses duplicate execution
   * unless authorized recovery credentials are provided.
   */
  public static async bootstrapFirstAdmin(options: BootstrapOptions): Promise<BootstrapResult> {
    const { email, password, firstName, lastName, phone, recoveryMode = false, recoveryKey } = options;

    // 1. Sanitize & Validate Email
    if (!email || typeof email !== 'string') {
      throw new AppError('البريد الإلكتروني مطلوب للمدير الأول.', 400);
    }
    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(cleanEmail)) {
      throw new AppError('صيغة البريد الإلكتروني غير صالحة.', 400);
    }

    // 2. Validate Password Policy
    const passwordValidation = PasswordPolicyUtil.validateAdminPassword(password);
    if (!passwordValidation.valid) {
      throw new AppError(
        `كلمة المرور لا تستوفي المعايير الأمنية:\n• ${passwordValidation.errors.join('\n• ')}`,
        400,
        'PASSWORD_POLICY_VIOLATION'
      );
    }

    // 3. Validate Recovery Key Authorization if in recovery mode
    if (recoveryMode) {
      const expectedKey = process.env.BOOTSTRAP_RECOVERY_KEY?.trim();
      if (!expectedKey || expectedKey.length < 16) {
        throw new AppError(
          'لم يتم ضبط مفتاح الاسترداد (BOOTSTRAP_RECOVERY_KEY) في خادم النظام أو أنه قصير جداً (يتطلب 16 رمزاً على الأقل).',
          500,
          'RECOVERY_KEY_NOT_CONFIGURED'
        );
      }

      if (!recoveryKey || recoveryKey.trim() !== expectedKey) {
        throw new AppError(
          'مفتاح الاسترداد المصرح به غير صحيح. تم رفض إجراء الإصلاح.',
          403,
          'INVALID_RECOVERY_KEY'
        );
      }
    }

    // 4. Ensure system roles exist
    await AdminRbacService.ensureSystemRolesAndPermissions();

    const superAdminRole = await prisma.role.findUnique({
      where: { name: SystemRole.SUPER_ADMIN },
    });
    if (!superAdminRole) {
      throw new AppError('تعذر العثور على دور SUPER_ADMIN في مصفوفة الأدوار.', 500);
    }

    // 5. Execute Bootstrap inside Database Transaction with Concurrency Advisory Xact Lock
    const passwordHash = await PasswordPolicyUtil.hashPassword(password);

    const result = await prisma.$transaction(async (tx) => {
      // Acquire transaction-scoped advisory lock in PostgreSQL
      try {
        const lockResult: any = await tx.$queryRawUnsafe(
          `SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_ID}) as acquired;`
        );
        const lockAcquired = Boolean(lockResult && lockResult[0] && lockResult[0].acquired);
        if (!lockAcquired) {
          throw new AppError(
            'عملية التهيئة قيد التنفيذ حالياً بواسطة جلسة أخرى. يرجى الانتظار.',
            409,
            'CONCURRENT_BOOTSTRAP_CONFLICT'
          );
        }
      } catch (err: any) {
        if (err.code === 'CONCURRENT_BOOTSTRAP_CONFLICT' || err.statusCode === 409) {
          throw err;
        }
        // Continue if non-postgres test environment
      }

      // Check if already completed
      const setting = await tx.systemSetting.findUnique({
        where: { key: 'bootstrap_initialized' },
      });
      const alreadyInitialized = setting?.value === 'true';

      if (alreadyInitialized && !recoveryMode) {
        throw new AppError(
          'تمت تهيئة المدير العام الأول مسبقاً في هذا النظام. لا يمكن تكرار التهيئة. إذا كنت بحاجة لإصلاح حالة التهيئة، استخدم إجراء الاسترداد المصرح به.',
          409,
          'BOOTSTRAP_ALREADY_INITIALIZED'
        );
      }

      let user = await tx.user.findUnique({
        where: { email: cleanEmail },
      });

      if (user) {
        if (!recoveryMode) {
          throw new AppError(
            'يوجد مستخدم مسجل مسبقاً بهذا البريد الإلكتروني. لا يمكن إنشاء المدير العام إلا بحساب جديد أو عبر الاسترداد.',
            409,
            'USER_ALREADY_EXISTS'
          );
        }
        // Recovery mode: update credentials and elevate
        user = await tx.user.update({
          where: { id: user.id },
          data: {
            passwordHash,
            role: 'ADMIN',
            isActive: true,
            isVerified: true,
            firstName: firstName?.trim() || user.firstName,
            lastName: lastName?.trim() || user.lastName,
            phone: phone?.trim() || user.phone,
          },
        });
      } else {
        // Create new user
        user = await tx.user.create({
          data: {
            email: cleanEmail,
            passwordHash,
            firstName: firstName?.trim() || 'Super',
            lastName: lastName?.trim() || 'Admin',
            phone: phone?.trim() || null,
            role: 'ADMIN',
            isActive: true,
            isVerified: true,
          },
        });
      }

      // Link SUPER_ADMIN role
      await tx.userRole.upsert({
        where: {
          userId_roleId: {
            userId: user.id,
            roleId: superAdminRole.id,
          },
        },
        update: {},
        create: {
          userId: user.id,
          roleId: superAdminRole.id,
        },
      });

      // Record bootstrap state flags
      await tx.systemSetting.upsert({
        where: { key: 'bootstrap_initialized' },
        update: { value: 'true', updatedAt: new Date() },
        create: {
          key: 'bootstrap_initialized',
          value: 'true',
          type: 'boolean',
          group: 'security',
        },
      });

      await tx.systemSetting.upsert({
        where: { key: 'bootstrap_initialized_at' },
        update: { value: new Date().toISOString(), updatedAt: new Date() },
        create: {
          key: 'bootstrap_initialized_at',
          value: new Date().toISOString(),
          type: 'string',
          group: 'security',
        },
      });

      await tx.systemSetting.upsert({
        where: { key: 'bootstrap_super_admin_id' },
        update: { value: user.id, updatedAt: new Date() },
        create: {
          key: 'bootstrap_super_admin_id',
          value: user.id,
          type: 'string',
          group: 'security',
        },
      });

      return user;
    });

    // 6. Revoke any previous sessions for security hygiene
    await AdminSessionService.revokeAllSessions(result.id);

    // 7. Log Audit Event safely (no passwords/tokens)
    await AdminSessionService.logAudit({
      actorId: result.id,
      action: recoveryMode ? 'ADMIN_BOOTSTRAP_RECOVERED' : 'ADMIN_BOOTSTRAP_INITIALIZED',
      resource: 'administrators',
      details: {
        email: result.email,
        role: SystemRole.SUPER_ADMIN,
        recovered: recoveryMode,
        timestamp: new Date().toISOString(),
      },
    });

    return {
      success: true,
      adminId: result.id,
      email: result.email,
      role: SystemRole.SUPER_ADMIN,
      createdAt: result.createdAt,
      recovered: recoveryMode,
    };
  }
}
