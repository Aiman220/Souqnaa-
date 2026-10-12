import {
  AppTypeEnum,
  AppPlatformEnum,
  AppDeviceTypeEnum,
  ReleaseStatusEnum,
  ReleaseChannelEnum,
} from '@prisma/client';

export interface AppConfigQuery {
  appType?: string;
  platform?: string;
  deviceType?: string;
  version?: string;
  build?: number | string;
  environment?: string;
}

export interface AppConfigResponseData {
  app: {
    appType: string;
    platform: string;
    deviceType: string;
  };
  versionPolicy: {
    latestVersion: string;
    latestBuild: number;
    minimumSupportedVersion: string;
    minimumSupportedBuild: number;
    forceUpdateEnabled: boolean;
    optionalUpdateEnabled: boolean;
  };
  store: {
    name: string;
    url: string;
    packageIdentifier?: string | null;
    bundleIdentifier?: string | null;
    windowsAppIdentifier?: string | null;
  };
  release?: {
    version: string;
    buildNumber?: number;
    releaseNotesAr?: string | null;
    releaseNotesEn?: string | null;
    releaseDate?: string;
  } | null;
  maintenance?: {
    enabled: boolean;
    isEmergency?: boolean;
    maintenanceStart?: string | null;
    maintenanceEnd?: string | null;
    messageAr?: string | null;
    messageEn?: string | null;
    allowBrowsing?: boolean;
  };
}

export interface CreateReleaseDto {
  appType: AppTypeEnum;
  platform: AppPlatformEnum;
  deviceType?: AppDeviceTypeEnum | null;
  version: string;
  buildNumber: number;
  releaseDate?: string;
  releaseNotesAr?: string;
  releaseNotesEn?: string;
  status?: ReleaseStatusEnum;
  isLatest?: boolean;
  isRecommended?: boolean;
  minimumSupported?: boolean;
  storeUrl?: string;
  releaseChannel?: ReleaseChannelEnum;
}

export interface UpdateReleaseDto {
  version?: string;
  buildNumber?: number;
  releaseNotesAr?: string;
  releaseNotesEn?: string;
  status?: ReleaseStatusEnum;
  isLatest?: boolean;
  isRecommended?: boolean;
  minimumSupported?: boolean;
  storeUrl?: string;
  releaseChannel?: ReleaseChannelEnum;
}

export interface UpdateVersionPolicyDto {
  latestVersion?: string;
  latestBuild?: number;
  minimumSupportedVersion?: string;
  minimumSupportedBuild?: number;
  forceUpdateEnabled?: boolean;
  optionalUpdateEnabled?: boolean;
  releaseNotesEnabled?: boolean;
  active?: boolean;
}

export interface UpdateStoreLinkDto {
  storeName?: string;
  storeUrl?: string;
  packageIdentifier?: string;
  bundleIdentifier?: string;
  windowsAppIdentifier?: string;
  active?: boolean;
}

export interface UpdateMaintenanceRuleDto {
  enabled?: boolean;
  isEmergency?: boolean;
  maintenanceStart?: string | null;
  maintenanceEnd?: string | null;
  maintenanceMessageAr?: string;
  maintenanceMessageEn?: string;
  allowBrowsing?: boolean;
}
