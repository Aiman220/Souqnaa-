const fs = require('fs');

const promptText = fs.readFileSync('backend/scripts/prompt_text.txt', 'utf8');

// Parse the 20 main categories and their subcategories from Section 2
const startIdx = promptText.indexOf('2. Complete approved main categories and subcategories');
const endIdx = promptText.indexOf('3. Universal Other / أخرى implementation');
const section2 = promptText.substring(startIdx, endIdx);

const lines = section2.split('\n');
const parsedPromptCategories = [];
let currentCat = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  const catMatch = line.match(/^(\d+)\.\s+([^\n—]+)\s+—\s+([^\n]+)/);
  if (catMatch && parseInt(catMatch[1], 10) <= 20) {
    currentCat = {
      index: parseInt(catMatch[1], 10),
      nameEn: catMatch[2].trim(),
      nameAr: catMatch[3].trim(),
      subcategories: []
    };
    parsedPromptCategories.push(currentCat);
    continue;
  }

  if (currentCat && line.startsWith('- ')) {
    const subText = line.substring(2).trim();
    const subMatch = subText.match(/^([^\n—]+)\s+—\s+([^\n]+)/);
    if (subMatch) {
      currentCat.subcategories.push({
        nameEn: subMatch[1].trim(),
        nameAr: subMatch[2].trim()
      });
    } else if (subText.toLowerCase() === 'other' || subText === 'أخرى') {
      currentCat.subcategories.push({
        nameEn: 'Other',
        nameAr: 'أخرى'
      });
    }
  }
}

console.log('Parsed Categories from Prompt:', parsedPromptCategories.length);
parsedPromptCategories.forEach(c => {
  console.log(`${c.index}. ${c.nameEn} — ${c.nameAr} (${c.subcategories.length} subs)`);
});

fs.writeFileSync('backend/scripts/prompt_categories_parsed.json', JSON.stringify(parsedPromptCategories, null, 2));
