/**
 * SOUQNA — AR-2.4: Production-Grade Numeric Version Comparison Utility
 * 
 * Safely parses and compares semantic versions component-by-component.
 * Rejects malformed or excessively long strings without crashing.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  build?: number;
  raw: string;
}

const MAX_VERSION_STRING_LENGTH = 64;

// Matches standard semver: [v]major.minor[.patch][+build or -build]
const SEMVER_REGEX = /^v?(\d{1,8})\.(\d{1,8})(?:\.(\d{1,8}))?(?:[+-](\d{1,12}))?$/i;

/**
 * Parses a version string into numeric components.
 * Returns null if the input is malformed, invalid, or exceeds length limits.
 */
export function parseAppVersion(versionStr?: string | null): ParsedVersion | null {
  if (!versionStr || typeof versionStr !== 'string') {
    return null;
  }

  const trimmed = versionStr.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_STRING_LENGTH) {
    return null;
  }

  const match = trimmed.match(SEMVER_REGEX);
  if (!match) {
    return null;
  }

  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = match[3] !== undefined ? parseInt(match[3], 10) : 0;
  const build = match[4] !== undefined ? parseInt(match[4], 10) : undefined;

  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    build,
    raw: trimmed,
  };
}

/**
 * Compares two versions numerically by component (major, minor, patch, build).
 * Returns:
 *   > 0 if v1 is newer than v2
 *   0   if v1 equals v2
 *   < 0 if v1 is older than v2
 * Throws an Error if either version is malformed.
 */
export function compareAppVersions(
  v1Str: string,
  v2Str: string,
  build1Override?: number,
  build2Override?: number
): number {
  const v1 = parseAppVersion(v1Str);
  const v2 = parseAppVersion(v2Str);

  if (!v1) {
    throw new Error(`[VersionComparator] Malformed or invalid version string: "${v1Str}"`);
  }
  if (!v2) {
    throw new Error(`[VersionComparator] Malformed or invalid version string: "${v2Str}"`);
  }

  if (v1.major !== v2.major) {
    return v1.major - v2.major;
  }

  if (v1.minor !== v2.minor) {
    return v1.minor - v2.minor;
  }

  if (v1.patch !== v2.patch) {
    return v1.patch - v2.patch;
  }

  // Core semver equal — compare build numbers if present
  const b1 = build1Override ?? v1.build;
  const b2 = build2Override ?? v2.build;

  if (b1 !== undefined && b2 !== undefined) {
    return b1 - b2;
  }

  return 0;
}

/**
 * Evaluates whether client version meets or exceeds the required minimum version.
 * Returns boolean safely without throwing.
 */
export function isVersionSupported(
  clientVersionStr?: string | null,
  minVersionStr?: string | null,
  clientBuild?: number,
  minBuild?: number
): boolean {
  if (!clientVersionStr || !minVersionStr) {
    return false;
  }

  try {
    const cmp = compareAppVersions(clientVersionStr, minVersionStr, clientBuild, minBuild);
    return cmp >= 0;
  } catch {
    return false;
  }
}
