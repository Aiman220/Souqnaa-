import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { AppError } from '../../middleware/error.middleware';

export enum SystemRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  FINANCE_ADMIN = 'FINANCE_ADMIN',
  SELLER_ORDER_ADMIN = 'SELLER_ORDER_ADMIN',
  CUSTOMER_SUPPORT = 'CUSTOMER_SUPPORT',
  CONTENT_MARKETING_ADMIN = 'CONTENT_MARKETING_ADMIN',
}

export interface PermissionDefinition {
  action: string;
  description: string;
}

export const SYSTEM_PERMISSIONS: PermissionDefinition[] = [
  // System Overview & KPIs
  { action: 'dashboard:view', description: 'عرض لوحة المؤشرات العامة والعمليات الحية (Live KPIs)' },

  // Orders & Shipments
  { action: 'orders:view', description: 'عرض واستعراض الطلبات وسجل الحالات' },
  { action: 'orders:manage', description: 'تعديل حالات الطلبات والشحن وإلغاء الطلبات' },

  // Sellers & Stores
  { action: 'sellers:view', description: 'عرض قائمة التجار وملفات التوثيق' },
  { action: 'sellers:approve', description: 'الموافقة على طلبات انضمام التجار أو تعليقها' },
  { action: 'seller_performance:view', description: 'عرض مؤشرات ودرجات أداء البائعين وتاريخ السجل' },
  { action: 'seller_performance:recalculate', description: 'إعادة احتساب مؤشرات أداء البائع يدوياً' },
  { action: 'seller_performance:manage_config', description: 'تعديل أوزان وإعدادات محرك تقييم الأداء' },
  { action: 'seller_performance:export', description: 'تصدير تقارير وبيانات أداء التجار' },
  { action: 'stores:view', description: 'استعراض المتاجر المعتمدة ومواقعها الجغرافية' },
  { action: 'stores:manage', description: 'إدارة وتعديل بيانات المتاجر المعتمدة' },

  // Customers CRM & VIP Membership
  { action: 'customers:view', description: 'عرض وإدارة ملفات العملاء وسجل المشتريات (CRM)' },
  { action: 'customers:manage', description: 'تعديل وتجميد وتحديث حسابات العملاء' },
  { action: 'membership:manage', description: 'إدارة عضويات ومستويات VIP وشروط الترقية' },

  // Catalog & Inventory
  { action: 'products:view', description: 'عرض الكتالوج والمنتجات' },
  { action: 'products:manage', description: 'اعتماد، إيقاف وحذف المنتجات المخالفة' },
  { action: 'categories:manage', description: 'إدارة شجرة التصنيفات والماركات' },

  // Logistics & Delivery
  { action: 'delivery:manage', description: 'إدارة مناطق التغطية ومحرك تسعير وجداول الشحن' },
  { action: 'delivery_schedule:manage', description: 'إدارة مواعيد الشحن وجدولة السعة اللوجستية' },

  // Finance & Wallet
  { action: 'finance:view', description: 'الاطلاع على المؤشرات المالية والأرصدة' },
  { action: 'finance:withdrawals', description: 'الموافقة على طلبات السحب وتنفيذ الحوالات' },
  { action: 'finance:commissions', description: 'إدارة منظومة العمولات الرباعية والضرائب' },
  { action: 'tax:manage', description: 'إدارة محرك الضرائب، نسب القيمة المضافة والإعفاءات (Tax Engine)' },
  { action: 'seller_financial_risk:view', description: 'عرض مؤشرات المخاطر المالية واحتياطيات التجار والانكشاف المالي' },
  { action: 'seller_financial_risk:manage', description: 'تعديل سياسات المخاطر، نسب الاحتياطي، وتقييد/إلغاء تقييد البائعين' },
  { action: 'seller_reserve:adjust', description: 'تعديل أو الإفراج الاستثنائي عن مبالغ الاحتياطي المالي للبائعين' },
  { action: 'seller_debt:reconcile', description: 'إجراء مطابقة المديونيات وتسوية الفروقات المالية (Reconciliation)' },

  // Customer Support & Disputes
  { action: 'disputes:resolve', description: 'فض النزاعات واعتماد الاسترجاع المالي للعملاء' },
  { action: 'support:view', description: 'استعراض تذاكر ومحادثات الدعم الفني ومراقبة الطوابير' },
  { action: 'support:manage', description: 'إدارة موظفي الدعم، الأقسام، الردود الجاهزة، وسياسات SLA' },

  // Marketing, Growth & Rewards
  { action: 'marketing:manage', description: 'إدارة الكوبونات، عروض Flash Sale وقسائم الخصم' },
  { action: 'campaigns:manage', description: 'إدارة الحملات والبانرات التسويقية والشارات الترويجية' },
  { action: 'rewards:manage', description: 'إدارة منظومة عملات ومكافآت سوقنا (Coins Engine)' },

  // Content Moderation
  { action: 'reviews:moderate', description: 'مراقبة وإخفاء/استعادة تقييمات العملاء والرد عليها' },

  // Intelligence & Reports
  { action: 'reports:view', description: 'استعراض تقارير الأعمال وتصدير ملفات البيانات (BI & Analytics)' },

  // Communications
  { action: 'notifications:broadcast', description: 'إرسال وبث الإشعارات الجماعية والمجدولة' },

  // System & Platform Configuration
  { action: 'settings:manage', description: 'تعديل الإعدادات العامة وضبط النظام' },
  { action: 'roles:manage', description: 'إدارة الأدوار ومصفوفة الصلاحيات (RBAC)' },
  { action: 'feature_flags:manage', description: 'التحكم عن بعد وميزات النظام (Feature Flags & Remote Config)' },
  { action: 'app_management:manage', description: 'إدارة إصدارات التطبيقات، التحديث الإجباري ووضع الصيانة' },

  // Administrator Governance
  { action: 'admins:view', description: 'عرض قائمة مسؤولي ومشرفي النظام' },
  { action: 'admins:manage', description: 'إنشاء وتعديل وتجميد حسابات المشرفين وإدارة جلساتهم' },

  // Audit Logs
  { action: 'audit:view', description: 'استعراض سجل الرقابة والتدقيق غير القابل للتعديل' },
];

export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRole, string[]> = {
  [SystemRole.SUPER_ADMIN]: SYSTEM_PERMISSIONS.map((p) => p.action),

  [SystemRole.FINANCE_ADMIN]: [
    'dashboard:view',
    'finance:view',
    'finance:withdrawals',
    'finance:commissions',
    'tax:manage',
    'rewards:manage',
    'disputes:resolve',
    'reports:view',
    'orders:view',
    'sellers:view',
    'seller_financial_risk:view',
    'seller_financial_risk:manage',
    'seller_reserve:adjust',
    'seller_debt:reconcile',
    'audit:view',
  ],

  [SystemRole.SELLER_ORDER_ADMIN]: [
    'dashboard:view',
    'orders:view',
    'orders:manage',
    'sellers:view',
    'sellers:approve',
    'stores:view',
    'stores:manage',
    'seller_performance:view',
    'seller_performance:recalculate',
    'seller_performance:export',
    'products:view',
    'products:manage',
    'categories:manage',
    'delivery:manage',
    'delivery_schedule:manage',
    'reviews:moderate',
    'reports:view',
  ],

  [SystemRole.CUSTOMER_SUPPORT]: [
    'dashboard:view',
    'support:view',
    'support:manage',
    'customers:view',
    'orders:view',
    'sellers:view',
    'stores:view',
    'products:view',
    'disputes:resolve',
    'reviews:moderate',
    'reports:view',
  ],

  [SystemRole.CONTENT_MARKETING_ADMIN]: [
    'dashboard:view',
    'marketing:manage',
    'campaigns:manage',
    'rewards:manage',
    'categories:manage',
    'products:view',
    'reviews:moderate',
    'notifications:broadcast',
    'reports:view',
  ],
};

export const SYSTEM_ROLE_DESCRIPTIONS: Record<SystemRole, string> = {
  [SystemRole.SUPER_ADMIN]: 'مدير عام النظام — كامل الصلاحيات الإدارية والسيادية للمنصة',
  [SystemRole.FINANCE_ADMIN]: 'المدير المالي — إدارة التسويات، السحوبات، نسب العمولات، الضرائب والتقارير المالية',
  [SystemRole.SELLER_ORDER_ADMIN]: 'مدير المتاجر والطلبات — متابعة العمليات اللوجستية، اعتماد المتاجر وإدارة شجرة الكتالوج',
  [SystemRole.CUSTOMER_SUPPORT]: 'خدمة العملاء والدعم الفني — متابعة التذاكر، معالجة النزاعات، واستعراض الطلبات',
  [SystemRole.CONTENT_MARKETING_ADMIN]: 'مدير المحتوى والتسويق — تنظيم الحملات، إدارة القسائم، الكوبونات والبانرات الإعلانية',
};

export class AdminRbacService {
  /**
   * Initializes or updates all system permissions and default roles in the database.
   * Concurrency-safe and idempotent.
   */
  public static async ensureSystemRolesAndPermissions(): Promise<void> {
    // 1. Ensure all permissions exist
    const permissionMap = new Map<string, string>();
    for (const p of SYSTEM_PERMISSIONS) {
      const existing = await prisma.permission.findFirst({
        where: { action: p.action },
      });
      if (existing) {
        permissionMap.set(p.action, existing.id);
        if (existing.description !== p.description) {
          await prisma.permission.update({
            where: { id: existing.id },
            data: { description: p.description },
          });
        }
      } else {
        const created = await prisma.permission.create({
          data: { action: p.action, description: p.description },
        });
        permissionMap.set(p.action, created.id);
      }
    }

    // 2. Ensure all 5 system roles exist with their assigned permissions
    for (const roleKey of Object.values(SystemRole)) {
      const roleName = roleKey;
      const description = SYSTEM_ROLE_DESCRIPTIONS[roleKey];
      const targetActionList = SYSTEM_ROLE_PERMISSIONS[roleKey];

      let role = await prisma.role.findUnique({
        where: { name: roleName },
      });

      if (!role) {
        role = await prisma.role.create({
          data: {
            name: roleName,
            description,
          },
        });
      } else if (!role.description) {
        await prisma.role.update({
          where: { id: role.id },
          data: { description },
        });
      }

      // Link permissions to role
      const existingRolePerms = await prisma.rolePermission.findMany({
        where: { roleId: role.id },
        select: { permissionId: true },
      });
      const existingPermIds = new Set(existingRolePerms.map((rp) => rp.permissionId));

      const missingPermIds: string[] = [];
      for (const action of targetActionList) {
        const permId = permissionMap.get(action);
        if (permId && !existingPermIds.has(permId)) {
          missingPermIds.push(permId);
        }
      }

      if (missingPermIds.length > 0) {
        await prisma.rolePermission.createMany({
          data: missingPermIds.map((pId) => ({
            roleId: role.id,
            permissionId: pId,
          })),
          skipDuplicates: true,
        });
      }
    }
  }

  /**
   * Returns all role names assigned to a specific user.
   */
  public static async getUserRoleNames(userId: string): Promise<string[]> {
    const userRoles = await prisma.userRole.findMany({
      where: { userId },
      include: { role: { select: { name: true } } },
    });
    return userRoles.map((ur) => ur.role.name);
  }

  /**
   * Returns all distinct permission actions granted to a user through their roles.
   */
  public static async getUserPermissions(userId: string): Promise<Set<string>> {
    const userRoles = await prisma.userRole.findMany({
      where: { userId },
      include: {
        role: {
          include: {
            permissions: {
              include: { permission: true },
            },
          },
        },
      },
    });

    const permissions = new Set<string>();
    for (const ur of userRoles) {
      if (ur.role.name === SystemRole.SUPER_ADMIN) {
        // SUPER_ADMIN has every permission implicitly
        SYSTEM_PERMISSIONS.forEach((p) => permissions.add(p.action));
        return permissions;
      }
      for (const rp of ur.role.permissions) {
        if (rp.permission?.action) {
          permissions.add(rp.permission.action);
        }
      }
    }
    return permissions;
  }

  /**
   * Checks whether a user possesses the SUPER_ADMIN role.
   */
  public static async isSuperAdmin(userId: string): Promise<boolean> {
    const superAdminRole = await prisma.role.findUnique({
      where: { name: SystemRole.SUPER_ADMIN },
    });
    if (!superAdminRole) return false;

    const assignment = await prisma.userRole.findUnique({
      where: {
        userId_roleId: {
          userId,
          roleId: superAdminRole.id,
        },
      },
    });
    return Boolean(assignment);
  }

  /**
   * Counts the number of active administrators who hold the SUPER_ADMIN role.
   */
  public static async countActiveSuperAdmins(): Promise<number> {
    const superAdminRole = await prisma.role.findUnique({
      where: { name: SystemRole.SUPER_ADMIN },
    });
    if (!superAdminRole) return 0;

    const count = await prisma.userRole.count({
      where: {
        roleId: superAdminRole.id,
        user: {
          isActive: true,
          role: 'ADMIN',
        },
      },
    });
    return count;
  }

  /**
   * Checks whether removing a role or deactivating a user would violate the Last Active SUPER_ADMIN invariant.
   */
  public static async assertNotLastActiveSuperAdmin(targetUserId: string, operationDescription: string): Promise<void> {
    const isTargetSuperAdmin = await this.isSuperAdmin(targetUserId);
    if (!isTargetSuperAdmin) {
      return; // Target is not a super admin, operation is safe
    }

    const activeCount = await this.countActiveSuperAdmins();
    if (activeCount <= 1) {
      throw new AppError(
        `لا يمكن تنفيذ (${operationDescription}): هذا هو آخر مدير عام نشط (SUPER_ADMIN) في النظام. يجب تعيين مدير عام آخر قبل إيقاف أو تعديل هذا الحساب.`,
        400,
        'LAST_SUPER_ADMIN_PROTECTION'
      );
    }
  }

  /**
   * Validates that the acting administrator has authority to assign the requested roles.
   * Non-SUPER_ADMIN cannot grant SUPER_ADMIN or escalate privileges.
   */
  public static async assertCanAssignRoles(actorUserId: string, targetRoleNames: string[]): Promise<void> {
    const actorIsSuperAdmin = await this.isSuperAdmin(actorUserId);

    if (targetRoleNames.includes(SystemRole.SUPER_ADMIN) && !actorIsSuperAdmin) {
      throw new AppError(
        'غير مصرح: لا يمكن منح دور المدير العام (SUPER_ADMIN) إلا بواسطة مدير عام آخر.',
        403,
        'SUPER_ADMIN_ESCALATION_DENIED'
      );
    }

    if (!actorIsSuperAdmin) {
      // Actor cannot assign roles they do not personally hold
      const actorRoles = await this.getUserRoleNames(actorUserId);
      const actorRoleSet = new Set(actorRoles);
      for (const r of targetRoleNames) {
        if (!actorRoleSet.has(r)) {
          throw new AppError(
            `غير مصرح: لا يمكنك تعيين دور [${r}] لأنك لا تملك صلاحيات هذا الدور.`,
            403,
            'PRIVILEGE_ESCALATION_DENIED'
          );
        }
      }
    }
  }

  /**
   * Retrieves user IDs of all active administrators who possess the specified action permission.
   * Note: SUPER_ADMIN users possess all permissions implicitly.
   */
  public static async getAdminUserIdsWithPermission(action: string): Promise<string[]> {
    const activeAdmins = await prisma.user.findMany({
      where: {
        role: 'ADMIN',
        isActive: true,
      },
      select: {
        id: true,
      },
    });

    const matchingAdminIds: string[] = [];
    for (const admin of activeAdmins) {
      const perms = await this.getUserPermissions(admin.id);
      if (perms.has(action)) {
        matchingAdminIds.push(admin.id);
      }
    }

    if (matchingAdminIds.length === 0) {
      const superAdmins = await this.getAdminUserIdsWithRole(SystemRole.SUPER_ADMIN);
      if (superAdmins.length > 0) return superAdmins;
      return activeAdmins.map((a) => a.id);
    }

    return matchingAdminIds;
  }

  /**
   * Retrieves user IDs of all active administrators who hold a specific role.
   */
  public static async getAdminUserIdsWithRole(roleName: SystemRole | string): Promise<string[]> {
    const role = await prisma.role.findUnique({
      where: { name: roleName },
    });
    if (!role) {
      return [];
    }

    const assignments = await prisma.userRole.findMany({
      where: {
        roleId: role.id,
        user: {
          role: 'ADMIN',
          isActive: true,
        },
      },
      select: { userId: true },
    });
    return assignments.map((a) => a.userId);
  }
}
