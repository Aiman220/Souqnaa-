export function selectAdminIdsWithPermission(
  activeAdminIds: string[],
  permissionsByAdmin: ReadonlyMap<string, ReadonlySet<string>>,
  requiredPermission: string,
  superAdminIds: string[] = []
): string[] {
  const activeIds = new Set(activeAdminIds);
  const authorizedIds = activeAdminIds.filter((id) => permissionsByAdmin.get(id)?.has(requiredPermission));
  return Array.from(new Set([...authorizedIds, ...superAdminIds.filter((id) => activeIds.has(id))]));
}
