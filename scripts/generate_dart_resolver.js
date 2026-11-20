const fs = require('fs');
const path = require('path');

const seedCategoriesFile = path.join(__dirname, '../src/database/seed_categories.ts');
const dartFile = path.join(__dirname, '../../packages/design_system/lib/src/components/icons/category_icon_resolver.dart');

const seedContent = fs.readFileSync(seedCategoriesFile, 'utf8');

// Parse catalogCategories from seed_categories.ts
const match = seedContent.match(/export const catalogCategories: RootCategoryData\[\] = (\[[\s\S]*?\]);\s*export async function/);
if (!match) {
  console.error('Failed to parse catalogCategories');
  process.exit(1);
}

const categories = JSON.parse(match[1]);

// Map of icon keys to Icons.* in Flutter
const iconMap = new Map();
const slugMap = new Map();

for (const cat of categories) {
  iconMap.set(cat.icon, `Icons.${cat.icon}`);
  if (cat.icon.endsWith('_rounded')) {
    const base = cat.icon.replace('_rounded', '');
    iconMap.set(base, `Icons.${cat.icon}`);
  }
  slugMap.set(cat.slug, `Icons.${cat.icon}`);

  for (const sub of cat.subcategories) {
    iconMap.set(sub.icon, `Icons.${sub.icon}`);
    if (sub.icon.endsWith('_rounded')) {
      const base = sub.icon.replace('_rounded', '');
      iconMap.set(base, `Icons.${sub.icon}`);
    }
    slugMap.set(sub.slug, `Icons.${sub.icon}`);
  }
}

// Ensure common legacy/fallback aliases
slugMap.set('home-kitchen', 'Icons.chair_rounded');
slugMap.set('tools-hardware-construction', 'Icons.build_rounded');
slugMap.set('solar-energy-supplies', 'Icons.solar_power_rounded');
slugMap.set('traditional-attire-heritage', 'Icons.checkroom_rounded');
slugMap.set('tvs-monitors', 'Icons.tv_rounded');
slugMap.set('audio-headphones', 'Icons.headphones_rounded');
slugMap.set('jewelry', 'Icons.diamond_rounded');
slugMap.set('diapers-baby-care', 'Icons.baby_changing_station_rounded');
slugMap.set('building-materials', 'Icons.foundation_rounded');
slugMap.set('electrical-supplies', 'Icons.electrical_services_rounded');
slugMap.set('tv-monitor-spare-parts', 'Icons.hardware_rounded');
slugMap.set('hard-drives-hdd-ssd', 'Icons.storage_rounded');
slugMap.set('engines-batteries', 'Icons.engineering_rounded');
slugMap.set('football-team-sports', 'Icons.sports_soccer_rounded');
slugMap.set('door-installation-supplies', 'Icons.door_front_door_rounded');
slugMap.set('janabiya-sheaths', 'Icons.military_tech_rounded');
slugMap.set('janabiya-accessories', 'Icons.view_headline_rounded');
slugMap.set('yemeni-traditional-belts', 'Icons.view_headline_rounded');
slugMap.set('networking-routers', 'Icons.router_rounded');
slugMap.set('medical-equipment', 'Icons.monitor_heart_rounded');
slugMap.set('baby-health', 'Icons.health_and_safety_rounded');
slugMap.set('yemeni-traditional-attire', 'Icons.checkroom_rounded');
slugMap.set('folk-costume-supplies', 'Icons.checkroom_rounded');
slugMap.set('poultry-livestock-supplies', 'Icons.pets_rounded');
slugMap.set('traditional-products', 'Icons.workspace_premium_rounded');

// Generate Dart file
const iconEntries = [...iconMap.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([k, v]) => `    '${k}': ${v},`)
  .join('\n');

const slugEntries = [...slugMap.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([k, v]) => `    '${k}': ${v},`)
  .join('\n');

const dartSource = `import 'package:flutter/material.dart';

/// Centralized icon resolver for all catalog categories & subcategories in Souqnaa.
/// Matches either the backend \`icon\` string, the \`slug\`, or falls back safely.
class CategoryIconResolver {
  const CategoryIconResolver._();

  /// Resolve IconData from icon name, category slug, or category name.
  static IconData resolve({
    String? icon,
    String? slug,
    String? categoryName,
    IconData fallback = Icons.category_rounded,
  }) {
    if (icon != null && icon.trim().isNotEmpty) {
      final resolved = _iconMap[icon.trim().toLowerCase()];
      if (resolved != null) return resolved;
    }

    if (slug != null && slug.trim().isNotEmpty) {
      final resolved = _slugMap[slug.trim().toLowerCase()];
      if (resolved != null) return resolved;
    }

    if (categoryName != null && categoryName.trim().isNotEmpty) {
      final resolved = _slugMap[categoryName.trim().toLowerCase()];
      if (resolved != null) return resolved;
    }

    return fallback;
  }

  // ── Mapping by Icon Name Key ──────────────────────────────────────────
  static final Map<String, IconData> _iconMap = {
${iconEntries}
  };

  // ── Mapping by Category / Subcategory Slug ────────────────────────────
  static final Map<String, IconData> _slugMap = {
${slugEntries}
  };
}
`;

fs.writeFileSync(dartFile, dartSource, 'utf8');
console.log(`✅ Generated CategoryIconResolver with ${iconMap.size} icon mappings and ${slugMap.size} slug mappings.`);
