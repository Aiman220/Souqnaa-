import {
  AppTypeEnum,
  AppPlatformEnum,
  AppDeviceTypeEnum,
  ReleaseStatusEnum,
  ReleaseChannelEnum,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { remoteConfigService } from '../remote-config/remote-config.service';
import {
  AppConfigQuery,
  AppConfigResponseData,
  CreateReleaseDto,
  UpdateReleaseDto,
  UpdateVersionPolicyDto,
  UpdateStoreLinkDto,
  UpdateMaintenanceRuleDto,
} from './app-lifecycle.types';

export class AppLifecycleService {
  // ==========================================
  // RESOLVE CENTRAL CLIENT APP CONFIG (§18, §19)
  // ==========================================
  async resolveAppConfig(query: AppConfigQuery): Promise<AppConfigResponseData> {
    const appType = this.normalizeAppType(query.appType);
    const platform = this.normalizePlatform(query.platform);
    const deviceType = this.normalizeDeviceType(query.deviceType);
    const environment = this.normalizeEnvironment(query.environment);

    // 1. Fetch Version Policy from DB with graceful fallback defaults
    const policy = await prisma.appVersionPolicy.findFirst({
      where: {
        appType,
        platform,
        environment,
        active: true,
        OR: [{ deviceType }, { deviceType: null }],
      },
      orderBy: { createdAt: 'desc' },
    });

    let defaultLatestVersion = '1.80.37';
    let defaultLatestBuild = 202610;

    // Check app_branding_config for fallback version set from admin
    try {
      const brandingSetting = await prisma.systemSetting.findUnique({
        where: { key: 'app_branding_config' },
      });
      if (brandingSetting && brandingSetting.value) {
        const parsed = JSON.parse(brandingSetting.value);
        if (parsed.appVersion) {
          const match = parsed.appVersion.match(/(\d+\.\d+(?:\.\d+)?)/);
          if (match) defaultLatestVersion = match[1];
          const bMatch = parsed.appVersion.match(/Build\s*(\d+)/i) || parsed.appVersion.match(/\+(\d+)/);
          if (bMatch) defaultLatestBuild = parseInt(bMatch[1], 10);
        }
      }
    } catch (_) {}

    const defaultMinVersion = '1.0.0';
    const defaultMinBuild = 100;

    const versionPolicyData = {
      latestVersion: policy?.latestVersion ?? defaultLatestVersion,
      latestBuild: policy?.latestBuild ?? defaultLatestBuild,
      minimumSupportedVersion: policy?.minimumSupportedVersion ?? defaultMinVersion,
      minimumSupportedBuild: policy?.minimumSupportedBuild ?? defaultMinBuild,
      forceUpdateEnabled: policy?.forceUpdateEnabled ?? true,
      optionalUpdateEnabled: policy?.optionalUpdateEnabled ?? true,
    };

    // 2. Fetch Store Link from DB with official platform default fallbacks
    const storeLink = await prisma.appStoreLink.findFirst({
      where: {
        appType,
        platform,
        active: true,
      },
    });

    const fallbackStore = this.getDefaultStoreLink(appType, platform);
    const storeData = {
      name: storeLink?.storeName ?? fallbackStore.name,
      url: storeLink?.storeUrl ?? fallbackStore.url,
      packageIdentifier: storeLink?.packageIdentifier ?? fallbackStore.packageIdentifier,
      bundleIdentifier: storeLink?.bundleIdentifier ?? fallbackStore.bundleIdentifier,
      windowsAppIdentifier: storeLink?.windowsAppIdentifier ?? fallbackStore.windowsAppIdentifier,
    };

    // 3. Fetch Latest Published Release Notes
    const latestRelease = await prisma.appRelease.findFirst({
      where: {
        appType,
        platform,
        status: ReleaseStatusEnum.PUBLISHED,
        releaseChannel: environment,
      },
      orderBy: [{ buildNumber: 'desc' }, { releaseDate: 'desc' }],
    });

    const releaseData = latestRelease
      ? {
          version: latestRelease.version,
          buildNumber: latestRelease.buildNumber,
          releaseNotesAr: latestRelease.releaseNotesAr,
          releaseNotesEn: latestRelease.releaseNotesEn,
          releaseDate: latestRelease.releaseDate.toISOString(),
        }
      : {
          version: versionPolicyData.latestVersion,
          buildNumber: versionPolicyData.latestBuild,
          releaseNotesAr: 'تحسينات عامة في الأداء واستقرار التطبيق.',
          releaseNotesEn: 'General performance improvements and system stability enhancements.',
        };

    // 4. Evaluate Maintenance Mode (§20)
    const maintenanceRule = await prisma.appMaintenanceRule.findFirst({
      where: {
        enabled: true,
        OR: [
          // Global maintenance
          { appType: null, platform: null },
          // App-specific
          { appType, platform: null },
          // Platform-specific
          { appType, platform },
        ],
      },
      orderBy: { isEmergency: 'desc' },
    });

    const maintenanceData = maintenanceRule
      ? {
          enabled: true,
          isEmergency: maintenanceRule.isEmergency,
          maintenanceStart: maintenanceRule.maintenanceStart?.toISOString() ?? null,
          maintenanceEnd: maintenanceRule.maintenanceEnd?.toISOString() ?? null,
          messageAr:
            maintenanceRule.maintenanceMessageAr ||
            'سوقنا تحت الصيانة المجدولة لتحسين تجربتكم. سنعود قريباً!',
          messageEn:
            maintenanceRule.maintenanceMessageEn ||
            'SOUQNA is currently undergoing scheduled maintenance. We will be back shortly.',
          allowBrowsing: maintenanceRule.allowBrowsing,
        }
      : {
          enabled: false,
          allowBrowsing: false,
        };

    return {
      app: {
        appType: appType.toLowerCase(),
        platform: platform.toLowerCase(),
        deviceType: deviceType.toLowerCase(),
      },
      versionPolicy: versionPolicyData,
      store: storeData,
      release: releaseData,
      maintenance: maintenanceData,
    };
  }

  // ==========================================
  // RELEASES MANAGEMENT (§14, §31, §32)
  // ==========================================
  async listReleases(params: {
    appType?: string;
    platform?: string;
    channel?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.AppReleaseWhereInput = {};
    if (params.appType) where.appType = this.normalizeAppType(params.appType);
    if (params.platform) where.platform = this.normalizePlatform(params.platform);
    if (params.channel) where.releaseChannel = this.normalizeEnvironment(params.channel);
    if (params.status) where.status = params.status as ReleaseStatusEnum;

    const [total, releases] = await Promise.all([
      prisma.appRelease.count({ where }),
      prisma.appRelease.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ releaseDate: 'desc' }, { buildNumber: 'desc' }],
      }),
    ]);

    return { total, page, limit, releases };
  }

  async createRelease(dto: CreateReleaseDto, adminId: string, requestId?: string) {
    const appType = this.normalizeAppType(dto.appType);
    const platform = this.normalizePlatform(dto.platform);
    const deviceType = dto.deviceType ? this.normalizeDeviceType(dto.deviceType) : null;
    const channel = dto.releaseChannel || ReleaseChannelEnum.PRODUCTION;
    const status = dto.status || ReleaseStatusEnum.DRAFT;

    // Check if duplicate version/build exists
    const existing = await prisma.appRelease.findFirst({
      where: {
        appType,
        platform,
        version: dto.version,
        buildNumber: dto.buildNumber,
        releaseChannel: channel,
      },
    });

    if (existing) {
      throw new AppError(
        `الإصدار ${dto.version} (+${dto.buildNumber}) مسجل مسبقاً لهذه المنصة والقناة.`,
        400
      );
    }

    const release = await prisma.appRelease.create({
      data: {
        appType,
        platform,
        deviceType,
        version: dto.version,
        buildNumber: dto.buildNumber,
        releaseDate: dto.releaseDate ? new Date(dto.releaseDate) : new Date(),
        releaseNotesAr: dto.releaseNotesAr,
        releaseNotesEn: dto.releaseNotesEn,
        status,
        isLatest: dto.isLatest ?? false,
        isRecommended: dto.isRecommended ?? true,
        minimumSupported: dto.minimumSupported ?? false,
        storeUrl: dto.storeUrl,
        releaseChannel: channel,
      },
    });

    // If marked as latest and published, update active version policy
    if (release.isLatest && release.status === ReleaseStatusEnum.PUBLISHED) {
      await this.syncPolicyWithLatestRelease(release);
    }

    await this.recordAuditLog(
      adminId,
      'release creation',
      release.id,
      null,
      JSON.stringify(release),
      requestId
    );

    return release;
  }

  async updateRelease(
    id: string,
    dto: UpdateReleaseDto,
    adminId: string,
    requestId?: string
  ) {
    const existing = await prisma.appRelease.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('الإصدار المطلوب غير موجود.', 404);
    }

    const updated = await prisma.appRelease.update({
      where: { id },
      data: {
        ...(dto.version && { version: dto.version }),
        ...(dto.buildNumber && { buildNumber: dto.buildNumber }),
        ...(dto.releaseNotesAr !== undefined && { releaseNotesAr: dto.releaseNotesAr }),
        ...(dto.releaseNotesEn !== undefined && { releaseNotesEn: dto.releaseNotesEn }),
        ...(dto.status && { status: dto.status }),
        ...(dto.isLatest !== undefined && { isLatest: dto.isLatest }),
        ...(dto.isRecommended !== undefined && { isRecommended: dto.isRecommended }),
        ...(dto.minimumSupported !== undefined && { minimumSupported: dto.minimumSupported }),
        ...(dto.storeUrl !== undefined && { storeUrl: dto.storeUrl }),
        ...(dto.releaseChannel && { releaseChannel: dto.releaseChannel }),
      },
    });

    if (updated.isLatest && updated.status === ReleaseStatusEnum.PUBLISHED) {
      await this.syncPolicyWithLatestRelease(updated);
    }

    await this.recordAuditLog(
      adminId,
      updated.status === ReleaseStatusEnum.ROLLED_BACK ? 'release rollback' : 'release update',
      updated.id,
      JSON.stringify(existing),
      JSON.stringify(updated),
      requestId
    );

    return updated;
  }

  private async syncPolicyWithLatestRelease(release: any) {
    // Unset other latest releases
    await prisma.appRelease.updateMany({
      where: {
        appType: release.appType,
        platform: release.platform,
        releaseChannel: release.releaseChannel,
        id: { not: release.id },
      },
      data: { isLatest: false },
    });

    // Upsert version policy
    const policy = await prisma.appVersionPolicy.findFirst({
      where: {
        appType: release.appType,
        platform: release.platform,
        environment: release.releaseChannel,
      },
    });

    if (policy) {
      await prisma.appVersionPolicy.update({
        where: { id: policy.id },
        data: {
          latestVersion: release.version,
          latestBuild: release.buildNumber,
          active: true,
        },
      });
    } else {
      await prisma.appVersionPolicy.create({
        data: {
          appType: release.appType,
          platform: release.platform,
          latestVersion: release.version,
          latestBuild: release.buildNumber,
          minimumSupportedVersion: release.version,
          minimumSupportedBuild: release.buildNumber,
          forceUpdateEnabled: true,
          optionalUpdateEnabled: true,
          releaseNotesEnabled: true,
          active: true,
          environment: release.releaseChannel,
        },
      });
    }

    // Keep app_branding_config and RemoteConfig synchronized with latest published version
    try {
      const brandingSetting = await prisma.systemSetting.findUnique({
        where: { key: 'app_branding_config' },
      });
      if (brandingSetting && brandingSetting.value) {
        const parsed = JSON.parse(brandingSetting.value);
        parsed.appVersion = `v ${release.version} (Build ${release.buildNumber})`;
        await prisma.systemSetting.update({
          where: { key: 'app_branding_config' },
          data: { value: JSON.stringify(parsed) },
        });
      }
    } catch (_) {}

    // Real-time broadcast to all connected apps (Customer, Seller) via WebSocket
    try {
      remoteConfigService.broadcastConfigUpdate({
        key: 'app_version',
        action: 'RELEASE_PUBLISHED',
      });
    } catch (_) {}
  }

  // ==========================================
  // VERSION POLICIES (§15, §39, §40)
  // ==========================================
  async listVersionPolicies(environment?: string) {
    const env = environment ? this.normalizeEnvironment(environment) : ReleaseChannelEnum.PRODUCTION;
    let policies = await prisma.appVersionPolicy.findMany({
      where: { environment: env },
      orderBy: [{ appType: 'asc' }, { platform: 'asc' }],
    });

    // If empty in DB, auto-seed defaults so admin dashboard and clients always have values
    if (policies.length === 0) {
      await this.seedDefaultPoliciesAndStoreLinks();
      policies = await prisma.appVersionPolicy.findMany({
        where: { environment: env },
        orderBy: [{ appType: 'asc' }, { platform: 'asc' }],
      });
    }

    return policies;
  }

  async updateVersionPolicy(
    id: string,
    dto: UpdateVersionPolicyDto,
    adminId: string,
    requestId?: string
  ) {
    const existing = await prisma.appVersionPolicy.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('سياسة التحديث غير موجودة.', 404);
    }

    const updated = await prisma.appVersionPolicy.update({
      where: { id },
      data: {
        ...(dto.latestVersion && { latestVersion: dto.latestVersion }),
        ...(dto.latestBuild && { latestBuild: dto.latestBuild }),
        ...(dto.minimumSupportedVersion && { minimumSupportedVersion: dto.minimumSupportedVersion }),
        ...(dto.minimumSupportedBuild && { minimumSupportedBuild: dto.minimumSupportedBuild }),
        ...(dto.forceUpdateEnabled !== undefined && { forceUpdateEnabled: dto.forceUpdateEnabled }),
        ...(dto.optionalUpdateEnabled !== undefined && { optionalUpdateEnabled: dto.optionalUpdateEnabled }),
        ...(dto.releaseNotesEnabled !== undefined && { releaseNotesEnabled: dto.releaseNotesEnabled }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    });

    const isMinVersionChange =
      dto.minimumSupportedVersion && dto.minimumSupportedVersion !== existing.minimumSupportedVersion;

    await this.recordAuditLog(
      adminId,
      isMinVersionChange ? 'minimum version change' : 'version policy update',
      updated.id,
      JSON.stringify(existing),
      JSON.stringify(updated),
      requestId
    );

    this.clearPolicyCache();

    if (dto.latestVersion) {
      try {
        const brandingSetting = await prisma.systemSetting.findUnique({
          where: { key: 'app_branding_config' },
        });
        if (brandingSetting && brandingSetting.value) {
          const parsed = JSON.parse(brandingSetting.value);
          parsed.appVersion = `v ${dto.latestVersion}${dto.latestBuild ? ` (Build ${dto.latestBuild})` : ''}`;
          await prisma.systemSetting.update({
            where: { key: 'app_branding_config' },
            data: { value: JSON.stringify(parsed) },
          });
        }
      } catch (_) {}

      try {
        remoteConfigService.broadcastConfigUpdate({
          key: 'app_version',
          action: 'POLICY_UPDATED',
        });
      } catch (_) {}
    }

    return updated;
  }

  // ==========================================
  // STORE LINKS (§16)
  // ==========================================
  async listStoreLinks() {
    let links = await prisma.appStoreLink.findMany({
      orderBy: [{ appType: 'asc' }, { platform: 'asc' }],
    });

    if (links.length === 0) {
      await this.seedDefaultPoliciesAndStoreLinks();
      links = await prisma.appStoreLink.findMany({
        orderBy: [{ appType: 'asc' }, { platform: 'asc' }],
      });
    }

    return links;
  }

  async updateStoreLink(
    id: string,
    dto: UpdateStoreLinkDto,
    adminId: string,
    requestId?: string
  ) {
    const existing = await prisma.appStoreLink.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('رابط المتجر غير موجود.', 404);
    }

    const updated = await prisma.appStoreLink.update({
      where: { id },
      data: {
        ...(dto.storeName && { storeName: dto.storeName }),
        ...(dto.storeUrl && { storeUrl: dto.storeUrl }),
        ...(dto.packageIdentifier !== undefined && { packageIdentifier: dto.packageIdentifier }),
        ...(dto.bundleIdentifier !== undefined && { bundleIdentifier: dto.bundleIdentifier }),
        ...(dto.windowsAppIdentifier !== undefined && { windowsAppIdentifier: dto.windowsAppIdentifier }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    });

    await this.recordAuditLog(
      adminId,
      'store URL change',
      updated.id,
      JSON.stringify(existing),
      JSON.stringify(updated),
      requestId
    );

    return updated;
  }

  // ==========================================
  // MAINTENANCE MODE CONTROL (§20, §35)
  // ==========================================
  async getMaintenanceRules() {
    return prisma.appMaintenanceRule.findMany({
      orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async updateMaintenanceRule(
    id: string | null,
    dto: UpdateMaintenanceRuleDto,
    adminId: string,
    requestId?: string
  ) {
    let rule;
    let oldVal = null;

    if (id) {
      const existing = await prisma.appMaintenanceRule.findUnique({ where: { id } });
      if (!existing) throw new AppError('قاعدة الصيانة غير موجودة.', 404);
      oldVal = JSON.stringify(existing);

      rule = await prisma.appMaintenanceRule.update({
        where: { id },
        data: {
          ...(dto.enabled !== undefined && { enabled: dto.enabled }),
          ...(dto.isEmergency !== undefined && { isEmergency: dto.isEmergency }),
          ...(dto.maintenanceStart !== undefined && {
            maintenanceStart: dto.maintenanceStart ? new Date(dto.maintenanceStart) : null,
          }),
          ...(dto.maintenanceEnd !== undefined && {
            maintenanceEnd: dto.maintenanceEnd ? new Date(dto.maintenanceEnd) : null,
          }),
          ...(dto.maintenanceMessageAr !== undefined && { maintenanceMessageAr: dto.maintenanceMessageAr }),
          ...(dto.maintenanceMessageEn !== undefined && { maintenanceMessageEn: dto.maintenanceMessageEn }),
          ...(dto.allowBrowsing !== undefined && { allowBrowsing: dto.allowBrowsing }),
        },
      });
    } else {
      // Global rule toggle
      rule = await prisma.appMaintenanceRule.create({
        data: {
          enabled: dto.enabled ?? true,
          isEmergency: dto.isEmergency ?? false,
          maintenanceStart: dto.maintenanceStart ? new Date(dto.maintenanceStart) : null,
          maintenanceEnd: dto.maintenanceEnd ? new Date(dto.maintenanceEnd) : null,
          maintenanceMessageAr: dto.maintenanceMessageAr,
          maintenanceMessageEn: dto.maintenanceMessageEn,
          allowBrowsing: dto.allowBrowsing ?? false,
        },
      });
    }

    await this.recordAuditLog(
      adminId,
      'maintenance activation',
      rule.id,
      oldVal,
      JSON.stringify(rule),
      requestId
    );

    return rule;
  }

  // ==========================================
  // EVENT RECORDING & ANALYTICS (§29, §30, §33, §34)
  // ==========================================
  async recordUpdateEvent(event: {
    appType: string;
    platform: string;
    deviceType?: string;
    currentVersion: string;
    currentBuild: number;
    targetVersion?: string;
    targetBuild?: number;
    eventType: string;
    sessionId?: string;
    environment?: string;
  }) {
    return prisma.appUpdateEvent.create({
      data: {
        appType: this.normalizeAppType(event.appType),
        platform: this.normalizePlatform(event.platform),
        deviceType: event.deviceType ? this.normalizeDeviceType(event.deviceType) : null,
        currentVersion: event.currentVersion,
        currentBuild: Number(event.currentBuild) || 1,
        targetVersion: event.targetVersion,
        targetBuild: event.targetBuild ? Number(event.targetBuild) : null,
        eventType: event.eventType.toUpperCase(),
        sessionId: event.sessionId,
        environment: this.normalizeEnvironment(event.environment),
      },
    });
  }

  async recordRatingEvent(event: {
    appType: string;
    platform: string;
    deviceType?: string;
    currentVersion: string;
    eventType: string;
    sessionId?: string;
    environment?: string;
  }) {
    return prisma.appRatingEvent.create({
      data: {
        appType: this.normalizeAppType(event.appType),
        platform: this.normalizePlatform(event.platform),
        deviceType: event.deviceType ? this.normalizeDeviceType(event.deviceType) : null,
        currentVersion: event.currentVersion,
        eventType: event.eventType.toUpperCase(),
        sessionId: event.sessionId,
        environment: this.normalizeEnvironment(event.environment),
      },
    });
  }

  async getAnalyticsDashboard(filters: {
    appType?: string;
    platform?: string;
    environment?: string;
    days?: number;
  }) {
    const days = filters.days || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const whereUpdate: Prisma.AppUpdateEventWhereInput = {
      timestamp: { gte: since },
      ...(filters.appType && { appType: this.normalizeAppType(filters.appType) }),
      ...(filters.platform && { platform: this.normalizePlatform(filters.platform) }),
      ...(filters.environment && { environment: this.normalizeEnvironment(filters.environment) }),
    };

    const whereRating: Prisma.AppRatingEventWhereInput = {
      timestamp: { gte: since },
      ...(filters.appType && { appType: this.normalizeAppType(filters.appType) }),
      ...(filters.platform && { platform: this.normalizePlatform(filters.platform) }),
    };

    const [updateEvents, ratingEvents, totalUsersCount] = await Promise.all([
      prisma.appUpdateEvent.groupBy({
        by: ['eventType'],
        where: whereUpdate,
        _count: { id: true },
      }),
      prisma.appRatingEvent.groupBy({
        by: ['eventType'],
        where: whereRating,
        _count: { id: true },
      }),
      prisma.user.count(),
    ]);

    const updateCounts: Record<string, number> = {};
    for (const item of updateEvents) {
      updateCounts[item.eventType] = item._count.id;
    }

    const ratingCounts: Record<string, number> = {};
    for (const item of ratingEvents) {
      ratingCounts[item.eventType] = item._count.id;
    }

    // Version Distribution (§33)
    const versionDistributionRaw = await prisma.appUpdateEvent.groupBy({
      by: ['currentVersion', 'appType', 'platform'],
      where: whereUpdate,
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 15,
    });

    const checksCount = updateCounts['CHECKED'] || 1;
    const promptShown = updateCounts['PROMPT_SHOWN'] || 0;
    const updateAccepted = updateCounts['UPDATE_ACCEPTED'] || 0;
    const updateCompleted = updateCounts['UPDATE_COMPLETED'] || 0;
    const updateFailed = updateCounts['UPDATE_FAILED'] || 0;
    const storeOpened = updateCounts['STORE_OPENED'] || 0;

    const adoptionRate = promptShown > 0 ? (updateAccepted / promptShown) * 100 : 0;
    const completionRate = updateAccepted > 0 ? (updateCompleted / updateAccepted) * 100 : 0;
    const failureRate = (updateCompleted + updateFailed) > 0 ? (updateFailed / (updateCompleted + updateFailed)) * 100 : 0;
    const storeRedirectRate = promptShown > 0 ? (storeOpened / promptShown) * 100 : 0;

    return {
      periodDays: days,
      metrics: {
        totalChecks: checksCount,
        optionalUpdatePrompts: promptShown,
        mandatoryUpdateEvents: updateCounts['MANDATORY_UPDATE'] || 0,
        updateAccepted,
        updateCompleted,
        updateFailed,
        storeOpened,
        adoptionRate: Number(adoptionRate.toFixed(2)),
        completionRate: Number(completionRate.toFixed(2)),
        failureRate: Number(failureRate.toFixed(2)),
        storeRedirectRate: Number(storeRedirectRate.toFixed(2)),
      },
      ratings: {
        eligibilityChecked: ratingCounts['ELIGIBILITY_CHECKED'] || 0,
        promptsShown: ratingCounts['PROMPT_SHOWN'] || 0,
        promptsAccepted: ratingCounts['PROMPT_ACCEPTED'] || 0,
        promptsDismissed: ratingCounts['PROMPT_DISMISSED'] || 0,
        requestsCompleted: ratingCounts['REQUEST_COMPLETED'] || 0,
      },
      versionDistribution: versionDistributionRaw.map((v) => ({
        version: v.currentVersion,
        appType: v.appType.toLowerCase(),
        platform: v.platform.toLowerCase(),
        eventCount: v._count.id,
      })),
      totalMarketplaceUsers: totalUsersCount,
    };
  }

  // ==========================================
  // AUDIT LOGS (§38)
  // ==========================================
  async recordAuditLog(
    adminId: string,
    action: string,
    entityId: string | null,
    oldValue: string | null,
    newValue: string | null,
    requestId?: string
  ) {
    try {
      await prisma.appReleaseAuditLog.create({
        data: {
          adminId,
          action,
          entityId,
          oldValue,
          newValue,
          requestId,
        },
      });
    } catch (e) {
      // Non-blocking log failure
      console.error('Failed to write release audit log:', e);
    }
  }

  async listAuditLogs(page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [total, logs] = await Promise.all([
      prisma.appReleaseAuditLog.count(),
      prisma.appReleaseAuditLog.findMany({
        skip,
        take: limit,
        orderBy: { timestamp: 'desc' },
      }),
    ]);
    return { total, page, limit, logs };
  }

  // ==========================================
  // SEED DEFAULT POLICIES AND STORE LINKS
  // ==========================================
  async seedDefaultPoliciesAndStoreLinks() {
    const defaultPolicies: Prisma.AppVersionPolicyCreateManyInput[] = [
      {
        appType: AppTypeEnum.CUSTOMER,
        platform: AppPlatformEnum.ANDROID,
        latestVersion: '1.5.0',
        latestBuild: 150,
        minimumSupportedVersion: '1.2.0',
        minimumSupportedBuild: 120,
        forceUpdateEnabled: true,
        optionalUpdateEnabled: true,
        releaseNotesEnabled: true,
        active: true,
        environment: ReleaseChannelEnum.PRODUCTION,
      },
      {
        appType: AppTypeEnum.CUSTOMER,
        platform: AppPlatformEnum.IOS,
        latestVersion: '1.5.0',
        latestBuild: 150,
        minimumSupportedVersion: '1.2.0',
        minimumSupportedBuild: 120,
        forceUpdateEnabled: true,
        optionalUpdateEnabled: true,
        releaseNotesEnabled: true,
        active: true,
        environment: ReleaseChannelEnum.PRODUCTION,
      },
      {
        appType: AppTypeEnum.CUSTOMER,
        platform: AppPlatformEnum.WINDOWS,
        latestVersion: '1.5.0',
        latestBuild: 150,
        minimumSupportedVersion: '1.2.0',
        minimumSupportedBuild: 120,
        forceUpdateEnabled: true,
        optionalUpdateEnabled: true,
        releaseNotesEnabled: true,
        active: true,
        environment: ReleaseChannelEnum.PRODUCTION,
      },
      {
        appType: AppTypeEnum.CUSTOMER,
        platform: AppPlatformEnum.WEB,
        latestVersion: '1.5.0',
        latestBuild: 150,
        minimumSupportedVersion: '1.0.0',
        minimumSupportedBuild: 100,
        forceUpdateEnabled: true,
        optionalUpdateEnabled: true,
        releaseNotesEnabled: true,
        active: true,
        environment: ReleaseChannelEnum.PRODUCTION,
      },
      {
        appType: AppTypeEnum.SELLER,
        platform: AppPlatformEnum.ANDROID,
        latestVersion: '1.5.0',
        latestBuild: 150,
        minimumSupportedVersion: '1.2.0',
        minimumSupportedBuild: 120,
        forceUpdateEnabled: true,
        optionalUpdateEnabled: true,
        releaseNotesEnabled: true,
        active: true,
        environment: ReleaseChannelEnum.PRODUCTION,
      },
      {
        appType: AppTypeEnum.SELLER,
        platform: AppPlatformEnum.IOS,
        latestVersion: '1.5.0',
        latestBuild: 150,
        minimumSupportedVersion: '1.2.0',
        minimumSupportedBuild: 120,
        forceUpdateEnabled: true,
        optionalUpdateEnabled: true,
        releaseNotesEnabled: true,
        active: true,
        environment: ReleaseChannelEnum.PRODUCTION,
      },
      {
        appType: AppTypeEnum.SELLER,
        platform: AppPlatformEnum.WINDOWS,
        latestVersion: '1.5.0',
        latestBuild: 150,
        minimumSupportedVersion: '1.2.0',
        minimumSupportedBuild: 120,
        forceUpdateEnabled: true,
        optionalUpdateEnabled: true,
        releaseNotesEnabled: true,
        active: true,
        environment: ReleaseChannelEnum.PRODUCTION,
      },
      {
        appType: AppTypeEnum.SELLER,
        platform: AppPlatformEnum.WEB,
        latestVersion: '1.5.0',
        latestBuild: 150,
        minimumSupportedVersion: '1.0.0',
        minimumSupportedBuild: 100,
        forceUpdateEnabled: true,
        optionalUpdateEnabled: true,
        releaseNotesEnabled: true,
        active: true,
        environment: ReleaseChannelEnum.PRODUCTION,
      },
    ];

    const defaultStoreLinks: Prisma.AppStoreLinkCreateManyInput[] = [
      {
        appType: AppTypeEnum.CUSTOMER,
        platform: AppPlatformEnum.ANDROID,
        storeName: 'Google Play Store',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.souqnaa.app',
        packageIdentifier: 'com.souqnaa.app',
        active: true,
      },
      {
        appType: AppTypeEnum.CUSTOMER,
        platform: AppPlatformEnum.IOS,
        storeName: 'Apple App Store',
        storeUrl: 'https://apps.apple.com/app/souqna-customer/id1680000001',
        bundleIdentifier: 'com.souqnaa.app',
        active: true,
      },
      {
        appType: AppTypeEnum.CUSTOMER,
        platform: AppPlatformEnum.WINDOWS,
        storeName: 'Microsoft Store',
        storeUrl: 'ms-windows-store://pdp/?productid=9NBLGGH4SOUQ1',
        windowsAppIdentifier: '9NBLGGH4SOUQ1',
        active: true,
      },
      {
        appType: AppTypeEnum.CUSTOMER,
        platform: AppPlatformEnum.WEB,
        storeName: 'SOUQNA Web Portal',
        storeUrl: 'https://souqnaa.ye',
        active: true,
      },
      {
        appType: AppTypeEnum.SELLER,
        platform: AppPlatformEnum.ANDROID,
        storeName: 'Google Play Store',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.souqnaa.seller',
        packageIdentifier: 'com.souqnaa.seller',
        active: true,
      },
      {
        appType: AppTypeEnum.SELLER,
        platform: AppPlatformEnum.IOS,
        storeName: 'Apple App Store',
        storeUrl: 'https://apps.apple.com/app/souqna-seller/id1680000002',
        bundleIdentifier: 'com.souqnaa.seller',
        active: true,
      },
      {
        appType: AppTypeEnum.SELLER,
        platform: AppPlatformEnum.WINDOWS,
        storeName: 'Microsoft Store',
        storeUrl: 'ms-windows-store://pdp/?productid=9NBLGGH4SOUQ2',
        windowsAppIdentifier: '9NBLGGH4SOUQ2',
        active: true,
      },
      {
        appType: AppTypeEnum.SELLER,
        platform: AppPlatformEnum.WEB,
        storeName: 'SOUQNA Seller Portal',
        storeUrl: 'https://seller.souqnaa.ye',
        active: true,
      },
      {
        appType: AppTypeEnum.ADMIN,
        platform: AppPlatformEnum.ANDROID,
        storeName: 'Google Play Store',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.souqnaa.admin',
        packageIdentifier: 'com.souqnaa.admin',
        active: true,
      },
      {
        appType: AppTypeEnum.ADMIN,
        platform: AppPlatformEnum.IOS,
        storeName: 'Apple App Store',
        storeUrl: 'https://apps.apple.com/app/souqna-admin/id1680000003',
        bundleIdentifier: 'com.souqnaa.admin',
        active: true,
      },
      {
        appType: AppTypeEnum.ADMIN,
        platform: AppPlatformEnum.WINDOWS,
        storeName: 'Microsoft Store',
        storeUrl: 'ms-windows-store://pdp/?productid=9NBLGGH4SOUQ3',
        windowsAppIdentifier: '9NBLGGH4SOUQ3',
        active: true,
      },
      {
        appType: AppTypeEnum.ADMIN,
        platform: AppPlatformEnum.WEB,
        storeName: 'SOUQNA Admin Portal',
        storeUrl: 'https://admin.souqnaa.ye',
        active: true,
      },
    ];

    try {
      await prisma.appVersionPolicy.createMany({
        data: defaultPolicies,
        skipDuplicates: true,
      });
      await prisma.appStoreLink.createMany({
        data: defaultStoreLinks,
        skipDuplicates: true,
      });
    } catch (e) {
      console.warn('Default policies/store links seed warning:', e);
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================
  private normalizeAppType(type?: string): AppTypeEnum {
    const lower = (type || 'customer').toLowerCase().trim();
    if (lower === 'seller') return AppTypeEnum.SELLER;
    if (lower === 'admin') return AppTypeEnum.ADMIN;
    return AppTypeEnum.CUSTOMER;
  }

  private normalizePlatform(platform?: string): AppPlatformEnum {
    const lower = (platform || 'android').toLowerCase().trim();
    if (lower === 'ios') return AppPlatformEnum.IOS;
    if (lower === 'windows') return AppPlatformEnum.WINDOWS;
    if (lower === 'web') return AppPlatformEnum.WEB;
    return AppPlatformEnum.ANDROID;
  }

  private normalizeDeviceType(device?: string): AppDeviceTypeEnum {
    const lower = (device || 'phone').toLowerCase().trim();
    if (lower === 'tablet') return AppDeviceTypeEnum.TABLET;
    if (lower === 'desktop') return AppDeviceTypeEnum.DESKTOP;
    return AppDeviceTypeEnum.PHONE;
  }

  private normalizeEnvironment(env?: string): ReleaseChannelEnum {
    const lower = (env || 'production').toLowerCase().trim();
    if (lower === 'development' || lower === 'dev') return ReleaseChannelEnum.DEVELOPMENT;
    if (lower === 'staging') return ReleaseChannelEnum.STAGING;
    return ReleaseChannelEnum.PRODUCTION;
  }

  private getDefaultStoreLink(appType: AppTypeEnum, platform: AppPlatformEnum) {
    const isSeller = appType === AppTypeEnum.SELLER;
    switch (platform) {
      case AppPlatformEnum.ANDROID: {
        const androidPkg = isSeller
          ? 'com.souqnaa.seller'
          : (appType === AppTypeEnum.ADMIN ? 'com.souqnaa.admin' : 'com.souqnaa.app');
        return {
          name: 'Google Play Store',
          url: `https://play.google.com/store/apps/details?id=${androidPkg}`,
          packageIdentifier: androidPkg,
          bundleIdentifier: null,
          windowsAppIdentifier: null,
        };
      }
      case AppPlatformEnum.IOS: {
        const iosBundle = isSeller
          ? 'com.souqnaa.seller'
          : (appType === AppTypeEnum.ADMIN ? 'com.souqnaa.admin' : 'com.souqnaa.app');
        const iosAppId = isSeller
          ? '1680000002'
          : (appType === AppTypeEnum.ADMIN ? '1680000003' : '1680000001');
        return {
          name: 'Apple App Store',
          url: `https://apps.apple.com/app/souqna-${appType.toLowerCase()}/id${iosAppId}`,
          packageIdentifier: null,
          bundleIdentifier: iosBundle,
          windowsAppIdentifier: null,
        };
      }
      case AppPlatformEnum.WINDOWS: {
        const winId = isSeller
          ? '9NBLGGH4SOUQ2'
          : (appType === AppTypeEnum.ADMIN ? '9NBLGGH4SOUQ3' : '9NBLGGH4SOUQ1');
        return {
          name: 'Microsoft Store',
          url: `ms-windows-store://pdp/?productid=${winId}`,
          packageIdentifier: null,
          bundleIdentifier: null,
          windowsAppIdentifier: winId,
        };
      }
      case AppPlatformEnum.WEB:
      default: {
        const webUrl = isSeller
          ? 'https://seller.souqnaa.ye'
          : (appType === AppTypeEnum.ADMIN ? 'https://admin.souqnaa.ye' : 'https://souqnaa.ye');
        return {
          name: 'SOUQNA Web',
          url: webUrl,
          packageIdentifier: null,
          bundleIdentifier: null,
          windowsAppIdentifier: null,
        };
      }
    }
  }

  // ==========================================
  // VERSION ENFORCEMENT POLICY RESOLUTION (§AR-2.4)
  // ==========================================
  private policyCache = new Map<string, { data: any; expiry: number }>();

  async getActiveVersionPolicy(
    appType: AppTypeEnum,
    platform: AppPlatformEnum,
    environment = ReleaseChannelEnum.PRODUCTION
  ): Promise<{
    minimumSupportedVersion: string;
    minimumSupportedBuild: number;
    latestVersion: string;
    latestBuild: number;
    forceUpdateEnabled: boolean;
    storeUrl: string;
  }> {
    const cacheKey = `${appType}:${platform}:${environment}`;
    const cached = this.policyCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiry > now) {
      return cached.data;
    }

    try {
      const policy = await prisma.appVersionPolicy.findFirst({
        where: {
          appType,
          platform,
          environment,
          active: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const storeLink = await prisma.appStoreLink.findFirst({
        where: {
          appType,
          platform,
          active: true,
        },
      });

      const fallbackStore = this.getDefaultStoreLink(appType, platform);
      const result = {
        minimumSupportedVersion: policy?.minimumSupportedVersion ?? '1.0.0',
        minimumSupportedBuild: policy?.minimumSupportedBuild ?? 100,
        latestVersion: policy?.latestVersion ?? '1.80.37',
        latestBuild: policy?.latestBuild ?? 202610,
        forceUpdateEnabled: policy?.forceUpdateEnabled ?? true,
        storeUrl: storeLink?.storeUrl ?? fallbackStore.url,
      };

      this.policyCache.set(cacheKey, { data: result, expiry: now + 30000 });
      return result;
    } catch {
      const fallbackStore = this.getDefaultStoreLink(appType, platform);
      return {
        minimumSupportedVersion: '1.0.0',
        minimumSupportedBuild: 100,
        latestVersion: '1.80.37',
        latestBuild: 202610,
        forceUpdateEnabled: true,
        storeUrl: fallbackStore.url,
      };
    }
  }

  clearPolicyCache(): void {
    this.policyCache.clear();
  }
}

export const appLifecycleService = new AppLifecycleService();
