export function isStoredObjectMatch(storedUrl: string | null | undefined, objectKey: string): boolean {
  if (!storedUrl || !objectKey) return false;
  const normalizedKey = objectKey.replace(/^\/+/, '').split('?')[0];
  try {
    const pathname = new URL(storedUrl, 'https://storage.invalid').pathname.replace(/^\/+/, '');
    const storagePath = pathname.replace(/^api\/v1\//, '').replace(/^storage\/file\//, '');
    return storagePath === normalizedKey || storagePath.endsWith(`/${normalizedKey}`);
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
