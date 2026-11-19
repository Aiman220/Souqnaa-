const fs = require('fs');
const seed = fs.readFileSync('backend/src/database/seed_categories.ts', 'utf8');
const icons = [...seed.matchAll(/"icon":\s*"([^"]+)"/g)].map(m => m[1]);
const slugs = [...seed.matchAll(/"slug":\s*"([^"]+)"/g)].map(m => m[1]);
console.log("Unique icons:", new Set(icons).size);
console.log("Total slugs:", slugs.length);
console.log("Unique slugs:", new Set(slugs).size);
const dupSlugs = slugs.filter((s, i) => slugs.indexOf(s) !== i);
console.log("Duplicate slugs:", dupSlugs);
