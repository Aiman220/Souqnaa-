const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();
const promptCategories = require('./prompt_categories_parsed.json');

async function audit() {
  console.log('Starting Taxonomy Audit against user prompt requirements...\n');
  const rootCategories = await prisma.category.findMany({
    where: { parentId: null, isActive: true },
    include: { children: { where: { isActive: true } } },
    orderBy: { sortOrder: 'asc' }
  });

  console.log(`Active Root Categories in DB: ${rootCategories.length} (Expected: 20)`);
  if (rootCategories.length !== 20) {
    console.error('❌ Root categories count mismatch!');
  } else {
    console.log('✓ Exactly 20 active root categories verified.');
  }

  let totalExpectedSubs = 0;
  let totalMissingSubs = 0;
  let totalMatchingSubs = 0;

  for (const pCat of promptCategories) {
    console.log(`\nChecking [${pCat.index}] ${pCat.nameEn} — ${pCat.nameAr}:`);
    // Find matching root category in DB by name or slug
    const rootInDb = rootCategories.find(r => 
      r.nameEn.toLowerCase() === pCat.nameEn.toLowerCase() ||
      r.nameAr === pCat.nameAr ||
      (pCat.index === 5 && r.slug === 'home-appliances') ||
      (pCat.index === 4 && r.slug === 'home-furniture') ||
      r.slug === pCat.nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    );

    if (!rootInDb) {
      console.error(`  ❌ Root category NOT FOUND in DB: ${pCat.nameEn}`);
      continue;
    }

    console.log(`  ✓ Matched DB Root: id=${rootInDb.id}, slug="${rootInDb.slug}"`);
    const dbSubs = rootInDb.children || [];
    console.log(`  Subcategories in DB: ${dbSubs.length}, Expected from prompt: ${pCat.subcategories.length}`);

    // Check each expected subcategory
    for (const pSub of pCat.subcategories) {
      totalExpectedSubs++;
      const match = dbSubs.find(s => 
        (pSub.nameEn === 'Other' && (s.slug.startsWith('other-') || s.nameEn.toLowerCase() === 'other' || s.nameAr === 'أخرى')) ||
        s.nameEn.toLowerCase() === pSub.nameEn.toLowerCase() ||
        s.nameAr === pSub.nameAr
      );

      if (match) {
        totalMatchingSubs++;
      } else {
        totalMissingSubs++;
        console.warn(`    ⚠️ Missing subcategory: "${pSub.nameEn}" — "${pSub.nameAr}"`);
      }
    }

    // Verify Other subcategory
    const otherSub = dbSubs.find(s => s.slug.startsWith('other-') || s.nameEn.toLowerCase() === 'other' || s.nameAr === 'أخرى');
    if (otherSub) {
      console.log(`  ✓ Universal Other subcategory present: slug="${otherSub.slug}", icon="${otherSub.icon}"`);
    } else {
      console.error(`  ❌ Universal Other subcategory MISSING!`);
    }
  }

  console.log('\n================ AUDIT RESULTS ================');
  console.log(`Total Expected Subcategories across 20 Categories: ${totalExpectedSubs}`);
  console.log(`Matched Subcategories: ${totalMatchingSubs}`);
  console.log(`Missing Subcategories: ${totalMissingSubs}`);
  console.log('===============================================\n');

  await prisma.$disconnect();
}

audit().catch(e => {
  console.error(e);
  process.exit(1);
});
