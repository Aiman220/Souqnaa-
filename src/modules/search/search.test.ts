import { prisma } from '../../database/prisma';
import { searchService } from './search.service';
import { visualSearchService } from './visual/visual-search.service';
import { catalogVisualIndexService } from './visual/catalog-visual-index.service';
import {
  normalizeArabic,
  toWesternDigits,
  stripArabicPrefix,
  getSearchTokensWithAliases,
  findTypoCorrections,
  damerauLevenshteinDistance,
  isTypoMatch,
} from './utils/arabic-normalizer.util';
import {
  validateImageBuffer,
  extractVisualFeatures,
  calculateHammingDistance,
  calculateColorDistance,
} from './visual/image-hasher.util';

async function runSearchTests() {
  console.log('🧪 Starting SOUQNA Smart Search Engine Production Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, details?: any) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`, details !== undefined ? details : '');
      failed++;
    }
  }

  try {
    // ── 1. Arabic Normalization Suite ──────────────────────────────────────────
    console.log('--- 1. Arabic Normalization Suite ---');
    const alefNorm = normalizeArabic('أحمد إلكترونيات آبل ٱيفون');
    assert(
      alefNorm === 'احمد الكترونيات ابل ايفون',
      'Normalizes all Alef variations (أ, إ, آ, ٱ) -> ا'
    );

    const tehMarbutaNorm = normalizeArabic('سماعة مميزة حديثة');
    assert(
      tehMarbutaNorm === 'سماعه مميزه حديثه',
      'Normalizes Teh Marbuta (ة) -> Heh (ه)'
    );

    const alifMaqsuraNorm = normalizeArabic('حلوى ومستشفى');
    assert(
      alifMaqsuraNorm === 'حلوي ومستشفي',
      'Normalizes Alif Maqsura (ى) -> Yaa (ي)'
    );

    const tashkeelNorm = normalizeArabic('سُوقُنَا الْمُمَيَّزُ');
    assert(
      tashkeelNorm === 'سوقنا المميز',
      'Strips all Tashkeel / Harakat diacritics'
    );

    const tatweelNorm = normalizeArabic('ســـــوقـنـــــا');
    assert(
      tatweelNorm === 'سوقنا',
      'Strips Tatweel (Kashida)'
    );

    const digitsNorm = toWesternDigits('ايفون ١٥ برو ماكس ٢٠٢٤');
    assert(
      digitsNorm === 'ايفون 15 برو ماكس 2024',
      'Converts Arabic-Indic digits (١٥ -> 15)'
    );

    const urduPersianNorm = normalizeArabic('کتاب یمنی');
    assert(
      urduPersianNorm === 'كتاب يمني',
      'Normalizes Persian and Urdu characters (ک -> ك, ی -> ي)'
    );

    const repeatedCharsNorm = normalizeArabic('ايييييييفون سسسماااااعة');
    assert(
      repeatedCharsNorm.includes('ايفون') && repeatedCharsNorm.includes('سماعه'),
      'Collapses exaggerated repeated characters (ايييييفون -> ايفون)'
    );

    const strippedPrefix = stripArabicPrefix('السماعة');
    assert(
      strippedPrefix === 'سماعة',
      'Strips Arabic definite article "ال" prefix from headwords'
    );

    // ── 2. Typo Tolerance & Transposition Suite ───────────────────────────────
    console.log('\n--- 2. Typo Tolerance & Damerau-Levenshtein ---');
    const distTransposed = damerauLevenshteinDistance('iphnoe', 'iphone');
    assert(
      distTransposed === 1,
      'Detects transposition (iphnoe -> iphone = distance 1)'
    );

    const distMissing = damerauLevenshteinDistance('samsng', 'samsung');
    assert(
      distMissing === 1,
      'Detects missing character (samsng -> samsung = distance 1)'
    );

    const distExtra = damerauLevenshteinDistance('iphonne', 'iphone');
    assert(
      distExtra === 1,
      'Detects extra character (iphonne -> iphone = distance 1)'
    );

    const typoMatchPhone = isTypoMatch('iphnoe', 'iphone');
    assert(
      typoMatchPhone === true,
      'isTypoMatch recognizes "iphnoe" matches "iphone"'
    );

    const typoMatchSamsung = isTypoMatch('samsng', 'samsung');
    assert(
      typoMatchSamsung === true,
      'isTypoMatch recognizes "samsng" matches "samsung"'
    );

    const typoCorrectionResult = findTypoCorrections('iphnoe 15');
    assert(
      typoCorrectionResult.hasCorrection && typoCorrectionResult.correctedQuery.includes('iphone'),
      'findTypoCorrections recovers "iphnoe 15" -> "iphone 15"'
    );

    const tokensWithAliases = getSearchTokensWithAliases('iphnoe');
    assert(
      tokensWithAliases.includes('iphone') &&
      (tokensWithAliases.includes('ايفون') || tokensWithAliases.includes('apple')),
      'getSearchTokensWithAliases expands typo "iphnoe" into "iphone" + Arabic "ايفون"'
    );

    // ── 3. Visual Search Security & Preprocessing ─────────────────────────────
    console.log('\n--- 3. Visual Image Preprocessing & Security ---');
    // Magic bytes for valid JPEG: FF D8 FF E0
    const fakeJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
    const jpegVal = validateImageBuffer(fakeJpeg);
    assert(jpegVal.isValid === true && jpegVal.format === 'jpeg', 'Validates authentic JPEG magic bytes');

    // Magic bytes for valid PNG: 89 50 4E 47 0D 0A 1A 0A
    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
    const pngVal = validateImageBuffer(fakePng);
    assert(pngVal.isValid === true && pngVal.format === 'png', 'Validates authentic PNG magic bytes');

    // Reject malicious/spoofed file (e.g. text or script disguised as image)
    const spoofedFile = Buffer.from('<?php echo "evil"; ?>');
    const spoofVal = validateImageBuffer(spoofedFile);
    assert(spoofVal.isValid === false, 'Rejects spoofed non-image payload');

    // Reject oversized buffer
    const oversizedVal = validateImageBuffer(fakeJpeg, 5); // max 5 bytes
    assert(oversizedVal.isValid === false, 'Enforces maximum upload size limit');

    // Test real visual feature extraction on 100x100 synthetic buffer
    const sharp = require('sharp');
    const testImageBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 220, g: 30, b: 30 }, // Red image
      },
    }).png().toBuffer();

    const features1 = await extractVisualFeatures(testImageBuffer);
    assert(typeof features1.dHash === 'string' && features1.dHash.length === 16, 'Generates 64-bit dHash hex string');
    assert(features1.dominantColor === 'red', 'Accurately classifies dominant red color');

    // Identical image hamming distance = 0
    const features2 = await extractVisualFeatures(testImageBuffer);
    const selfDist = calculateHammingDistance(features1.dHash, features2.dHash);
    assert(selfDist === 0, 'Exact same image yields Hamming distance = 0');

    // ── 4. Full Catalog Search with Weighted Relevance ────────────────────────
    console.log('\n--- 4. Catalog Search with Relevance & Typo Handling ---');
    const catalogSearch = await searchService.search({
      q: 'iphnoe',
      page: 1,
      limit: 10,
    });
    assert(Array.isArray(catalogSearch.products), 'Executes typo-tolerant catalog query');
    assert(typeof catalogSearch.total === 'number', 'Returns authoritative total count');

    // ── 5. Search Suggestions & Autocomplete ──────────────────────────────────
    console.log('\n--- 5. Autocomplete Suggestions ---');
    const suggestions = await searchService.getSuggestions('سام');
    assert(Array.isArray(suggestions) && suggestions.length > 0, 'Returns brand/category/product suggestions');

    // ── 6. Visual Search Provider Execution ───────────────────────────────────
    console.log('\n--- 6. Visual Search Provider Execution ---');
    const visualResult = await visualSearchService.executeVisualSearch(undefined, {
      textQuery: 'هاتف ذكي',
      limit: 6,
    });
    assert(visualResult.queryId.startsWith('vs_'), 'Assigns unique audit queryId');
    assert(Array.isArray(visualResult.products), 'Returns formatted products list');
    assert(Array.isArray(visualResult.similarProducts), 'Separates similar products');
    assert(typeof visualResult.metadata === 'object', 'Includes visual search match metadata');

    // ── 7. Visual Index Status & Diagnostics ──────────────────────────────────
    console.log('\n--- 7. Indexing Status & Diagnostics ---');
    const indexStatus = visualSearchService.getIndexingStatus();
    assert(typeof indexStatus.indexedImagesCount === 'number', 'Reports indexed images count');
    assert(typeof indexStatus.isIndexing === 'boolean', 'Reports current indexing activity state');

    console.log(`\n======================================================`);
    console.log(`Smart Search Suite Complete: ${passed} passed, ${failed} failed`);
    console.log(`======================================================\n`);

    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  }
}

runSearchTests();
