function stripVariant(pathStr: string): string {
  return pathStr
    .replace(/\/variants\//g, '/')
    .replace(/_(thumbnail|small|medium|large)\.[a-z0-9]+$/i, '');
}

export function isStoredObjectMatch(storedUrl: string | null | undefined, objectKey: string): boolean {
  if (!storedUrl || !objectKey) return false;
  const normalizedKey = objectKey.replace(/^\/+/, '').split('?')[0];
  try {
    const pathname = new URL(storedUrl, 'https://storage.invalid').pathname.replace(/^\/+/, '');
    const storagePath = pathname.replace(/^api\/v1\//, '').replace(/^storage\/file\//, '');
    if (storagePath === normalizedKey || storagePath.endsWith(`/${normalizedKey}`)) {
      return true;
    }
    // Variant comparison: compare base stems
    const baseStorage = stripVariant(storagePath);
    const baseTarget = stripVariant(normalizedKey);
    return (
      baseStorage === baseTarget ||
      baseStorage.endsWith(`/${baseTarget}`) ||
      baseTarget.endsWith(`/${baseStorage}`)
    );
  } catch {
    return false;
  }
}

export function isSellerReportOwnedBy(userId: string, objectKey: string): boolean {
  return objectKey.startsWith(`reports/${userId}/`);
}

export function isRefundEvidenceParticipant(userId: string, customerId: string, sellerUserId: string): boolean {
  return userId === customerId || userId === sellerUserId;
}

const ADMIN_PRIVATE_STORAGE_PERMISSIONS: Record<string, readonly string[]> = {
  'chat/': ['support:view', 'support:manage'],
  'support/': ['support:view', 'support:manage'],
  'refunds/': ['disputes:resolve'],
  'refund-evidence/': ['disputes:resolve'],
  'disputes/': ['disputes:resolve'],
  'documents/': ['sellers:view', 'sellers:approve'],
  'seller-verification/': ['sellers:view', 'sellers:approve'],
  'customer-deposits/': ['finance:view', 'finance:payments'],
  'finance_proofs/': ['finance:view', 'finance:payments', 'finance:withdrawals'],
  'withdrawals/': ['finance:view', 'finance:withdrawals'],
  'reports/': ['reports:view'],
};

/** Admins may read private storage only when their RBAC grants access to its data class. */
export function hasAdminPrivateStoragePermission(
  userPermissions: ReadonlySet<string>,
  objectKey: string,
): boolean {
  const prefix = Object.keys(ADMIN_PRIVATE_STORAGE_PERMISSIONS).find((candidate) => objectKey.startsWith(candidate));
  if (!prefix) return false;
  return ADMIN_PRIVATE_STORAGE_PERMISSIONS[prefix].some((permission) => userPermissions.has(permission));
}
