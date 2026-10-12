import { CampaignTargetingRule } from '@prisma/client';

export interface CustomerEvaluationContext {
  userId?: string | null;
  isGuest: boolean;
  orderCount?: number;
  cartValue?: number;
  country?: string | null;
  city?: string | null;
  language?: string | null; // "ar", "en"
  platform?: string | null; // "ANDROID", "IOS", "WEB", "TABLET", "DESKTOP"
  purchasedCategories?: string[];
  purchasedSellers?: string[];
  wishlistProductIds?: string[];
  segments?: string[];
  membershipTier?: string | null;
  membershipTierLevel?: number | null;
}

class TargetingService {
  /**
   * Resolves basic audience segments for a customer context.
   */
  resolveDefaultSegments(context: CustomerEvaluationContext): string[] {
    const segments: string[] = ['ALL_USERS'];

    if (context.isGuest || !context.userId) {
      segments.push('GUESTS');
    } else {
      segments.push('REGISTERED_USERS');

      const count = context.orderCount ?? 0;
      if (count === 0) {
        segments.push('NEW_CUSTOMERS');
        segments.push('FIRST_ORDER_ELIGIBLE');
      } else {
        segments.push('RETURNING_CUSTOMERS');
        if (count >= 5 || (context.cartValue && context.cartValue > 50000)) {
          segments.push('HIGH_VALUE_CUSTOMERS');
        }
      }

      if (context.wishlistProductIds && context.wishlistProductIds.length > 0) {
        segments.push('WISHLIST_USERS');
      }

      if (context.cartValue && context.cartValue > 0) {
        segments.push('CART_ABANDONERS');
      }

      if (context.membershipTier) {
        segments.push(`MEMBERSHIP_${context.membershipTier.toUpperCase()}`);
        if (['VIP', 'VIP_PLUS', 'PREMIUM'].includes(context.membershipTier.toUpperCase())) {
          segments.push('VIP_MEMBERS');
        }
      }
    }

    return segments;
  }

  /**
   * Evaluates a single targeting rule against customer context.
   */
  evaluateSingleRule(rule: CampaignTargetingRule, context: CustomerEvaluationContext): boolean {
    const { ruleType, operator, value } = rule;
    let targetValue: any;
    try {
      targetValue = JSON.parse(value);
    } catch {
      targetValue = value;
    }

    switch (ruleType) {
      case 'CUSTOMER_SEGMENT': {
        const segments = context.segments || this.resolveDefaultSegments(context);
        if (Array.isArray(targetValue)) {
          return targetValue.some((s) => segments.includes(s));
        }
        return segments.includes(String(targetValue));
      }

      case 'LANGUAGE': {
        const currentLang = (context.language || 'ar').toLowerCase();
        const expected = String(targetValue).toLowerCase();
        if (operator === 'EQUALS') return currentLang === expected;
        if (operator === 'IN' && Array.isArray(targetValue)) {
          return targetValue.map((v) => String(v).toLowerCase()).includes(currentLang);
        }
        return currentLang === expected;
      }

      case 'PLATFORM':
      case 'DEVICE_PLATFORM': {
        const currentPlatform = (context.platform || 'MOBILE').toUpperCase();
        if (Array.isArray(targetValue)) {
          return targetValue.map((p) => String(p).toUpperCase()).includes(currentPlatform);
        }
        const expected = String(targetValue).toUpperCase();
        if (operator === 'EQUALS') return currentPlatform === expected;
        if (operator === 'NOT_EQUALS') return currentPlatform !== expected;
        return currentPlatform === expected;
      }

      case 'GEO_COUNTRY': {
        const currentCountry = (context.country || 'YE').toUpperCase();
        const expected = String(targetValue).toUpperCase();
        if (operator === 'EQUALS') return currentCountry === expected;
        if (operator === 'IN' && Array.isArray(targetValue)) {
          return targetValue.map((c) => String(c).toUpperCase()).includes(currentCountry);
        }
        return currentCountry === expected;
      }

      case 'GEO_CITY': {
        const currentCity = (context.city || '').toLowerCase();
        if (!currentCity) return false;
        if (Array.isArray(targetValue)) {
          return targetValue.map((c) => String(c).toLowerCase()).includes(currentCity);
        }
        const expected = String(targetValue).toLowerCase();
        return currentCity.includes(expected);
      }

      case 'CART_VALUE': {
        const currentCart = context.cartValue ?? 0;
        const numVal = Number(targetValue);
        if (operator === 'GREATER_THAN') return currentCart > numVal;
        if (operator === 'LESS_THAN') return currentCart < numVal;
        if (operator === 'EQUALS') return currentCart === numVal;
        return currentCart >= numVal;
      }

      case 'ORDER_COUNT': {
        const count = context.orderCount ?? 0;
        const numVal = Number(targetValue);
        if (operator === 'GREATER_THAN') return count > numVal;
        if (operator === 'LESS_THAN') return count < numVal;
        if (operator === 'EQUALS') return count === numVal;
        return count >= numVal;
      }

      case 'MEMBERSHIP_TIER': {
        const currentTier = (context.membershipTier || 'REGULAR').toUpperCase();
        if (Array.isArray(targetValue)) {
          return targetValue.map((t) => String(t).toUpperCase()).includes(currentTier);
        }
        const expected = String(targetValue).toUpperCase();
        if (operator === 'EQUALS') return currentTier === expected;
        if (operator === 'NOT_EQUALS') return currentTier !== expected;
        return currentTier === expected;
      }

      case 'MINIMUM_MEMBERSHIP_LEVEL': {
        const currentLevel = context.membershipTierLevel ?? 0;
        const requiredLevel = Number(targetValue);
        if (operator === 'GREATER_THAN') return currentLevel > requiredLevel;
        if (operator === 'EQUALS') return currentLevel === requiredLevel;
        return currentLevel >= requiredLevel;
      }

      default:
        // Unknown rule, permissive pass
        return true;
    }
  }

  /**
   * Evaluates all targeting rules for a banner or campaign.
   * Supports ALL (AND), ANY (OR), and NONE (NOT) grouping.
   */
  isEligible(rules: CampaignTargetingRule[], context: CustomerEvaluationContext): boolean {
    if (!rules || rules.length === 0) return true;

    // Group by ruleGroup
    const allRules = rules.filter((r) => r.ruleGroup === 'ALL');
    const anyRules = rules.filter((r) => r.ruleGroup === 'ANY');
    const noneRules = rules.filter((r) => r.ruleGroup === 'NONE');

    // ALL: must pass every rule
    for (const r of allRules) {
      if (!this.evaluateSingleRule(r, context)) {
        return false;
      }
    }

    // ANY: must pass at least one rule (if any exist)
    if (anyRules.length > 0) {
      const anyPassed = anyRules.some((r) => this.evaluateSingleRule(r, context));
      if (!anyPassed) return false;
    }

    // NONE: must NOT pass any of these rules
    for (const r of noneRules) {
      if (this.evaluateSingleRule(r, context)) {
        return false;
      }
    }

    return true;
  }
}

export const targetingService = new TargetingService();
