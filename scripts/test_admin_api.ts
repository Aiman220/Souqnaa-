import { prisma } from '../src/database/prisma';
import jwt from 'jsonwebtoken';

async function main() {
  const adminUser = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
  });
  console.log('Admin user found:', adminUser?.id, adminUser?.email);

  const secret = process.env.JWT_SECRET || 'secret';
  const token = jwt.sign(
    { userId: adminUser?.id, role: 'ADMIN', email: adminUser?.email },
    secret
  );

  const res1 = await fetch('http://localhost:3000/api/v1/admin/campaigns', {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('GET /api/v1/admin/campaigns -> status:', res1.status);
  const data1: any = await res1.json();
  console.log('Campaigns count:', Array.isArray(data1.data) ? data1.data.length : data1.data?.campaigns?.length);

  const res2 = await fetch('http://localhost:3000/api/v1/admin/banners', {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('GET /api/v1/admin/banners -> status:', res2.status);
  const data2: any = await res2.json();
  console.log('Banners response data keys:', Object.keys(data2.data || {}));
  console.log('Banners count:', data2.data?.banners?.length ?? data2.data?.length);
  console.log('Banners preview:', JSON.stringify(data2.data).slice(0, 300));
}

main().catch(console.error).finally(() => prisma.$disconnect());
