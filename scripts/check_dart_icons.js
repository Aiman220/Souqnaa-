const fs = require('fs');
const seed = fs.readFileSync('backend/src/database/seed_categories.ts', 'utf8');
const dart = fs.readFileSync('packages/design_system/lib/src/components/icons/category_icon_resolver.dart', 'utf8');

const icons = [...new Set([...seed.matchAll(/"icon":\s*"([^"]+)"/g)].map(m => m[1]))];
const slugs = [...new Set([...seed.matchAll(/"slug":\s*"([^"]+)"/g)].map(m => m[1]))];

const missingIcons = icons.filter(ic => !dart.includes(`'${ic}':`));
const missingSlugs = slugs.filter(sl => !dart.includes(`'${sl}':`));

console.log('Missing icons count:', missingIcons.length, missingIcons);
console.log('Missing slugs count:', missingSlugs.length);
