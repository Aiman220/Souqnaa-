import { Request } from 'express';
import crypto from 'crypto';
import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { SocketService } from '../../services/websocket/socket.service';
import {
  AppBrandingConfig,
  DEFAULT_APP_BRANDING,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_WALLET_PROVIDERS,
  FeatureFlagSeedDefinition,
  PlatformAppIconConfig,
  WalletProviderConfig,
  PlatformWalletAccountConfig,
  DEFAULT_PLATFORM_WALLETS,
} from './feature-flags.defaults';

export interface ClientEvaluationContext {
  platform?: 'android' | 'ios' | 'web' | string;
  userId?: string;
  deviceId?: string;
  userRole?: string;
  ifNoneMatch?: string;
  clientVersion?: number;
}

export interface EffectiveFeatureFlag {
  key: string;
  enabled: boolean;
  displayNameAr: string;
  displayNameEn: string;
  descriptionAr?: string;
  descriptionEn?: string;
  maintenanceMessageAr?: string;
  maintenanceMessageEn?: string;
  isSensitive: boolean;
  rolloutPercentage: number;
  inRolloutGroup: boolean;
  isScheduled: boolean;
  startDate?: string | null;
  endDate?: string | null;
  platforms: string[];
  dependencies: string[];
  metadata: Record<string, any>;
  configVersion: number;
  updatedAt: string;
}

export interface ResolvedRemoteConfigResponse {
  modified: boolean;
  configVersion: number;
  etag: string;
  updatedAt: string;
  features: Record<string, boolean>;
  details: Record<string, EffectiveFeatureFlag>;
  walletProviders: Record<string, WalletProviderConfig>;
  branding: AppBrandingConfig;
  platformWallets: PlatformWalletAccountConfig[];
}

export class RemoteConfigService {
  private static instance: RemoteConfigService;
  private memoryCache: {
    flags: any[];
    branding: AppBrandingConfig;
    platformWallets: PlatformWalletAccountConfig[];
    version: number;
    updatedAt: Date;
    etag: string;
    cachedAt: number;
  } | null = null;

  private readonly CACHE_TTL_MS = 5000; // 5-second in-memory cache to handle heavy traffic

  public static getInstance(): RemoteConfigService {
    if (!RemoteConfigService.instance) {
      RemoteConfigService.instance = new RemoteConfigService();
    }
    return RemoteConfigService.instance;
  }

  /**
   * Deterministic bucket assignment (0-90) using SHA256 of identifier + salt.
   * Ensures the exact same user/device consistently lands in the same rollout cohort.
   */
  public computeRolloutBucket(identifier: string, salt: string = 'souqna_rollout'): number {
    const hash = crypto.createHash('sha256').update(`${salt}:${identifier}`).digest('hex');
    const integer = parseInt(hash.substring(0, 8), 16);
    return integer % 100;
  }

  /**
   * Ensure default feature flags are seeded and populated in the database.
   */
  public async ensureInitialized(): Promise<void> {
    try {
      const count = await prisma.featureFlag.count();
      if (count >= DEFAULT_FEATURE_FLAGS.length) {
        return;
      }

      for (const def of DEFAULT_FEATURE_FLAGS) {
        const existing = await prisma.featureFlag.findUnique({
          where: { key: def.key },
        });

        if (!existing) {
          await prisma.featureFlag.create({
            data: {
              key: def.key,
              enabled: def.enabled,
              displayNameAr: def.displayNameAr,
              displayNameEn: def.displayNameEn,
              descriptionAr: def.descriptionAr,
              descriptionEn: def.descriptionEn,
              maintenanceMessageAr: def.maintenanceMessageAr,
              maintenanceMessageEn: def.maintenanceMessageEn,
              isSensitive: def.isSensitive,
              rolloutPercentage: def.rolloutPercentage,
              platforms: JSON.stringify(def.platforms),
              dependencies: JSON.stringify(def.dependencies),
              metadata: JSON.stringify(def.metadata || {}),
              configVersion: 1,
              updatedBy: 'SYSTEM_BOOTSTRAP',
            },
          });
        }
      }

      // Ensure global version exists
      await prisma.systemSetting.upsert({
        where: { key: 'remote_config_version' },
        create: {
          key: 'remote_config_version',
          value: '1',
          type: 'number',
          group: 'remote_config',
        },
        update: {},
      });
      // Ensure platform wallet accounts exist
      const existingWalletAccounts = await prisma.systemSetting.findUnique({
        where: { key: 'platform_wallet_accounts' },
      });
      if (!existingWalletAccounts) {
        await prisma.systemSetting.create({
          data: {
            key: 'platform_wallet_accounts',
            value: JSON.stringify(DEFAULT_PLATFORM_WALLETS),
            type: 'json',
            group: 'remote_config',
          },
        });
      }
    } catch (error) {
      console.error('[RemoteConfigService] Failed to initialize default feature flags:', error);
    }
  }

  /**
   * Invalidate memory cache on any update.
   */
  public invalidateCache(): void {
    this.memoryCache = null;
  }

  /**
   * Broadcast configuration update to all connected clients in real time via WebSocket.
   */
  public broadcastConfigUpdate(metadata?: { key?: string; action?: string; version?: number }): void {
    try {
      const socketSvc = SocketService.get();
      if (socketSvc) {
        const payload = {
          timestamp: new Date().toISOString(),
          version: metadata?.version || Date.now(),
          key: metadata?.key,
          action: metadata?.action || 'UPDATE',
        };
        socketSvc.emitGlobal('remote_config:updated', payload);
        if (metadata?.key) {
          socketSvc.emitGlobal('feature_flag:updated', payload);
        }
      }
    } catch (err) {
      console.error('[RemoteConfigService] Failed to broadcast config update:', err);
    }
  }

  /**
   * Load all raw flags with caching.
   */
  private async getRawFlags(): Promise<{
    flags: any[];
    branding: AppBrandingConfig;
    platformWallets: PlatformWalletAccountConfig[];
    version: number;
    updatedAt: Date;
    etag: string;
  }> {
    const now = Date.now();
    if (this.memoryCache && now - this.memoryCache.cachedAt < this.CACHE_TTL_MS) {
      return this.memoryCache;
    }

    await this.ensureInitialized();

    const flags = await prisma.featureFlag.findMany({
      orderBy: { createdAt: 'asc' },
    });

    const versionSetting = await prisma.systemSetting.findUnique({
      where: { key: 'remote_config_version' },
    });

    const version = versionSetting ? parseInt(versionSetting.value, 10) || 1 : 1;

    const brandingSetting = await prisma.systemSetting.findUnique({
      where: { key: 'app_branding_config' },
    });

    let branding: AppBrandingConfig = { ...DEFAULT_APP_BRANDING };
    if (brandingSetting && brandingSetting.value) {
      try {
        const parsed = JSON.parse(brandingSetting.value);
        branding = {
          ...DEFAULT_APP_BRANDING,
          ...parsed,
          platforms: {
            ...DEFAULT_APP_BRANDING.platforms,
            ...(parsed.platforms || {}),
          },
          seasonalIcon: {
            ...DEFAULT_APP_BRANDING.seasonalIcon,
            ...(parsed.seasonalIcon || {}),
          },
        };
      } catch (_) {}
    }

    const platformWalletsSetting = await prisma.systemSetting.findUnique({
      where: { key: 'platform_wallet_accounts' },
    });

    let platformWallets: PlatformWalletAccountConfig[] = DEFAULT_PLATFORM_WALLETS;
    if (platformWalletsSetting && platformWalletsSetting.value) {
      try {
        const parsed = JSON.parse(platformWalletsSetting.value);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const parsedMap = new Map(parsed.map((a: PlatformWalletAccountConfig) => [a.provider, a]));
          platformWallets = DEFAULT_PLATFORM_WALLETS.map(def => parsedMap.get(def.provider) || def);
        }
      } catch (_) {}
    }

    let latestUpdate = new Date(0);
    for (const f of flags) {
      if (f.updatedAt > latestUpdate) {
        latestUpdate = f.updatedAt;
      }
    }
    if (brandingSetting && brandingSetting.updatedAt > latestUpdate) {
      latestUpdate = brandingSetting.updatedAt;
    }
    if (platformWalletsSetting && platformWalletsSetting.updatedAt > latestUpdate) {
      latestUpdate = platformWalletsSetting.updatedAt;
    }

    const etag = `W/"souqnaa-config-v${version}-${latestUpdate.getTime()}"`;

    this.memoryCache = {
      flags,
      branding,
      platformWallets,
      version,
      updatedAt: latestUpdate,
      etag,
      cachedAt: now,
    };

    return this.memoryCache;
  }

  /**
   * Resolve public configuration for clients.
   * Evaluates platform, schedule, deterministic rollout, feature dependencies, and branding.
   */
  public async getResolvedConfig(
    context: ClientEvaluationContext = {}
  ): Promise<ResolvedRemoteConfigResponse> {
    const { flags, branding, version, updatedAt, etag } = await this.getRawFlags();

    // Check ETag or version header / query
    if (context.ifNoneMatch && context.ifNoneMatch === etag) {
      return {
        modified: false,
        configVersion: version,
        etag,
        updatedAt: updatedAt.toISOString(),
        features: {},
        details: {},
        walletProviders: {},
        branding,
        platformWallets: [],
      };
    }

    if (context.clientVersion && context.clientVersion === version) {
      return {
        modified: false,
        configVersion: version,
        etag,
        updatedAt: updatedAt.toISOString(),
        features: {},
        details: {},
        walletProviders: {},
        branding,
        platformWallets: [],
      };
    }

    const now = new Date();
    const effectiveFeatures: Record<string, boolean> = {};
    const effectiveDetails: Record<string, EffectiveFeatureFlag> = {};
    let resolvedWalletProviders: Record<string, WalletProviderConfig> = { ...DEFAULT_WALLET_PROVIDERS };

    const parsedFlags = flags.map((f) => {
      let platforms: string[] = ['android', 'ios', 'web'];
      let dependencies: string[] = [];
      let metadata: Record<string, any> = {};

      try {
        platforms = typeof f.platforms === 'string' ? JSON.parse(f.platforms) : f.platforms;
      } catch (_) {}

      try {
        dependencies = typeof f.dependencies === 'string' ? JSON.parse(f.dependencies) : f.dependencies;
      } catch (_) {}

      try {
        metadata = typeof f.metadata === 'string' ? JSON.parse(f.metadata) : f.metadata;
      } catch (_) {}

      return {
        ...f,
        parsedPlatforms: platforms,
        parsedDependencies: dependencies,
        parsedMetadata: metadata,
      };
    });

    // 1. First Pass: Base enablement, schedule, platform, rollout
    for (const f of parsedFlags) {
      let isEnabled = f.enabled;
      let inRolloutGroup = true;
      let isScheduled = false;

      // Scheduled activation & expiration
      if (f.startDate && now < new Date(f.startDate)) {
        isEnabled = false;
        isScheduled = true;
      }
      if (f.endDate && now > new Date(f.endDate)) {
        isEnabled = false;
        isScheduled = true;
      }

      // Platform targeting
      if (isEnabled && context.platform) {
        const normPlatform = context.platform.toLowerCase();
        if (!f.parsedPlatforms.includes(normPlatform)) {
          isEnabled = false;
        }
      }

      // Rollout percentage
      const rollout = f.rolloutPercentage ?? 100;
      if (isEnabled && rollout < 100) {
        const identifier = context.userId || context.deviceId;
        if (identifier) {
          const bucket = this.computeRolloutBucket(identifier, f.key);
          inRolloutGroup = bucket < rollout;
          if (!inRolloutGroup) {
            isEnabled = false;
          }
        } else if (rollout <= 0) {
          isEnabled = false;
          inRolloutGroup = false;
        }
      }

      effectiveFeatures[f.key] = isEnabled;

      effectiveDetails[f.key] = {
        key: f.key,
        enabled: isEnabled,
        displayNameAr: f.displayNameAr,
        displayNameEn: f.displayNameEn,
        descriptionAr: f.descriptionAr || undefined,
        descriptionEn: f.descriptionEn || undefined,
        maintenanceMessageAr: f.maintenanceMessageAr || undefined,
        maintenanceMessageEn: f.maintenanceMessageEn || undefined,
        isSensitive: f.isSensitive,
        rolloutPercentage: f.rolloutPercentage,
        inRolloutGroup,
        isScheduled,
        startDate: f.startDate ? f.startDate.toISOString() : null,
        endDate: f.endDate ? f.endDate.toISOString() : null,
        platforms: f.parsedPlatforms,
        dependencies: f.parsedDependencies,
        metadata: f.parsedMetadata,
        configVersion: f.configVersion,
        updatedAt: f.updatedAt.toISOString(),
      };

      // Extract wallet providers if this is electronic_wallet_providers
      if (f.key === 'electronic_wallet_providers' && f.parsedMetadata?.providers) {
        resolvedWalletProviders = f.parsedMetadata.providers;
      }
    }

    // 2. Second Pass: Feature Dependencies Resolution
    // E.g., scheduled_delivery requires standard_delivery; express_delivery requires standard_delivery
    for (const f of parsedFlags) {
      if (effectiveFeatures[f.key]) {
        for (const depKey of f.parsedDependencies) {
          if (!effectiveFeatures[depKey]) {
            effectiveFeatures[f.key] = false;
            if (effectiveDetails[f.key]) {
              effectiveDetails[f.key].enabled = false;
            }
            break;
          }
        }
      }
    }

    // If electronic_wallet_providers flag is disabled, all wallet providers become effectively disabled
    if (!effectiveFeatures['electronic_wallet_providers']) {
      const disabledProviders: Record<string, WalletProviderConfig> = {};
      for (const [code, prov] of Object.entries(resolvedWalletProviders)) {
        disabledProviders[code] = { ...prov, enabled: false };
      }
      resolvedWalletProviders = disabledProviders;
    }

    const activeBranding: AppBrandingConfig = {
      ...branding,
      platforms: { ...branding.platforms },
    };

    // Seasonal / Promotional Icon Override
    if (activeBranding.seasonalIcon?.enabled && activeBranding.seasonalIcon.iconUrl) {
      let isSeasonActive = true;
      if (activeBranding.seasonalIcon.startDate && now < new Date(activeBranding.seasonalIcon.startDate)) {
        isSeasonActive = false;
      }
      if (activeBranding.seasonalIcon.endDate && now > new Date(activeBranding.seasonalIcon.endDate)) {
        isSeasonActive = false;
      }

      if (isSeasonActive) {
        for (const p of ['android', 'ios', 'tablet', 'desktop', 'web'] as const) {
          if (activeBranding.platforms[p]) {
            activeBranding.platforms[p] = {
              ...activeBranding.platforms[p],
              iconUrl: activeBranding.seasonalIcon.iconUrl,
              deepLinkUrl: activeBranding.seasonalIcon.deepLinkUrl || activeBranding.platforms[p].deepLinkUrl,
              badgeText: activeBranding.seasonalIcon.name || activeBranding.platforms[p].badgeText,
            };
          }
        }
      }
    }

    const activePlatformWallets = (this.memoryCache?.platformWallets || DEFAULT_PLATFORM_WALLETS)
      .filter(a => a.isActive)
      .sort((a, b) => a.order - b.order);

    return {
      modified: true,
      configVersion: version,
      etag,
      updatedAt: updatedAt.toISOString(),
      features: effectiveFeatures,
      details: effectiveDetails,
      walletProviders: resolvedWalletProviders,
      branding: activeBranding,
      platformWallets: activePlatformWallets,
    };
  }

  /**
   * Server-side check for backend guards and services.
   * Authoritative evaluation: does not rely on client values.
   */
  public async isFeatureActive(
    key: string,
    context: { userId?: string; platform?: string } = {}
  ): Promise<boolean> {
    const config = await this.getResolvedConfig({
      userId: context.userId,
      platform: context.platform,
    });
    return config.features[key] === true;
  }

  /**
   * Server-side check for a specific Yemeni wallet provider.
   */
  public async isWalletProviderActive(providerCode: string): Promise<boolean> {
    const isMasterActive = await this.isFeatureActive('electronic_wallet_providers');
    if (!isMasterActive) return false;

    const config = await this.getResolvedConfig();
    const provider = config.walletProviders[providerCode.toUpperCase()];
    return provider?.enabled === true;
  }

  /**
   * Admin: Get all feature flags with full schema and recent audit log.
   */
  public async getAllFlagsForAdmin(): Promise<any[]> {
    await this.ensureInitialized();
    const flags = await prisma.featureFlag.findMany({
      include: {
        auditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return flags.map((f) => {
      let platforms = ['android', 'ios', 'web'];
      let dependencies = [];
      let metadata = {};

      try {
        platforms = typeof f.platforms === 'string' ? JSON.parse(f.platforms) : f.platforms;
      } catch (_) {}
      try {
        dependencies = typeof f.dependencies === 'string' ? JSON.parse(f.dependencies) : f.dependencies;
      } catch (_) {}
      try {
        metadata = typeof f.metadata === 'string' ? JSON.parse(f.metadata) : f.metadata;
      } catch (_) {}

      return {
        ...f,
        platforms,
        dependencies,
        metadata,
      };
    });
  }

  /**
   * Admin: Get single feature flag with full audit history.
   */
  public async getFlagByKey(key: string): Promise<any> {
    const flag = await prisma.featureFlag.findUnique({
      where: { key },
      include: {
        auditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!flag) {
      throw new AppError(`ميزة النظام غير موجودة: ${key}`, 404);
    }

    let platforms = ['android', 'ios', 'web'];
    let dependencies = [];
    let metadata = {};

    try {
      platforms = typeof flag.platforms === 'string' ? JSON.parse(flag.platforms) : flag.platforms;
    } catch (_) {}
    try {
      dependencies = typeof flag.dependencies === 'string' ? JSON.parse(flag.dependencies) : flag.dependencies;
    } catch (_) {}
    try {
      metadata = typeof flag.metadata === 'string' ? JSON.parse(flag.metadata) : flag.metadata;
    } catch (_) {}

    return {
      ...flag,
      platforms,
      dependencies,
      metadata,
    };
  }

  /**
   * Admin: Update or toggle a feature flag.
   * Enforces validation, dependencies, sensitive safety confirmation, increments version, and writes audit record.
   */
  public async updateFlag(
    key: string,
    updates: {
      enabled?: boolean;
      displayNameAr?: string;
      displayNameEn?: string;
      descriptionAr?: string;
      descriptionEn?: string;
      maintenanceMessageAr?: string;
      maintenanceMessageEn?: string;
      rolloutPercentage?: number;
      startDate?: string | null;
      endDate?: string | null;
      platforms?: string[];
      dependencies?: string[];
      metadata?: Record<string, any>;
      reason?: string;
    },
    adminUser: { id: string; email?: string },
    req?: Request
  ): Promise<any> {
    const existing = await prisma.featureFlag.findUnique({ where: { key } });
    if (!existing) {
      throw new AppError(`ميزة النظام المطلوبة غير موجودة: ${key}`, 404);
    }

    // Rollout percentage validation
    if (updates.rolloutPercentage !== undefined) {
      if (updates.rolloutPercentage < 0 || updates.rolloutPercentage > 100) {
        throw new AppError('نسبة الإطلاق التدريجي يجب أن تكون بين 0 و 100', 400);
      }
    }

    // Schedule date validation
    if (updates.startDate && updates.endDate) {
      if (new Date(updates.startDate) > new Date(updates.endDate)) {
        throw new AppError('تاريخ بداية التفعيل يجب أن يسبق تاريخ الانتهاء', 400);
      }
    }

    // Dependency safety validation:
    // If enabling a feature, ensure all its required dependencies are currently enabled
    if (updates.enabled === true) {
      let deps = existing.dependencies ? JSON.parse(existing.dependencies) : [];
      if (updates.dependencies) {
        deps = updates.dependencies;
      }
      for (const depKey of deps) {
        const parentFlag = await prisma.featureFlag.findUnique({ where: { key: depKey } });
        if (!parentFlag || !parentFlag.enabled) {
          throw new AppError(
            `لا يمكن تفعيل الميزة [${existing.displayNameAr}] لأن الميزة التابعة [${parentFlag?.displayNameAr || depKey}] معطلة حالياً.`,
            400
          );
        }
      }
    }

    const oldValue = JSON.stringify({
      enabled: existing.enabled,
      rolloutPercentage: existing.rolloutPercentage,
      startDate: existing.startDate,
      endDate: existing.endDate,
      platforms: existing.platforms,
      dependencies: existing.dependencies,
      metadata: existing.metadata,
      maintenanceMessageAr: existing.maintenanceMessageAr,
      maintenanceMessageEn: existing.maintenanceMessageEn,
    });

    const newVersion = existing.configVersion + 1;

    // Database update
    const updated = await prisma.featureFlag.update({
      where: { key },
      data: {
        ...(updates.enabled !== undefined && { enabled: updates.enabled }),
        ...(updates.displayNameAr !== undefined && { displayNameAr: updates.displayNameAr }),
        ...(updates.displayNameEn !== undefined && { displayNameEn: updates.displayNameEn }),
        ...(updates.descriptionAr !== undefined && { descriptionAr: updates.descriptionAr }),
        ...(updates.descriptionEn !== undefined && { descriptionEn: updates.descriptionEn }),
        ...(updates.maintenanceMessageAr !== undefined && { maintenanceMessageAr: updates.maintenanceMessageAr }),
        ...(updates.maintenanceMessageEn !== undefined && { maintenanceMessageEn: updates.maintenanceMessageEn }),
        ...(updates.rolloutPercentage !== undefined && { rolloutPercentage: updates.rolloutPercentage }),
        ...(updates.startDate !== undefined && { startDate: updates.startDate ? new Date(updates.startDate) : null }),
        ...(updates.endDate !== undefined && { endDate: updates.endDate ? new Date(updates.endDate) : null }),
        ...(updates.platforms !== undefined && { platforms: JSON.stringify(updates.platforms) }),
        ...(updates.dependencies !== undefined && { dependencies: JSON.stringify(updates.dependencies) }),
        ...(updates.metadata !== undefined && { metadata: JSON.stringify(updates.metadata) }),
        configVersion: newVersion,
        updatedBy: adminUser.email || adminUser.id,
      },
    });

    // Increment global system configuration version
    await prisma.systemSetting.upsert({
      where: { key: 'remote_config_version' },
      create: { key: 'remote_config_version', value: '2', type: 'number', group: 'remote_config' },
      update: { value: (newVersion + 1).toString() },
    });

    // Record audit trail
    const newValue = JSON.stringify({
      enabled: updated.enabled,
      rolloutPercentage: updated.rolloutPercentage,
      startDate: updated.startDate,
      endDate: updated.endDate,
      platforms: updated.platforms,
      dependencies: updated.dependencies,
      metadata: updated.metadata,
      maintenanceMessageAr: updated.maintenanceMessageAr,
      maintenanceMessageEn: updated.maintenanceMessageEn,
    });

    let action = 'UPDATE_CONFIG';
    if (updates.enabled !== undefined && updates.enabled !== existing.enabled) {
      action = updates.enabled ? 'TOGGLE_ON' : 'TOGGLE_OFF';
    } else if (updates.rolloutPercentage !== undefined && updates.rolloutPercentage !== existing.rolloutPercentage) {
      action = 'ROLLOUT_UPDATE';
    }

    await prisma.featureFlagAuditLog.create({
      data: {
        featureFlagId: updated.id,
        featureKey: key,
        action,
        oldValue,
        newValue,
        reason: updates.reason || 'تحديث الإعدادات من لوحة الإدارة',
        changedBy: adminUser.email || adminUser.id,
        ipAddress: req?.ip || req?.socket?.remoteAddress || null,
        userAgent: req?.headers['user-agent'] || null,
      },
    });

    this.invalidateCache();
    this.broadcastConfigUpdate({ key, action, version: updated.configVersion });

    let platforms = ['android', 'ios', 'web'];
    let dependencies: string[] = [];
    let metadata: Record<string, any> = {};

    try {
      platforms = typeof updated.platforms === 'string' ? JSON.parse(updated.platforms) : updated.platforms;
    } catch (_) {}
    try {
      dependencies = typeof updated.dependencies === 'string' ? JSON.parse(updated.dependencies) : updated.dependencies;
    } catch (_) {}
    try {
      metadata = typeof updated.metadata === 'string' ? JSON.parse(updated.metadata) : updated.metadata;
    } catch (_) {}

    return {
      ...updated,
      platforms,
      dependencies,
      metadata,
    };
  }

  /**
   * Admin: Quick Toggle a feature flag with sensitive safety checks.
   */
  public async toggleFlag(
    key: string,
    enabled: boolean,
    reason: string = '',
    adminUser: { id: string; email?: string },
    req?: Request
  ): Promise<any> {
    return this.updateFlag(
      key,
      {
        enabled,
        reason: reason || (enabled ? 'تم تفعيل الميزة يدوياً' : 'تم تعطيل الميزة يدوياً'),
      },
      adminUser,
      req
    );
  }

  /**
   * Admin: Update individual Electronic Wallet Provider within metadata.
   */
  public async updateWalletProvider(
    providerCode: string,
    enabled: boolean,
    reason: string = '',
    adminUser: { id: string; email?: string },
    req?: Request
  ): Promise<any> {
    const key = 'electronic_wallet_providers';
    const flag = await prisma.featureFlag.findUnique({ where: { key } });
    if (!flag) {
      throw new AppError('ميزة المحافظ الإلكترونية غير موجودة', 404);
    }

    let metadata: Record<string, any> = {};
    try {
      metadata = typeof flag.metadata === 'string' ? JSON.parse(flag.metadata) : flag.metadata;
    } catch (_) {}

    const providers = metadata.providers || { ...DEFAULT_WALLET_PROVIDERS };
    const code = providerCode.toUpperCase();

    if (!providers[code]) {
      throw new AppError(`مزود المحفظة المطلوب غير معتمد: ${providerCode}`, 404);
    }

    const oldProv = { ...providers[code] };
    providers[code].enabled = enabled;
    metadata.providers = providers;

    const auditReason = reason || `${enabled ? 'تفعيل' : 'تعطيل'} مزود المحفظة (${oldProv.nameAr})`;

    return this.updateFlag(
      key,
      {
        metadata,
        reason: auditReason,
      },
      adminUser,
      req
    );
  }

  /**
   * Admin: Get audit logs with pagination and filters.
   */
  public async getAuditLogs(
    featureKey?: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<{ logs: any[]; total: number }> {
    const where = featureKey ? { featureKey } : {};

    const [logs, total] = await Promise.all([
      prisma.featureFlagAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.featureFlagAuditLog.count({ where }),
    ]);

    return { logs, total };
  }

  /**
   * Admin: Reset feature flags to factory default safe values.
   */
  public async resetToDefaults(
    adminUser: { id: string; email?: string },
    req?: Request
  ): Promise<void> {
    for (const def of DEFAULT_FEATURE_FLAGS) {
      await prisma.featureFlag.upsert({
        where: { key: def.key },
        create: {
          key: def.key,
          enabled: def.enabled,
          displayNameAr: def.displayNameAr,
          displayNameEn: def.displayNameEn,
          descriptionAr: def.descriptionAr,
          descriptionEn: def.descriptionEn,
          maintenanceMessageAr: def.maintenanceMessageAr,
          maintenanceMessageEn: def.maintenanceMessageEn,
          isSensitive: def.isSensitive,
          rolloutPercentage: def.rolloutPercentage,
          platforms: JSON.stringify(def.platforms),
          dependencies: JSON.stringify(def.dependencies),
          metadata: JSON.stringify(def.metadata || {}),
          configVersion: 1,
          updatedBy: adminUser.email || adminUser.id,
        },
        update: {
          enabled: def.enabled,
          displayNameAr: def.displayNameAr,
          displayNameEn: def.displayNameEn,
          descriptionAr: def.descriptionAr,
          descriptionEn: def.descriptionEn,
          maintenanceMessageAr: def.maintenanceMessageAr,
          maintenanceMessageEn: def.maintenanceMessageEn,
          isSensitive: def.isSensitive,
          rolloutPercentage: def.rolloutPercentage,
          platforms: JSON.stringify(def.platforms),
          dependencies: JSON.stringify(def.dependencies),
          metadata: JSON.stringify(def.metadata || {}),
          updatedBy: adminUser.email || adminUser.id,
        },
      });

      await prisma.featureFlagAuditLog.create({
        data: {
          featureKey: def.key,
          action: 'RESET_FACTORY_DEFAULT',
          reason: 'إعادة ضبط المصنع للقيم الآمنة المعتمدة',
          changedBy: adminUser.email || adminUser.id,
          ipAddress: req?.ip || req?.socket?.remoteAddress || null,
          userAgent: req?.headers ? (req.headers['user-agent'] as string) : null,
        },
      });
    }

    // Reset app branding to factory defaults
    await prisma.systemSetting.upsert({
      where: { key: 'app_branding_config' },
      create: {
        key: 'app_branding_config',
        value: JSON.stringify(DEFAULT_APP_BRANDING),
        type: 'json',
        group: 'remote_config',
      },
      update: {
        value: JSON.stringify(DEFAULT_APP_BRANDING),
      },
    });

    // Reset platform wallet accounts to factory defaults
    await prisma.systemSetting.upsert({
      where: { key: 'platform_wallet_accounts' },
      create: {
        key: 'platform_wallet_accounts',
        value: JSON.stringify(DEFAULT_PLATFORM_WALLETS),
        type: 'json',
        group: 'remote_config',
      },
      update: {
        value: JSON.stringify(DEFAULT_PLATFORM_WALLETS),
      },
    });

    this.invalidateCache();
    this.broadcastConfigUpdate({ action: 'RESET_FACTORY_DEFAULT' });
  }

  /**
   * Admin: Get current App Branding, Icons & Deep-linking configuration.
   */
  public async getBrandingConfig(): Promise<AppBrandingConfig> {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'app_branding_config' },
    });
    if (!setting || !setting.value) {
      return { ...DEFAULT_APP_BRANDING };
    }
    try {
      const parsed = JSON.parse(setting.value);
      return {
        ...DEFAULT_APP_BRANDING,
        ...parsed,
        platforms: {
          ...DEFAULT_APP_BRANDING.platforms,
          ...(parsed.platforms || {}),
        },
        seasonalIcon: {
          ...DEFAULT_APP_BRANDING.seasonalIcon,
          ...(parsed.seasonalIcon || {}),
        },
      };
    } catch (_) {
      return { ...DEFAULT_APP_BRANDING };
    }
  }

  /**
   * Admin: Update App Branding, Icons (Android, iPhone, Tablet, Desktop, Web) and Deep-link targets.
   */
  public async updateBrandingConfig(
    updates: Partial<AppBrandingConfig>,
    adminUser: { id: string; email?: string },
    req?: Request
  ): Promise<AppBrandingConfig> {
    const current = await this.getBrandingConfig();
    const updated: AppBrandingConfig = {
      ...current,
      ...updates,
      platforms: {
        ...current.platforms,
        ...(updates.platforms || {}),
      },
      seasonalIcon: {
        ...current.seasonalIcon,
        ...(updates.seasonalIcon || {}),
      },
      updatedAt: new Date().toISOString(),
    };

    const oldValue = JSON.stringify(current);
    const newValue = JSON.stringify(updated);

    // Persist to SystemSetting
    await prisma.systemSetting.upsert({
      where: { key: 'app_branding_config' },
      create: {
        key: 'app_branding_config',
        value: newValue,
        type: 'json',
        group: 'remote_config',
      },
      update: {
        value: newValue,
      },
    });

    // Increment global system configuration version
    const versionSetting = await prisma.systemSetting.findUnique({
      where: { key: 'remote_config_version' },
    });
    const currentVersion = versionSetting ? parseInt(versionSetting.value, 10) || 1 : 1;
    const newVersion = currentVersion + 1;

    await prisma.systemSetting.upsert({
      where: { key: 'remote_config_version' },
      create: { key: 'remote_config_version', value: '2', type: 'number', group: 'remote_config' },
      update: { value: newVersion.toString() },
    });

    // Record audit trail
    await prisma.featureFlagAuditLog.create({
      data: {
        featureKey: 'app_branding_config',
        action: 'UPDATE',
        oldValue,
        newValue,
        reason: 'تحديث أيقونات وتطبيقات المنصة وروابط الفتح عند النقر',
        changedBy: adminUser.email || adminUser.id,
        ipAddress: req?.ip || req?.socket?.remoteAddress || null,
        userAgent: req?.headers ? (req.headers['user-agent'] as string) : null,
      },
    });

    this.invalidateCache();
    this.broadcastConfigUpdate({ key: 'branding', action: 'UPDATE_BRANDING', version: newVersion });
    return updated;
  }

  /**
   * Get platform wallet accounts for checkout payments and customer/seller deposits.
   */
  public async getPlatformWalletAccounts(
    channel?: 'CHECKOUT' | 'CUSTOMER_DEPOSIT' | 'SELLER_DEPOSIT' | string,
    includeInactive: boolean = false
  ): Promise<PlatformWalletAccountConfig[]> {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'platform_wallet_accounts' },
    });
    let accounts: PlatformWalletAccountConfig[] = DEFAULT_PLATFORM_WALLETS;
    if (setting && setting.value) {
      try {
        const parsed = JSON.parse(setting.value);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const parsedMap = new Map(parsed.map((a: PlatformWalletAccountConfig) => [a.provider, a]));
          accounts = DEFAULT_PLATFORM_WALLETS.map(def => parsedMap.get(def.provider) || def);
        }
      } catch (_) {}
    }

    if (!includeInactive) {
      accounts = accounts.filter(a => a.isActive);
    }

    if (channel) {
      const upperChan = channel.toUpperCase();
      accounts = accounts.filter(a => !a.supportedChannels || a.supportedChannels.includes(upperChan as any));
    }

    return accounts.sort((a, b) => a.order - b.order);
  }

  /**
   * Admin: Update platform wallet account numbers, holder, instructions, etc.
   */
  public async updatePlatformWalletAccount(
    providerCode: string,
    updates: Partial<PlatformWalletAccountConfig>,
    adminUser: any,
    req?: Request
  ): Promise<PlatformWalletAccountConfig> {
    const code = providerCode.trim().toUpperCase();
    const allAccounts = await this.getPlatformWalletAccounts(undefined, true);
    const existingIndex = allAccounts.findIndex(a => a.provider === code);
    if (existingIndex === -1) {
      throw new AppError(`مزود المحفظة [${providerCode}] غير معتمد في المنصة.`, 404, 'PROVIDER_NOT_FOUND');
    }

    const current = allAccounts[existingIndex];
    const updated: PlatformWalletAccountConfig = {
      ...current,
      ...updates,
      provider: code, // immutable code
      updatedAt: new Date().toISOString(),
    };

    allAccounts[existingIndex] = updated;

    const oldValue = JSON.stringify(current);
    const newValue = JSON.stringify(updated);

    // Persist to SystemSetting
    await prisma.systemSetting.upsert({
      where: { key: 'platform_wallet_accounts' },
      create: {
        key: 'platform_wallet_accounts',
        value: JSON.stringify(allAccounts),
        type: 'json',
        group: 'remote_config',
      },
      update: {
        value: JSON.stringify(allAccounts),
      },
    });

    // Increment global system configuration version
    const versionSetting = await prisma.systemSetting.findUnique({
      where: { key: 'remote_config_version' },
    });
    const currentVersion = versionSetting ? parseInt(versionSetting.value, 10) || 1 : 1;
    await prisma.systemSetting.upsert({
      where: { key: 'remote_config_version' },
      create: { key: 'remote_config_version', value: '2', type: 'number', group: 'remote_config' },
      update: { value: (currentVersion + 1).toString() },
    });

    // Record audit log
    await prisma.featureFlagAuditLog.create({
      data: {
        featureKey: `platform_wallet_${code}`,
        action: 'UPDATE',
        oldValue,
        newValue,
        reason: (updates as any).reason || `تحديث بيانات حساب منصة سوقناا لمزود المحفظة: ${code}`,
        changedBy: adminUser.email || adminUser.id,
        ipAddress: req?.ip || req?.socket?.remoteAddress || null,
        userAgent: req?.headers ? (req.headers['user-agent'] as string) : null,
      },
    });

    this.invalidateCache();
    this.broadcastConfigUpdate({ key: `platform_wallet_${code}`, action: 'UPDATE_PLATFORM_WALLETS' });
    return updated;
  }

  /**
   * Admin: Reset platform wallet accounts to factory defaults.
   */
  public async resetPlatformWalletAccounts(adminUser: any, req?: Request): Promise<void> {
    await prisma.systemSetting.upsert({
      where: { key: 'platform_wallet_accounts' },
      create: {
        key: 'platform_wallet_accounts',
        value: JSON.stringify(DEFAULT_PLATFORM_WALLETS),
        type: 'json',
        group: 'remote_config',
      },
      update: {
        value: JSON.stringify(DEFAULT_PLATFORM_WALLETS),
      },
    });

    await prisma.featureFlagAuditLog.create({
      data: {
        featureKey: 'platform_wallet_accounts',
        action: 'RESET_FACTORY_DEFAULT',
        reason: 'إعادة ضبط حسابات محافظ المنصة إلى القيم الافتراضية المعتمدة',
        changedBy: adminUser.email || adminUser.id,
        ipAddress: req?.ip || req?.socket?.remoteAddress || null,
        userAgent: req?.headers ? (req.headers['user-agent'] as string) : null,
      },
    });

    this.invalidateCache();
    this.broadcastConfigUpdate({ key: 'platform_wallet_accounts', action: 'RESET_PLATFORM_WALLETS' });
  }
}

export const remoteConfigService = RemoteConfigService.getInstance();
