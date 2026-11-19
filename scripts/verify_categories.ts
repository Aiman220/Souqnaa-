import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const rootCategories = await prisma.category.findMany({
    where: { parentId: null, isActive: true },
    orderBy: { sortOrder: 'asc' },
    include: {
      children: {
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          nameAr: true,
          nameEn: true,
          slug: true,
          icon: true,
          sortOrder: true,
        },
      },
    },
  });

  const allCount = await prisma.category.count();
  const rootCount = rootCategories.length;
  const subCount = allCount - rootCount;

  const products = await prisma.product.findMany({
    select: { id: true, nameAr: true, categoryId: true, category: { select: { slug: true, nameAr: true } } },
  });

  console.log(`\n================ CATALOG AUDIT SUMMARY ================`);
  console.log(`Total Categories in Database: ${allCount}`);
  console.log(`Root Categories: ${rootCount}`);
  console.log(`Subcategories: ${subCount}`);
  console.log(`Total Products in Database: ${products.length}`);
  for (const pr of products) {
    console.log(`  📦 Product: "${pr.nameAr}" -> Category: [${pr.category?.slug}] ${pr.category?.nameAr}`);
  }
  console.log('');

  for (const root of rootCategories) {
    const num = root.sortOrder.toString().padStart(2, '0');
    console.log(`📁 CATEGORY ${num}: ${root.nameAr} | ${root.nameEn}`);
    console.log(`   slug: "${root.slug}" | icon: "${root.icon}" | image: "${root.image?.substring(0, 45)}..."`);
    console.log(`   Subcategories (${root.children.length}):`);
    for (const sub of root.children) {
      console.log(`     • ${sub.nameAr} — ${sub.nameEn} (slug: ${sub.slug}, icon: ${sub.icon})`);
    }
    console.log('');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

