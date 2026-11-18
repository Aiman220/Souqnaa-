import { Request } from 'express';
import crypto from 'crypto';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { AppError } from '../../middleware/error.middleware';
import { SocketService } from '../../services/websocket/socket.service';
import { supportedAreasService } from '../locations/supported-areas.service';
import { launcherCampaignService } from './launcher-campaign.service';
import {
  AppBrandingConfig,
  APPROVED_CUSTOMER_APP_ICONS,
  APPROVED_SELLER_APP_ICONS,
  DEFAULT_APP_BRANDING,
  DEFAULT_CUSTOMER_BRANDING,
  DEFAULT_SELLER_BRANDING,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_WALLET_PROVIDERS,
  FeatureFlagSeedDefinition,
  PlatformAppIconConfig,
  WalletProviderConfig,
  PlatformWalletAccountConfig,
  DEFAULT_PLATFORM_WALLETS,
  LauncherIconConfigRecord,
} from './feature-flags.defaults';

export interface ClientEvaluationContext {
  platform?: 'android' | 'ios' | 'web' | string;
  appType?: 'customer' | 'seller' | 'admin' | string;
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
    sellerBranding: AppBrandingConfig;
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

  private isInitialized = false;

  /**
   * Ensure default feature flags are seeded and populated in the database.
   */
  public async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;
    try {
      // Ensure supported delivery areas are synced
      await supportedAreasService.ensureDatabaseSync();

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
        } else if (def.key === 'refunds') {
          if (!existing.descriptionEn || existing.descriptionEn !== def.descriptionEn || existing.displayNameEn !== def.displayNameEn) {
            await prisma.featureFlag.update({
              where: { key: 'refunds' },
              data: {
                displayNameEn: def.displayNameEn,
                descriptionAr: def.descriptionAr,
                descriptionEn: def.descriptionEn,
                maintenanceMessageAr: def.maintenanceMessageAr,
                maintenanceMessageEn: def.maintenanceMessageEn,
                isSensitive: true,
              },
            });
          }
        } else if (['scheduled_delivery', 'express_delivery', 'free_delivery_campaigns', 'city_based_product_discovery'].includes(def.key)) {
          let existingDeps: string[] = [];
          try {
            existingDeps = typeof existing.dependencies === 'string' ? JSON.parse(existing.dependencies) : (existing.dependencies || []);
          } catch (_) {}
          if (existingDeps.includes('standard_delivery')) {
            const updatedDeps = existingDeps.filter((d: string) => d !== 'standard_delivery');
            await prisma.featureFlag.update({
              where: { key: def.key },
              data: { dependencies: JSON.stringify(updatedDeps) },
            });
          }
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
      this.isInitialized = true;
    } catch (error) {
      console.error('[RemoteConfigService] Failed to initialize default feature flags:', error);
    }
  }

  /**
   * Invalidate memory cache and Redis keys on any update.
   */
  public invalidateCache(): void {
    this.memoryCache = null;
    try {
      redis.del('app_branding_config').catch(() => {});
      redis.del('customer_app_icon').catch(() => {});
      redis.delPattern('remote_config:*').catch(() => {});
    } catch (_) {}
  }

  /**
   * Broadcast configuration update to all connected clients in real time via WebSocket.
   */
  public broadcastConfigUpdate(metadata?: { key?: string; action?: string; version?: number; [key: string]: any }): void {
    try {
      const socketSvc = SocketService.get();
      if (socketSvc) {
        const payload = {
          timestamp: new Date().toISOString(),
          version: metadata?.version || Date.now(),
          key: metadata?.key,
          action: metadata?.action || 'UPDATE',
          ...metadata,
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
    sellerBranding: AppBrandingConfig;
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

    const [
      versionSetting,
      brandingSetting,
      sellerBrandingSetting,
      customerIconSetting,
      sellerIconSetting,
      platformWalletsSetting,
      launcherConfigs,
    ] = await Promise.all([
      prisma.systemSetting.findUnique({ where: { key: 'remote_config_version' } }),
      prisma.systemSetting.findUnique({ where: { key: 'app_branding_config' } }),
      prisma.systemSetting.findUnique({ where: { key: 'seller_branding_config' } }),
      prisma.systemSetting.findUnique({ where: { key: 'customer_app_icon' } }),
      prisma.systemSetting.findUnique({ where: { key: 'seller_app_icon' } }),
      prisma.systemSetting.findUnique({ where: { key: 'platform_wallet_accounts' } }),
      prisma.launcherIconConfig.findMany(),
    ]);

    const version = versionSetting ? parseInt(versionSetting.value, 10) || 1 : 1;

    let branding: AppBrandingConfig = { ...DEFAULT_CUSTOMER_BRANDING };
    if (brandingSetting && brandingSetting.value) {
      try {
        const parsed = JSON.parse(brandingSetting.value);
        branding = {
          ...DEFAULT_CUSTOMER_BRANDING,
          ...parsed,
          platforms: {
            ...DEFAULT_CUSTOMER_BRANDING.platforms,
            ...(parsed.platforms || {}),
          },
          seasonalIcon: {
            ...DEFAULT_CUSTOMER_BRANDING.seasonalIcon,
            ...(parsed.seasonalIcon || {}),
          },
        };
      } catch (_) {}
    }

    if (customerIconSetting && customerIconSetting.value) {
      branding.customerAppIcon = customerIconSetting.value;
    } else if (!branding.customerAppIcon) {
      branding.customerAppIcon = 'default';
    }

    let sellerBranding: AppBrandingConfig = { ...DEFAULT_SELLER_BRANDING };
    if (sellerBrandingSetting && sellerBrandingSetting.value) {
      try {
        const parsed = JSON.parse(sellerBrandingSetting.value);
        sellerBranding = {
          ...DEFAULT_SELLER_BRANDING,
          ...parsed,
          platforms: {
            ...DEFAULT_SELLER_BRANDING.platforms,
            ...(parsed.platforms || {}),
          },
          seasonalIcon: {
            ...DEFAULT_SELLER_BRANDING.seasonalIcon,
            ...(parsed.seasonalIcon || {}),
          },
        };
      } catch (_) {}
    }

    if (sellerIconSetting && sellerIconSetting.value) {
      sellerBranding.customerAppIcon = sellerIconSetting.value;
    } else if (!sellerBranding.customerAppIcon) {
      sellerBranding.customerAppIcon = 'seller_default';
    }

    // Authoritative overlay from LauncherIconConfig records (§1, §3, §4)
    const custAndroid = launcherConfigs.find((c) => c.applicationType === 'CUSTOMER' && c.platform === 'ANDROID');
    const custIos = launcherConfigs.find((c) => c.applicationType === 'CUSTOMER' && c.platform === 'IOS');
    const selAndroid = launcherConfigs.find((c) => c.applicationType === 'SELLER' && c.platform === 'ANDROID');
    const selIos = launcherConfigs.find((c) => c.applicationType === 'SELLER' && c.platform === 'IOS');

    if (custAndroid) {
      branding.platforms.android = {
        ...branding.platforms.android,
        iconUrl: custAndroid.defaultIconUrl || branding.platforms.android.iconUrl,
        deepLinkUrl: custAndroid.campaignDeepLink || branding.platforms.android.deepLinkUrl,
        badgeText: custAndroid.campaignName || branding.platforms.android.badgeText,
        seasonalEnabled: custAndroid.seasonalEnabled,
        seasonalIconUrl: custAndroid.seasonalIconUrl || '',
        seasonalIconId: custAndroid.seasonalIconId || 'sale_1_1',
        campaignName: custAndroid.campaignName || '',
        campaignDeepLink: custAndroid.campaignDeepLink || '',
        campaignStartAt: custAndroid.campaignStartAt ? custAndroid.campaignStartAt.toISOString() : null,
        campaignEndAt: custAndroid.campaignEndAt ? custAndroid.campaignEndAt.toISOString() : null,
        publishedVersion: custAndroid.publishedVersion,
      };
    }
    if (custIos) {
      branding.platforms.ios = {
        ...branding.platforms.ios,
        iconUrl: custIos.defaultIconUrl || branding.platforms.ios.iconUrl,
        deepLinkUrl: custIos.campaignDeepLink || branding.platforms.ios.deepLinkUrl,
        badgeText: custIos.campaignName || branding.platforms.ios.badgeText,
        seasonalEnabled: custIos.seasonalEnabled,
        seasonalIconUrl: custIos.seasonalIconUrl || '',
        seasonalIconId: custIos.seasonalIconId || 'sale_1_1',
        campaignName: custIos.campaignName || '',
        campaignDeepLink: custIos.campaignDeepLink || '',
        campaignStartAt: custIos.campaignStartAt ? custIos.campaignStartAt.toISOString() : null,
        campaignEndAt: custIos.campaignEndAt ? custIos.campaignEndAt.toISOString() : null,
        publishedVersion: custIos.publishedVersion,
      };
    }
    const primaryCust = custAndroid || custIos;
    if (primaryCust) {
      branding.seasonalIcon = {
        enabled: custAndroid ? custAndroid.seasonalEnabled : (custIos?.seasonalEnabled ?? false),
        name: primaryCust.campaignName || branding.seasonalIcon.name || '',
        iconUrl: primaryCust.seasonalIconUrl || branding.seasonalIcon.iconUrl || '',
        deepLinkUrl: primaryCust.campaignDeepLink || branding.seasonalIcon.deepLinkUrl || '',
        startDate: primaryCust.campaignStartAt ? primaryCust.campaignStartAt.toISOString() : null,
        endDate: primaryCust.campaignEndAt ? primaryCust.campaignEndAt.toISOString() : null,
      };
      if (custAndroid) {
        const res = launcherCampaignService.resolveLauncherIcon(custAndroid as any, new Date());
        branding.customerAppIcon = res.activeIconId;
      }
    }

    if (selAndroid) {
      sellerBranding.platforms.android = {
        ...sellerBranding.platforms.android,
        iconUrl: selAndroid.defaultIconUrl || sellerBranding.platforms.android.iconUrl,
        deepLinkUrl: selAndroid.campaignDeepLink || sellerBranding.platforms.android.deepLinkUrl,
        badgeText: selAndroid.campaignName || sellerBranding.platforms.android.badgeText,
        seasonalEnabled: selAndroid.seasonalEnabled,
        seasonalIconUrl: selAndroid.seasonalIconUrl || '',
        seasonalIconId: selAndroid.seasonalIconId || 'seller_seasonal',
        campaignName: selAndroid.campaignName || '',
        campaignDeepLink: selAndroid.campaignDeepLink || '',
        campaignStartAt: selAndroid.campaignStartAt ? selAndroid.campaignStartAt.toISOString() : null,
        campaignEndAt: selAndroid.campaignEndAt ? selAndroid.campaignEndAt.toISOString() : null,
        publishedVersion: selAndroid.publishedVersion,
      };
    }
    if (selIos) {
      sellerBranding.platforms.ios = {
        ...sellerBranding.platforms.ios,
        iconUrl: selIos.defaultIconUrl || sellerBranding.platforms.ios.iconUrl,
        deepLinkUrl: selIos.campaignDeepLink || sellerBranding.platforms.ios.deepLinkUrl,
        badgeText: selIos.campaignName || sellerBranding.platforms.ios.badgeText,
        seasonalEnabled: selIos.seasonalEnabled,
        seasonalIconUrl: selIos.seasonalIconUrl || '',
        seasonalIconId: selIos.seasonalIconId || 'seller_seasonal',
        campaignName: selIos.campaignName || '',
        campaignDeepLink: selIos.campaignDeepLink || '',
        campaignStartAt: selIos.campaignStartAt ? selIos.campaignStartAt.toISOString() : null,
        campaignEndAt: selIos.campaignEndAt ? selIos.campaignEndAt.toISOString() : null,
        publishedVersion: selIos.publishedVersion,
      };
    }
    const primarySel = selAndroid || selIos;
    if (primarySel) {
      sellerBranding.seasonalIcon = {
        enabled: selAndroid ? selAndroid.seasonalEnabled : (selIos?.seasonalEnabled ?? false),
        name: primarySel.campaignName || sellerBranding.seasonalIcon.name || '',
        iconUrl: primarySel.seasonalIconUrl || sellerBranding.seasonalIcon.iconUrl || '',
        deepLinkUrl: primarySel.campaignDeepLink || sellerBranding.seasonalIcon.deepLinkUrl || '',
        startDate: primarySel.campaignStartAt ? primarySel.campaignStartAt.toISOString() : null,
        endDate: primarySel.campaignEndAt ? primarySel.campaignEndAt.toISOString() : null,
      };
      if (selAndroid) {
        const res = launcherCampaignService.resolveLauncherIcon(selAndroid as any, new Date());
        sellerBranding.customerAppIcon = res.activeIconId;
      }
    }

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
    for (const lc of launcherConfigs) {
      if (lc.updatedAt > latestUpdate) {
        latestUpdate = lc.updatedAt;
      }
    }
    if (brandingSetting && brandingSetting.updatedAt > latestUpdate) {
      latestUpdate = brandingSetting.updatedAt;
    }
    if (sellerBrandingSetting && sellerBrandingSetting.updatedAt > latestUpdate) {
      latestUpdate = sellerBrandingSetting.updatedAt;
    }
    if (customerIconSetting && customerIconSetting.updatedAt > latestUpdate) {
      latestUpdate = customerIconSetting.updatedAt;
    }
    if (sellerIconSetting && sellerIconSetting.updatedAt > latestUpdate) {
      latestUpdate = sellerIconSetting.updatedAt;
    }
    if (platformWalletsSetting && platformWalletsSetting.updatedAt > latestUpdate) {
      latestUpdate = platformWalletsSetting.updatedAt;
    }

    const launcherTag = launcherConfigs
      .map((c) => `${c.applicationType}_${c.platform}:${c.publishedVersion}:${c.seasonalEnabled}`)
      .join('-');
    const etag = `W/"souqnaa-config-v${version}-${latestUpdate.getTime()}-${launcherTag}"`;

    this.memoryCache = {
      flags,
      branding,
      sellerBranding,
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
    const raw = await this.getRawFlags();
    const { flags, version, updatedAt, etag } = raw;
    const isSeller = (context.appType || '').toUpperCase() === 'SELLER';
    const rawBranding = isSeller ? raw.sellerBranding : raw.branding;

    if (context.ifNoneMatch) {
      const match = context.ifNoneMatch === etag ||
        context.ifNoneMatch.replace(/^W\//, '').replace(/^"|"$/g, '').trim() ===
        etag.replace(/^W\//, '').replace(/^"|"$/g, '').trim();
      if (match) {
        return {
          modified: false,
          configVersion: version,
          etag,
          updatedAt: updatedAt.toISOString(),
          features: {},
          details: {},
          walletProviders: {},
          branding: rawBranding,
          platformWallets: [],
        };
      }
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
        branding: rawBranding,
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
      ...rawBranding,
      platforms: { ...rawBranding.platforms },
    };

    // Authoritative Launcher Icon Resolution via LauncherCampaignService (§4, §5, §6)
    const appType: 'CUSTOMER' | 'SELLER' = isSeller ? 'SELLER' : 'CUSTOMER';
    const clientPlatform = (context.platform || '').toLowerCase();
    const targetPlatform: 'ANDROID' | 'IOS' = clientPlatform === 'ios' ? 'IOS' : 'ANDROID';

    try {
      const launcherConfig = await launcherCampaignService.getConfig(appType, targetPlatform);
      const resolution = launcherCampaignService.resolveLauncherIcon(launcherConfig, now);

      if (targetPlatform === 'ANDROID' && activeBranding.platforms.android) {
        activeBranding.platforms.android = {
          ...activeBranding.platforms.android,
          iconUrl: resolution.activeIconUrl || activeBranding.platforms.android.iconUrl,
          deepLinkUrl: resolution.deepLinkUrl || activeBranding.platforms.android.deepLinkUrl,
          badgeText: resolution.campaignName || activeBranding.platforms.android.badgeText,
        };
      } else if (targetPlatform === 'IOS' && activeBranding.platforms.ios) {
        activeBranding.platforms.ios = {
          ...activeBranding.platforms.ios,
          iconUrl: resolution.activeIconUrl || activeBranding.platforms.ios.iconUrl,
          deepLinkUrl: resolution.deepLinkUrl || activeBranding.platforms.ios.deepLinkUrl,
          badgeText: resolution.campaignName || activeBranding.platforms.ios.badgeText,
        };
      }

      // If active seasonal campaign, override platforms
      if (resolution.isSeasonalActive) {
        for (const p of ['android', 'ios', 'tablet', 'desktop', 'web'] as const) {
          if (activeBranding.platforms[p]) {
            activeBranding.platforms[p] = {
              ...activeBranding.platforms[p],
              iconUrl: resolution.activeIconUrl,
              deepLinkUrl: resolution.deepLinkUrl || activeBranding.platforms[p].deepLinkUrl,
              badgeText: resolution.campaignName || activeBranding.platforms[p].badgeText,
            };
          }
        }
      }

      activeBranding.customerAppIcon = resolution.activeIconId;
      activeBranding.seasonalIcon = {
        enabled: launcherConfig.seasonalEnabled,
        name: launcherConfig.campaignName || '',
        iconUrl: launcherConfig.seasonalIconUrl || '',
        deepLinkUrl: launcherConfig.campaignDeepLink || '',
        startDate: launcherConfig.campaignStartAt ? new Date(launcherConfig.campaignStartAt).toISOString() : null,
        endDate: launcherConfig.campaignEndAt ? new Date(launcherConfig.campaignEndAt).toISOString() : null,
      };
    } catch (_) {
      // Fallback to in-memory branding if database lookup fails
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
   * Minimum qualifying completed prepaid orders required for customer COD eligibility.
   * Authoritative source from Remote Config / Feature Flags with system setting fallback, defaulting to 3.
   */
  public async getCustomerCodMinOrders(context?: ClientEvaluationContext): Promise<number> {
    try {
      const flag = await prisma.featureFlag.findUnique({
        where: { key: 'customer_cod_eligibility' },
      });
      if (flag?.metadata) {
        const meta = typeof flag.metadata === 'string' ? JSON.parse(flag.metadata) : flag.metadata;
        const minOrders = meta.minQualifyingOrders;
        if (typeof minOrders === 'number' && minOrders >= 0) {
          return minOrders;
        }
      }
    } catch (_) {}

    try {
      const resolved = await this.getResolvedConfig(context);
      const detail = resolved.details?.['customer_cod_eligibility'];
      if (detail && detail.metadata && typeof detail.metadata === 'object') {
        const minOrders = (detail.metadata as any).minQualifyingOrders;
        if (typeof minOrders === 'number' && minOrders >= 0) {
          return minOrders;
        }
      }
    } catch (_) {}

    try {
      const setting = await prisma.systemSetting.findUnique({
        where: { key: 'customer_cod_min_orders' },
      });
      if (setting && setting.value) {
        const val = parseInt(setting.value, 10);
        if (!isNaN(val) && val >= 0) return val;
      }
    } catch (_) {}

    return 3;
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

    // Synchronize options inside inter_governorate_delivery metadata if this is a sub-option
    if (
      ['inter_governorate_standard', 'inter_governorate_express', 'inter_governorate_pickup_points', 'inter_governorate_courier'].includes(key) &&
      updates.enabled !== undefined
    ) {
      try {
        const master = await prisma.featureFlag.findUnique({ where: { key: 'inter_governorate_delivery' } });
        if (master) {
          let masterMeta: any = {};
          try {
            masterMeta = typeof master.metadata === 'string' ? JSON.parse(master.metadata) : master.metadata;
          } catch (_) {}
          if (masterMeta && masterMeta.options && Array.isArray(masterMeta.options)) {
            masterMeta.options = masterMeta.options.map((opt: any) => {
              if (opt.key === key || opt.code === key) {
                return { ...opt, enabled: updates.enabled };
              }
              return opt;
            });
            await prisma.featureFlag.update({
              where: { key: 'inter_governorate_delivery' },
              data: { metadata: JSON.stringify(masterMeta) },
            });
          }
        }
      } catch (_) {}
    }

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

    // Reset customer app icon to factory default
    await prisma.systemSetting.upsert({
      where: { key: 'customer_app_icon' },
      create: {
        key: 'customer_app_icon',
        value: 'default',
        type: 'string',
        group: 'remote_config',
      },
      update: {
        value: 'default',
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
   * Supports independent configurations for CUSTOMER and SELLER.
   */
  public async getBrandingConfig(appType: 'CUSTOMER' | 'SELLER' = 'CUSTOMER'): Promise<AppBrandingConfig> {
    const raw = await this.getRawFlags();
    if (appType === 'SELLER') {
      return raw.sellerBranding || DEFAULT_SELLER_BRANDING;
    }
    return raw.branding;
  }

  /**
   * Admin: Update App Branding, Icons (Android, iPhone, Tablet, Desktop, Web) and Deep-link targets.
   * Strictly isolates CUSTOMER and SELLER application configurations.
   */
  public async updateBrandingConfig(
    updates: Partial<AppBrandingConfig>,
    adminUser: { id: string; email?: string },
    req?: Request,
    appType: 'CUSTOMER' | 'SELLER' = 'CUSTOMER'
  ): Promise<AppBrandingConfig> {
    // 1. Validate campaign dates if provided
    if (updates.seasonalIcon?.startDate && updates.seasonalIcon?.endDate) {
      const s = new Date(updates.seasonalIcon.startDate).getTime();
      const e = new Date(updates.seasonalIcon.endDate).getTime();
      if (!isNaN(s) && !isNaN(e) && e <= s) {
        throw new AppError('تاريخ نهاية الحملة يجب أن يكون بعد تاريخ البداية بشكل صحيح', 400);
      }
    }

    // 2. Validate candidate app icon identifier if provided
    const rawCandidate =
      updates.customerAppIcon ||
      updates.platforms?.android?.iconUrl ||
      updates.defaultIconUrl;

    let canonicalIcon: string | undefined = undefined;
    if (rawCandidate) {
      canonicalIcon = launcherCampaignService.validateIconTarget(rawCandidate, appType);
    }

    const current = await this.getBrandingConfig(appType);
    const updated: AppBrandingConfig = {
      ...current,
      ...updates,
      ...(canonicalIcon ? { customerAppIcon: canonicalIcon } : {}),
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

    const isCustomer = appType === 'CUSTOMER';
    const settingKey = isCustomer ? 'app_branding_config' : 'seller_branding_config';
    const iconSettingKey = isCustomer ? 'customer_app_icon' : 'seller_app_icon';

    const oldValue = JSON.stringify(current);
    const newValue = JSON.stringify(updated);

    // 3. Persist to SystemSetting
    await prisma.systemSetting.upsert({
      where: { key: settingKey },
      create: {
        key: settingKey,
        value: newValue,
        type: 'json',
        group: 'remote_config',
      },
      update: {
        value: newValue,
      },
    });

    // Synchronize icon setting in SystemSetting
    if (canonicalIcon) {
      await prisma.systemSetting.upsert({
        where: { key: iconSettingKey },
        create: {
          key: iconSettingKey,
          value: canonicalIcon,
          type: 'string',
          group: 'remote_config',
        },
        update: {
          value: canonicalIcon,
        },
      });
    }

    // 4. Synchronize with authoritative LauncherIconConfig table for ANDROID and IOS
    try {
      const androidCandidate = updates.platforms?.android?.iconUrl || canonicalIcon || current.platforms.android.iconUrl;
      const iosCandidate = updates.platforms?.ios?.iconUrl || canonicalIcon || current.platforms.ios.iconUrl;

      const seasonalTarget = updates.seasonalIcon?.iconUrl
        ? launcherCampaignService.normalizeIconId(updates.seasonalIcon.iconUrl, appType, true)
        : (isCustomer ? 'sale_1_1' : 'seller_seasonal');

      const androidSeasonalTarget = updates.platforms?.android?.seasonalIconUrl
        ? launcherCampaignService.normalizeIconId(updates.platforms.android.seasonalIconUrl, appType, true)
        : (updates.platforms?.android?.seasonalIconId || seasonalTarget);

      const iosSeasonalTarget = updates.platforms?.ios?.seasonalIconUrl
        ? launcherCampaignService.normalizeIconId(updates.platforms.ios.seasonalIconUrl, appType, true)
        : (updates.platforms?.ios?.seasonalIconId || seasonalTarget);

      const androidSeasonalEnabled = updates.platforms?.android?.seasonalEnabled !== undefined
        ? Boolean(updates.platforms.android.seasonalEnabled)
        : (updates.seasonalIcon?.enabled !== undefined ? Boolean(updates.seasonalIcon.enabled) : current.seasonalIcon?.enabled);

      const iosSeasonalEnabled = updates.platforms?.ios?.seasonalEnabled !== undefined
        ? Boolean(updates.platforms.ios.seasonalEnabled)
        : (updates.seasonalIcon?.enabled !== undefined ? Boolean(updates.seasonalIcon.enabled) : current.seasonalIcon?.enabled);

      const androidSeasonalIcon = updates.platforms?.android?.seasonalIconUrl !== undefined
        ? updates.platforms.android.seasonalIconUrl
        : (updates.seasonalIcon?.iconUrl !== undefined ? updates.seasonalIcon.iconUrl : current.seasonalIcon?.iconUrl);

      const iosSeasonalIcon = updates.platforms?.ios?.seasonalIconUrl !== undefined
        ? updates.platforms.ios.seasonalIconUrl
        : (updates.seasonalIcon?.iconUrl !== undefined ? updates.seasonalIcon.iconUrl : current.seasonalIcon?.iconUrl);

      const androidStartAt = updates.platforms?.android?.campaignStartAt !== undefined
        ? updates.platforms.android.campaignStartAt
        : (updates.seasonalIcon?.startDate !== undefined ? updates.seasonalIcon.startDate : current.seasonalIcon?.startDate);

      const androidEndAt = updates.platforms?.android?.campaignEndAt !== undefined
        ? updates.platforms.android.campaignEndAt
        : (updates.seasonalIcon?.endDate !== undefined ? updates.seasonalIcon.endDate : current.seasonalIcon?.endDate);

      const iosStartAt = updates.platforms?.ios?.campaignStartAt !== undefined
        ? updates.platforms.ios.campaignStartAt
        : (updates.seasonalIcon?.startDate !== undefined ? updates.seasonalIcon.startDate : current.seasonalIcon?.startDate);

      const iosEndAt = updates.platforms?.ios?.campaignEndAt !== undefined
        ? updates.platforms.ios.campaignEndAt
        : (updates.seasonalIcon?.endDate !== undefined ? updates.seasonalIcon.endDate : current.seasonalIcon?.endDate);

      await Promise.all([
        launcherCampaignService.updateLauncherConfig(
          appType,
          'ANDROID',
          {
            defaultIconId: launcherCampaignService.normalizeIconId(androidCandidate, appType),
            defaultIconUrl: androidCandidate || (isCustomer ? '/uploads/branding/souqnaa-app-icon.png' : '/uploads/branding/seller_app_icon.png'),
            seasonalIconId: androidSeasonalTarget,
            seasonalIconUrl: androidSeasonalIcon,
            seasonalEnabled: androidSeasonalEnabled,
            campaignName: updates.seasonalIcon?.name !== undefined ? updates.seasonalIcon.name : current.seasonalIcon?.name,
            campaignDeepLink: updates.seasonalIcon?.deepLinkUrl !== undefined ? updates.seasonalIcon.deepLinkUrl : current.seasonalIcon?.deepLinkUrl,
            campaignStartAt: androidStartAt,
            campaignEndAt: androidEndAt,
          },
          adminUser
        ),
        launcherCampaignService.updateLauncherConfig(
          appType,
          'IOS',
          {
            defaultIconId: launcherCampaignService.normalizeIconId(iosCandidate, appType),
            defaultIconUrl: iosCandidate || (isCustomer ? '/uploads/branding/souqnaa-app-icon.png' : '/uploads/branding/seller_app_icon.png'),
            seasonalIconId: iosSeasonalTarget,
            seasonalIconUrl: iosSeasonalIcon,
            seasonalEnabled: iosSeasonalEnabled,
            campaignName: updates.seasonalIcon?.name !== undefined ? updates.seasonalIcon.name : current.seasonalIcon?.name,
            campaignDeepLink: updates.seasonalIcon?.deepLinkUrl !== undefined ? updates.seasonalIcon.deepLinkUrl : current.seasonalIcon?.deepLinkUrl,
            campaignStartAt: iosStartAt,
            campaignEndAt: iosEndAt,
          },
          adminUser
        ),
      ]);
    } catch (_) {}

    // 5. Increment global system configuration version
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

    // 6. Record audit trail
    await prisma.featureFlagAuditLog.create({
      data: {
        featureKey: settingKey,
        action: 'UPDATE',
        oldValue,
        newValue,
        reason: `تحديث أيقونات وهوية التطبيق والحملات الترويجية لـ [${appType}]`,
        changedBy: adminUser.email || adminUser.id,
        ipAddress: req?.ip || req?.socket?.remoteAddress || null,
        userAgent: req?.headers ? (req.headers['user-agent'] as string) : null,
      },
    });

    if (canonicalIcon && current.customerAppIcon !== canonicalIcon) {
      await prisma.featureFlagAuditLog.create({
        data: {
          featureKey: iconSettingKey,
          action: 'UPDATE',
          oldValue: current.customerAppIcon || (isCustomer ? 'default' : 'seller_default'),
          newValue: canonicalIcon,
          reason: `تغيير أيقونة تطبيق [${appType}]`,
          changedBy: adminUser.email || adminUser.id,
          ipAddress: req?.ip || req?.socket?.remoteAddress || null,
          userAgent: req?.headers ? (req.headers['user-agent'] as string) : null,
        },
      });
    }

    // 7. If appVersion was updated, sync active AppVersionPolicy in database
    if (updates.appVersion) {
      try {
        const cleanVer = updates.appVersion.trim();
        const match = cleanVer.match(/(\d+\.\d+(?:\.\d+)?)/);
        const buildMatch = cleanVer.match(/Build\s*(\d+)/i) || cleanVer.match(/\+(\d+)/);
        const verNumber = match ? match[1] : cleanVer;
        const buildNumber = buildMatch ? parseInt(buildMatch[1], 10) : 100;

        await prisma.appVersionPolicy.updateMany({
          where: { active: true },
          data: {
            latestVersion: verNumber,
            ...(buildMatch && { latestBuild: buildNumber }),
          },
        });
      } catch (_) {}
    }

    this.invalidateCache();
    this.broadcastConfigUpdate({
      key: `branding_${appType.toLowerCase()}`,
      action: 'UPDATE_BRANDING',
      version: newVersion,
    });
    return await this.getBrandingConfig(appType);
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
