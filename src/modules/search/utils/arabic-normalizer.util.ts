/**
 * Arabic Text Normalizer, Multilingual Search & Typo Recovery Utility for SOUQNA.
 * 
 * Provides:
 * - Comprehensive Arabic normalization (Alef variants, Teh Marbuta, Alif Maqsura, diacritics, tatweel).
 * - Persian/Urdu character mapping and Arabic-Indic digit conversion (٠-٩ -> 0-9).
 * - Definite article ('ال') handling and singular/plural morphology expansions.
 * - Multi-lingual cross-language brand & category synonyms (Arabic <-> English).
 * - Damerau-Levenshtein typo correction (handles missing, extra, substituted, and transposed characters).
 * - Dynamic catalog vocabulary integration for typo correction.
 */

// Arabic-Indic and Persian/Urdu digits to Western ASCII digits
const DIGIT_MAP: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

// Common Arabic singular <-> plural pairings
const MORPHOLOGICAL_PAIRS: Record<string, string[]> = {
  'سماعة': ['سماعات', 'headphone', 'earbuds', 'airpods'],
  'سماعات': ['سماعة', 'headphone', 'earbuds', 'airpods'],
  'ساعة': ['ساعات', 'watch', 'smartwatch'],
  'ساعات': ['ساعة', 'watch', 'smartwatch'],
  'عطر': ['عطور', 'perfume', 'fragrance'],
  'عطور': ['عطر', 'perfume', 'fragrance'],
  'حذاء': ['احذية', 'أحذية', 'جزمة', 'shoes', 'sneakers'],
  'احذية': ['حذاء', 'أحذية', 'جزمة', 'shoes', 'sneakers'],
  'شاحن': ['شواحن', 'charger'],
  'شواحن': ['شاحن', 'charger'],
  'كفر': ['كفرات', 'غطاء', 'اغطية', 'case', 'cover'],
  'كفرات': ['كفر', 'غطاء', 'اغطية', 'case', 'cover'],
  'هاتف': ['هواتف', 'جوال', 'جوالات', 'موبايل', 'phone', 'smartphone'],
  'هواتف': ['هاتف', 'جوال', 'جوالات', 'موبايل', 'phone', 'smartphone'],
  'جوال': ['جوالات', 'هاتف', 'هواتف', 'موبايل', 'phone', 'smartphone'],
  'جوالات': ['جوال', 'هاتف', 'هواتف', 'موبايل', 'phone', 'smartphone'],
  'لابتوب': ['لابتوبات', 'حاسوب', 'كمبيوتر', 'laptop', 'notebook'],
  'لابتوبات': ['لابتوب', 'حاسوب', 'كمبيوتر', 'laptop', 'notebook'],
  'شنطة': ['شنط', 'حقيبة', 'حقائب', 'bag', 'backpack'],
  'شنط': ['شنطة', 'حقيبة', 'حقائب', 'bag', 'backpack'],
  'حقيبة': ['حقائب', 'شنطة', 'شنط', 'bag'],
  'حقائب': ['حقيبة', 'شنطة', 'شنط', 'bag'],
  'شاشة': ['شاشات', 'تلفزيون', 'tv', 'monitor'],
  'شاشات': ['شاشة', 'تلفزيون', 'tv', 'monitor'],
  'تلفزيون': ['شاشة', 'شاشات', 'tv'],
  'ملابس': ['ازياء', 'ثياب', 'clothes', 'fashion'],
  'ثياب': ['ملابس', 'ازياء', 'clothes'],
  'نظارة': ['نظارات', 'glasses', 'sunglasses'],
  'نظارات': ['نظارة', 'glasses', 'sunglasses'],
  'كاميرا': ['كاميرات', 'camera'],
  'كاميرات': ['كاميرا', 'camera'],
};

// Bi-directional dictionary of popular search aliases in the marketplace
const SEARCH_ALIASES: Record<string, string[]> = {
  // Brands
  'samsung': ['سامسونج', 'سامسونغ', 'جلاكسي', 'galaxy'],
  'سامسونج': ['samsung', 'سامسونغ', 'جلاكسي', 'galaxy'],
  'سامسونغ': ['samsung', 'سامسونج', 'جلاكسي', 'galaxy'],
  'galaxy': ['سامسونج', 'samsung', 'جلاكسي'],
  'جلاكسي': ['samsung', 'سامسونج', 'galaxy'],

  'apple': ['ابل', 'آبل', 'ايفون', 'آيفون', 'iphone', 'ipad', 'ايباد', 'ماك', 'mac'],
  'ابل': ['apple', 'آبل', 'ايفون', 'آيفون', 'iphone', 'ipad', 'ايباد'],
  'آبل': ['apple', 'ابل', 'ايفون', 'آيفون', 'iphone', 'ipad', 'ايباد'],
  'iphone': ['ايفون', 'apple', 'ابل', 'آيفون'],
  'ايفون': ['iphone', 'apple', 'ابل', 'آيفون'],
  'آيفون': ['iphone', 'apple', 'ابل', 'ايفون'],
  'ipad': ['ايباد', 'apple', 'ابل', 'تابلت'],
  'ايباد': ['ipad', 'apple', 'ابل', 'تابلت'],
  'airpods': ['ايربودز', 'سماعات ابل', 'سماعة ابل', 'apple'],
  'ايربودز': ['airpods', 'سماعات ابل', 'apple'],

  'xiaomi': ['شاومي', 'ريدمي', 'redmi', 'بوكو', 'poco'],
  'شاومي': ['xiaomi', 'ريدمي', 'redmi', 'بوكو', 'poco'],
  'redmi': ['ريدمي', 'شاومي', 'xiaomi'],
  'ريدمي': ['redmi', 'شاومي', 'xiaomi'],

  'huawei': ['هواوي', 'honor', 'هونر'],
  'هواوي': ['huawei', 'honor', 'هونر'],
  'honor': ['هونر', 'هواوي', 'huawei'],
  'هونر': ['honor', 'هواوي', 'huawei'],

  'sony': ['سوني', 'بلايستيشن', 'playstation', 'ps5'],
  'سوني': ['sony', 'بلايستيشن', 'playstation', 'ps5'],
  'playstation': ['بلايستيشن', 'sony', 'سوني', 'ps5', 'ps4'],
  'بلايستيشن': ['playstation', 'sony', 'سوني', 'ps5', 'ps4'],
  'ps5': ['بلايستيشن 5', 'playstation 5', 'sony', 'سوني'],

  'nike': ['نايك', 'نايكي'],
  'نايك': ['nike', 'نايكي'],
  'نايكي': ['nike', 'نايك'],

  'adidas': ['اديداس', 'أديداس'],
  'اديداس': ['adidas', 'أديداس'],
  'أديداس': ['adidas', 'اديداس'],

  'anker': ['انكر', 'أنكر'],
  'انكر': ['anker', 'أنكر'],
  'baseus': ['بيسوس', 'باسوس'],
  'بيسوس': ['baseus', 'باسوس'],

  'lenovo': ['لينوفو', 'لينوفوا'],
  'لينوفو': ['lenovo', 'لينوفوا'],
  'dell': ['ديل'],
  'ديل': ['dell'],
  'hp': ['اتش بي'],
  'اتش بي': ['hp'],
  'asus': ['اسوس', 'أسوس'],
  'اسوس': ['asus', 'أسوس'],

  // Categories & Keywords
  'phone': ['جوال', 'هاتف', 'موبايل', 'smartphone'],
  'جوال': ['phone', 'هاتف', 'موبايل', 'smartphone'],
  'هاتف': ['phone', 'جوال', 'موبايل'],
  'موبايل': ['phone', 'هاتف', 'جوال'],
  'laptop': ['لابتوب', 'حاسوب', 'كمبيوتر', 'computer'],
  'لابتوب': ['laptop', 'حاسوب', 'كمبيوتر', 'computer'],
  'كمبيوتر': ['computer', 'laptop', 'لابتوب', 'حاسوب'],
  'watch': ['ساعة', 'ساعات', 'smartwatch'],
  'ساعة': ['watch', 'ساعات', 'smartwatch'],
  'ساعات': ['watch', 'ساعة', 'smartwatch'],
  'perfume': ['عطر', 'عطور', 'بخور'],
  'عطر': ['perfume', 'عطور', 'fragrance'],
  'عطور': ['perfume', 'عطر', 'fragrance'],
  'shoes': ['حذاء', 'احذية', 'جزمة', 'سنيكرز'],
  'حذاء': ['shoes', 'احذية', 'جزمة', 'sneakers'],
  'احذية': ['shoes', 'حذاء', 'جزمة', 'sneakers'],
  'clothes': ['ملابس', 'ازياء', 'ثياب'],
  'ملابس': ['clothes', 'ازياء', 'ثياب', 'fashion'],
  'tv': ['شاشة', 'تلفزيون', 'smart tv'],
  'شاشة': ['tv', 'تلفزيون', 'television'],
  'تلفزيون': ['tv', 'شاشة', 'television'],
  'headphone': ['سماعة', 'سماعات', 'earbuds', 'airpods'],
  'سماعة': ['headphone', 'سماعات', 'earbuds', 'airpods'],
  'سماعات': ['headphone', 'سماعة', 'earbuds', 'airpods'],
  'charger': ['شاحن', 'شواحن'],
  'شاحن': ['charger', 'شواحن'],
  'شواحن': ['charger', 'شاحن'],
};

// Primary canonical dictionary vocabulary for typo correction
export const CANONICAL_VOCABULARY = Array.from(new Set([
  ...Object.keys(SEARCH_ALIASES),
  ...Object.values(SEARCH_ALIASES).flat(),
  ...Object.keys(MORPHOLOGICAL_PAIRS),
  ...Object.values(MORPHOLOGICAL_PAIRS).flat(),
]));

/**
 * Converts Arabic-Indic and Persian digits to Western ASCII digits.
 * e.g. "ايفون ١٥" -> "ايفون 15"
 */
export function toWesternDigits(text: string): string {
  if (!text) return '';
  return text.replace(/[٠-٩۰-۹]/g, ch => DIGIT_MAP[ch] || ch);
}

/**
 * Normalizes an Arabic or multilingual string:
 * - Converts Arabic-Indic and Persian digits to standard Western digits (٠-٩ -> 0-9)
 * - Strips Tashkeel (harakat / diacritics)
 * - Strips Tatweel (Kashida)
 * - Unifies Alef variations (أ, إ, آ, ٱ) -> ا
 * - Unifies Teh Marbuta (ة) -> ه
 * - Unifies Alif Maqsura (ى) -> ي
 * - Unifies Hamza forms (ء, ئ, ؤ) where appropriate
 * - Maps Persian/Urdu variants (ی -> ي, ک -> ك, ۀ -> ه, etc.)
 * - Cleans repeated elongated characters (e.g. "ايييفون" -> "ايفون")
 * - Lowercases Latin characters
 * - Cleans excessive whitespace
 */
export function normalizeArabic(text: string | null | undefined): string {
  if (!text) return '';

  let normalized = toWesternDigits(String(text))
    // Strip diacritics (fathah, dammah, kasrah, sukun, shaddah, tanween, dagger alif, etc.)
    .replace(/[\u064B-\u0652\u0670]/g, '')
    // Strip Tatweel (Kashida)
    .replace(/\u0640/g, '')
    // Normalize Alef variants
    .replace(/[أإآٱ]/g, 'ا')
    // Normalize Teh Marbuta to Heh
    .replace(/ة/g, 'ه')
    // Normalize Alif Maqsura to Yaa
    .replace(/ى/g, 'ي')
    // Normalize Persian/Urdu variants
    .replace(/ی/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/ۀ/g, 'ه')
    .replace(/گ/g, 'ك')
    .replace(/پ/g, 'ب')
    .replace(/چ/g, 'ج')
    .replace(/ژ/g, 'ز')
    .replace(/[ئ]/g, 'ي')
    // Lowercase English
    .toLowerCase()
    // Collapse repeated identical characters if repeated 3+ times (e.g. "اييييفون" -> "ايفون", "سمااااعة" -> "سماعة")
    .replace(/(.)\1{2,}/g, '$1')
    // Replace punctuation and dashes with spaces for clean tokenization
    .replace(/[_,/\\#+!?:;()\[\]{}'"`~*]/g, ' ')
    // Replace multiple spaces with a single space
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

/**
 * Strips Arabic definite article prefix 'ال' from a word if it leaves a meaningful stem (>= 3 chars).
 * e.g. "السماعة" -> "سماعة", "الشاحن" -> "شاحن"
 */
export function stripArabicPrefix(word: string): string {
  if (!word) return '';
  if (word.startsWith('ال') && word.length >= 5) {
    return word.substring(2);
  }
  return word;
}

/**
 * Damerau-Levenshtein distance calculation.
 * Supports:
 * - Insertions
 * - Deletions
 * - Substitutions
 * - Transpositions of adjacent characters (e.g. 'iphnoe' -> 'iphone' = 1 edit)
 */
export function damerauLevenshteinDistance(source: string, target: string): number {
  const s = source || '';
  const t = target || '';
  const sLen = s.length;
  const tLen = t.length;

  if (sLen === 0) return tLen;
  if (tLen === 0) return sLen;
  if (s === t) return 0;

  const d: number[][] = Array.from({ length: sLen + 1 }, () => new Array(tLen + 1).fill(0));

  for (let i = 0; i <= sLen; i++) d[i][0] = i;
  for (let j = 0; j <= tLen; j++) d[0][j] = j;

  for (let i = 1; i <= sLen; i++) {
    for (let j = 1; j <= tLen; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;

      d[i][j] = Math.min(
        d[i - 1][j] + 1,      // deletion
        d[i][j - 1] + 1,      // insertion
        d[i - 1][j - 1] + cost // substitution
      );

      // Check adjacent transposition
      if (
        i > 1 &&
        j > 1 &&
        s[i - 1] === t[j - 2] &&
        s[i - 2] === t[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[sLen][tLen];
}

/**
 * Standard Levenshtein distance for backward compatibility.
 */
export function levenshteinDistance(a: string, b: string): number {
  return damerauLevenshteinDistance(a, b);
}

/**
 * Checks if query token is a close typo match to a candidate token.
 * Uses length-scaled dynamic distance threshold:
 * - Length 3-4: max distance 1
 * - Length 5-7: max distance 2 (e.g. "iphnoe" -> "iphone")
 * - Length 8+: max distance 2 or 3
 */
export function isTypoMatch(query: string, candidate: string): boolean {
  const q = normalizeArabic(query);
  const c = normalizeArabic(candidate);

  if (!q || !c) return false;
  if (q === c) return true;
  if (c.includes(q) || q.includes(c)) return true;

  const minLen = Math.min(q.length, c.length);
  if (minLen < 3) return false;

  const maxDist = minLen <= 4 ? 1 : (minLen <= 7 ? 2 : 3);
  return damerauLevenshteinDistance(q, c) <= maxDist;
}

/**
 * Evaluates a query against a dictionary to recover from typos.
 * Returns suggested corrections and corrected query string.
 */
export function findTypoCorrections(
  rawQuery: string,
  extraVocabulary: string[] = []
): {
  correctedQuery: string;
  originalQuery: string;
  hasCorrection: boolean;
  suggestions: string[];
} {
  const normalized = normalizeArabic(rawQuery);
  if (!normalized) {
    return { correctedQuery: '', originalQuery: rawQuery, hasCorrection: false, suggestions: [] };
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const vocab = Array.from(new Set([...CANONICAL_VOCABULARY, ...extraVocabulary.map(v => normalizeArabic(v))]));

  let hasCorrection = false;
  const correctedTokens: string[] = [];
  const suggestionSet = new Set<string>();

  for (const token of tokens) {
    // Digits and short words (<= 2 chars) don't need typo correction
    if (/^\d+$/.test(token) || token.length <= 2) {
      correctedTokens.push(token);
      continue;
    }

    // Direct match in vocabulary
    const directMatch = vocab.find(v => v === token);
    if (directMatch) {
      correctedTokens.push(token);
      continue;
    }

    // Try stripping 'ال' prefix
    const stripped = stripArabicPrefix(token);
    if (stripped !== token) {
      const strippedMatch = vocab.find(v => v === stripped);
      if (strippedMatch) {
        correctedTokens.push(strippedMatch);
        continue;
      }
    }

    // Search for closest candidate in vocabulary with Damerau-Levenshtein
    let bestCandidate: string | null = null;
    let minDistance = Infinity;
    const maxAllowedDist = token.length <= 4 ? 1 : (token.length <= 7 ? 2 : 3);

    for (const word of vocab) {
      if (Math.abs(word.length - token.length) > maxAllowedDist) continue;

      const dist = damerauLevenshteinDistance(token, word);
      if (dist <= maxAllowedDist && dist < minDistance) {
        minDistance = dist;
        bestCandidate = word;
      }
    }

    if (bestCandidate && minDistance <= maxAllowedDist) {
      correctedTokens.push(bestCandidate);
      hasCorrection = true;
      suggestionSet.add(bestCandidate);
    } else {
      correctedTokens.push(token);
    }
  }

  const correctedQuery = correctedTokens.join(' ');
  return {
    correctedQuery,
    originalQuery: rawQuery,
    hasCorrection: hasCorrection && correctedQuery !== normalized,
    suggestions: Array.from(suggestionSet),
  };
}

/**
 * Splits query into normalized tokens, strips prefixes, checks morphological variants,
 * and extracts searchable aliases and typo-corrected expansions.
 */
export function getSearchTokensWithAliases(query: string, extraVocabulary: string[] = []): string[] {
  const normalized = normalizeArabic(query);
  if (!normalized) return [];

  const rawTokens = normalized.split(/\s+/).filter(t => t.length > 0);
  const resultSet = new Set<string>();

  // 1. Add raw normalized query
  resultSet.add(normalized);

  // 2. Add typo-corrected version of whole query
  const typoResult = findTypoCorrections(query, extraVocabulary);
  if (typoResult.hasCorrection) {
    resultSet.add(typoResult.correctedQuery);
  }

  // 3. Process individual tokens
  for (const token of rawTokens) {
    resultSet.add(token);

    // Strip 'ال'
    const stripped = stripArabicPrefix(token);
    if (stripped && stripped !== token) {
      resultSet.add(stripped);
    }

    // Morphological singular/plural pairing
    if (MORPHOLOGICAL_PAIRS[token]) {
      for (const variant of MORPHOLOGICAL_PAIRS[token]) {
        resultSet.add(normalizeArabic(variant));
      }
    }
    if (MORPHOLOGICAL_PAIRS[stripped]) {
      for (const variant of MORPHOLOGICAL_PAIRS[stripped]) {
        resultSet.add(normalizeArabic(variant));
      }
    }

    // Aliases
    if (SEARCH_ALIASES[token]) {
      for (const alias of SEARCH_ALIASES[token]) {
        resultSet.add(normalizeArabic(alias));
      }
    }
    if (SEARCH_ALIASES[stripped]) {
      for (const alias of SEARCH_ALIASES[stripped]) {
        resultSet.add(normalizeArabic(alias));
      }
    }
  }

  // 4. Aliases for full query
  if (SEARCH_ALIASES[normalized]) {
    for (const alias of SEARCH_ALIASES[normalized]) {
      resultSet.add(normalizeArabic(alias));
    }
  }
  if (typoResult.hasCorrection && SEARCH_ALIASES[typoResult.correctedQuery]) {
    for (const alias of SEARCH_ALIASES[typoResult.correctedQuery]) {
      resultSet.add(normalizeArabic(alias));
    }
  }

  return Array.from(resultSet).filter(t => t.length > 0);
}
