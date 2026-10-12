/**
 * SOUQNAA Marketplace — Production-Grade Tax Rule Resolver
 * Deterministic, priority-based resolution of applicable tax rules and exemptions.
 */

import { prisma } from '../../database/prisma';
import { TaxRule, TaxExemption, TaxTargetType, TaxExemptionEntityType } from '@prisma/client';

export interface ResolutionContext {
  productId: string;
  categoryId?: string | null;
  sellerId: string;
  customerId?: string | null;
  asOfDate?: Date;
}

export interface ResolvedTaxRuleResult {
  rule: TaxRule | null;
  isExempt: boolean;
  exemptionReason: string | null;
  resolutionSource: 'PRODUCT' | 'CATEGORY' | 'SELLER' | 'DEFAULT' | 'EXEMPTION' | 'NONE';
}

export class TaxRuleResolver {
  // In-memory cache of active rules and exemptions for ultra-low latency checkout
  private static cachedRules: TaxRule[] | null = null;
  private static cachedExemptions: TaxExemption[] | null = null;
  private static cacheExpiresAt: number = 0;
  private static readonly CACHE_TTL_MS = 60 * 1000; // 1 minute TTL with proactive invalidation

  /**
   * Invalidate the in-memory tax cache upon any admin rule or exemption mutation
   */
  public static invalidateCache(): void {
    this.cachedRules = null;
    this.cachedExemptions = null;
    this.cacheExpiresAt = 0;
  }

  /**
   * Load active rules with caching
   */
  private static async getActiveRules(): Promise<TaxRule[]> {
    const now = Date.now();
    if (this.cachedRules && this.cacheExpiresAt > now) {
      return this.cachedRules;
    }

    const rules = await prisma.taxRule.findMany({
      where: {
        active: true,
        isArchived: false,
      },
      orderBy: [
        { priority: 'asc' },
        { effectiveFrom: 'desc' },
      ],
    });

    this.cachedRules = rules;
    this.cacheExpiresAt = now + this.CACHE_TTL_MS;
    return rules;
  }

  /**
   * Load active exemptions with caching
   */
  private static async getActiveExemptions(): Promise<TaxExemption[]> {
    const now = Date.now();
    if (this.cachedExemptions && this.cacheExpiresAt > now) {
      return this.cachedExemptions;
    }

    const exemptions = await prisma.taxExemption.findMany({
      where: { active: true },
    });

    this.cachedExemptions = exemptions;
    return exemptions;
  }

  /**
   * Check if an entity is currently exempt
   */
  private static isEntityExempt(
    exemption: TaxExemption,
    asOfDate: Date
  ): boolean {
    if (!exemption.active) return false;
    if (exemption.validFrom && asOfDate < exemption.validFrom) return false;
    if (exemption.validUntil && asOfDate > exemption.validUntil) return false;
    return true;
  }

  /**
   * Check if a rule is valid for a given date
   */
  private static isRuleEffective(rule: TaxRule, asOfDate: Date): boolean {
    if (!rule.active || rule.isArchived) return false;
    if (rule.effectiveFrom && asOfDate < rule.effectiveFrom) return false;
    if (rule.effectiveUntil && asOfDate > rule.effectiveUntil) return false;
    return true;
  }

  /**
   * Deterministically resolve the tax rule and exemption status for an order item
   */
  public static async resolve(context: ResolutionContext): Promise<ResolvedTaxRuleResult> {
    const asOf = context.asOfDate || new Date();
    const [rules, exemptions] = await Promise.all([
      this.getActiveRules(),
      this.getActiveExemptions(),
    ]);

    // 1. Check Exemptions first (product -> category -> seller -> customer)
    // A valid exemption strictly overrides normal taxation (Section 4)
    for (const ex of exemptions) {
      if (!this.isEntityExempt(ex, asOf)) continue;

      if (ex.entityType === TaxExemptionEntityType.PRODUCT && ex.entityId === context.productId) {
        return {
          rule: null,
          isExempt: true,
          exemptionReason: `إعفاء ضريبي للمنتج: ${ex.reason}`,
          resolutionSource: 'EXEMPTION',
        };
      }
      if (
        ex.entityType === TaxExemptionEntityType.CATEGORY &&
        context.categoryId &&
        ex.entityId === context.categoryId
      ) {
        return {
          rule: null,
          isExempt: true,
          exemptionReason: `إعفاء ضريبي للقسم: ${ex.reason}`,
          resolutionSource: 'EXEMPTION',
        };
      }
      if (ex.entityType === TaxExemptionEntityType.SELLER && ex.entityId === context.sellerId) {
        return {
          rule: null,
          isExempt: true,
          exemptionReason: `إعفاء ضريبي للمتجر/البائع: ${ex.reason}`,
          resolutionSource: 'EXEMPTION',
        };
      }
      if (
        ex.entityType === TaxExemptionEntityType.CUSTOMER &&
        context.customerId &&
        ex.entityId === context.customerId
      ) {
        return {
          rule: null,
          isExempt: true,
          exemptionReason: `إعفاء ضريبي لحساب العميل: ${ex.reason}`,
          resolutionSource: 'EXEMPTION',
        };
      }
    }

    // Filter effective rules
    const effectiveRules = rules.filter((r) => this.isRuleEffective(r, asOf));

    // Helper for sorting candidates deterministically
    const sortCandidates = (candidates: TaxRule[]): TaxRule[] => {
      return candidates.sort((a, b) => {
        // 1. Explicit priority (lower number wins)
        if (a.priority !== b.priority) return a.priority - b.priority;
        // 2. Effective date (more recent effectiveFrom wins)
        const aDate = a.effectiveFrom ? a.effectiveFrom.getTime() : 0;
        const bDate = b.effectiveFrom ? b.effectiveFrom.getTime() : 0;
        if (aDate !== bDate) return bDate - aDate;
        // 3. Higher version wins
        return b.version - a.version;
      });
    };

    // 2. Specificity Level 1: Product-specific rule
    const productRules = effectiveRules.filter(
      (r) => r.targetType === TaxTargetType.PRODUCT && r.targetId === context.productId
    );
    if (productRules.length > 0) {
      return {
        rule: sortCandidates(productRules)[0],
        isExempt: false,
        exemptionReason: null,
        resolutionSource: 'PRODUCT',
      };
    }

    // 3. Specificity Level 2: Category-specific rule
    if (context.categoryId) {
      const categoryRules = effectiveRules.filter(
        (r) => r.targetType === TaxTargetType.CATEGORY && r.targetId === context.categoryId
      );
      if (categoryRules.length > 0) {
        return {
          rule: sortCandidates(categoryRules)[0],
          isExempt: false,
          exemptionReason: null,
          resolutionSource: 'CATEGORY',
        };
      }
    }

    // 4. Specificity Level 3: Seller-specific rule
    const sellerRules = effectiveRules.filter(
      (r) => r.targetType === TaxTargetType.SELLER && r.targetId === context.sellerId
    );
    if (sellerRules.length > 0) {
      return {
        rule: sortCandidates(sellerRules)[0],
        isExempt: false,
        exemptionReason: null,
        resolutionSource: 'SELLER',
      };
    }

    // 5. Specificity Level 4: Default SOUQNAA rule
    const defaultRules = effectiveRules.filter((r) => r.targetType === TaxTargetType.DEFAULT);
    if (defaultRules.length > 0) {
      return {
        rule: sortCandidates(defaultRules)[0],
        isExempt: false,
        exemptionReason: null,
        resolutionSource: 'DEFAULT',
      };
    }

    // 6. Fallback: No applicable tax
    return {
      rule: null,
      isExempt: false,
      exemptionReason: null,
      resolutionSource: 'NONE',
    };
  }
}
