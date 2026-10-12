import { prisma } from '../src/database/prisma';

async function main() {
  const users = await prisma.user.findMany({
    where: { role: 'ADMIN' },
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      userRoles: { include: { role: true } },
    },
  });
  console.log('Existing Admin users in DB:', JSON.stringify(users, null, 2));

  const roles = await prisma.role.findMany({
    include: { permissions: { include: { permission: true } } },
  });
  console.log('Existing Roles in DB:', JSON.stringify(roles.map((r) => ({
    name: r.name,
    perms: r.permissions.map((p) => p.permission.action),
  })), null, 2));
}

main().finally(() => prisma.$disconnect());
