import { ScoredCandidate, RecommendationContext } from '../types/recommendation.types';
import { recommendationConfigManager } from '../config/recommendation.config';

export class DiversityRerankerService {
  /**
   * Stage 3: Business Constraints, Diversity Enforcement, Deduplication & Exploration Insertion
   */
  rerankAndDiversify(
    rankedList: ScoredCandidate[],
    context: RecommendationContext,
    targetCount = 20,
    excludedProductIds?: Set<string>
  ): ScoredCandidate[] {
    const config = recommendationConfigManager.getConfig();
    const maxConsecutiveSeller = config.diversity.maxConsecutiveSameSeller;
    const maxPerSellerTotal = config.diversity.maxPerSellerTotal;
    const maxConsecutiveCategory = config.diversity.maxConsecutiveSameCategory;
    const explorationRatio = recommendationConfigManager.getFlag('exploration.enabled') ? config.explorationRatio : 0;

    // Filter by business constraints & availability
    const validCandidates = rankedList.filter((c) => {
      const p = c.product;
      if (!p || !p.isActive || p.isSuspended) return false;
      if ((p.inventory?.quantity ?? 0) <= 0) return false;
      if (excludedProductIds && excludedProductIds.has(p.id)) return false;
      if (p.store && !p.store.isActive) return false;
      return true;
    });

    if (validCandidates.length === 0) return [];

    // Separate exploitation vs exploration candidates
    // Exploration items: fresh products or products from sellers the user hasn't interacted with yet
    const exploitationPool: ScoredCandidate[] = [];
    const explorationPool: ScoredCandidate[] = [];

    for (const item of validCandidates) {
      if (item.freshnessScore > 0.6 || item.candidateSources.includes('NEW_ARRIVALS')) {
        explorationPool.push({ ...item, isExploration: true });
      } else {
        exploitationPool.push(item);
      }
    }

    const targetExplorationCount = Math.floor(targetCount * explorationRatio);
    const targetExploitationCount = targetCount - targetExplorationCount;

    const selected: ScoredCandidate[] = [];
    const seenProductIds = new Set<string>();
    const sellerCountMap = new Map<string, number>();

    let lastSellerId: string | null = null;
    let consecutiveSellerCount = 0;
    let lastCategoryId: string | null = null;
    let consecutiveCategoryCount = 0;

    const canAddCandidate = (cand: ScoredCandidate): boolean => {
      if (seenProductIds.has(cand.productId)) return false;

      const sellerId = cand.product.store?.sellerId || cand.product.storeId || cand.product.store?.id || 'unknown';
      const categoryId = cand.product.categoryId;

      // Max per seller check
      const currentSellerTotal = sellerCountMap.get(sellerId) || 0;
      if (currentSellerTotal >= maxPerSellerTotal) return false;

      // Consecutive seller check
      if (lastSellerId === sellerId && consecutiveSellerCount >= maxConsecutiveSeller) {
        return false;
      }

      // Consecutive category check
      if (lastCategoryId === categoryId && consecutiveCategoryCount >= maxConsecutiveCategory) {
        return false;
      }

      return true;
    };

    const addCandidateToSelection = (cand: ScoredCandidate) => {
      selected.push(cand);
      seenProductIds.add(cand.productId);

      const sellerId = cand.product.store?.sellerId || cand.product.storeId || cand.product.store?.id || 'unknown';
      sellerCountMap.set(sellerId, (sellerCountMap.get(sellerId) || 0) + 1);

      if (lastSellerId === sellerId) {
        consecutiveSellerCount++;
      } else {
        lastSellerId = sellerId;
        consecutiveSellerCount = 1;
      }

      if (lastCategoryId === cand.product.categoryId) {
        consecutiveCategoryCount++;
      } else {
        lastCategoryId = cand.product.categoryId;
        consecutiveCategoryCount = 1;
      }
    };

    // 1. Pick exploitation candidates
    for (const cand of exploitationPool) {
      if (selected.length >= targetExploitationCount) break;
      if (canAddCandidate(cand)) {
        addCandidateToSelection(cand);
      }
    }

    // 2. Interleave exploration candidates
    for (const cand of explorationPool) {
      if (selected.length >= targetCount) break;
      if (canAddCandidate(cand)) {
        addCandidateToSelection(cand);
      }
    }

    // 3. If under targetCount due to strict consecutive rules, relax consecutive constraint but strictly respect maxPerSellerTotal
    if (selected.length < targetCount) {
      for (const cand of validCandidates) {
        if (selected.length >= targetCount) break;
        if (!seenProductIds.has(cand.productId)) {
          const sellerId = cand.product.store?.sellerId || cand.product.storeId || cand.product.store?.id || 'unknown';
          if ((sellerCountMap.get(sellerId) || 0) < maxPerSellerTotal) {
            addCandidateToSelection(cand);
          }
        }
      }
    }

    return selected;
  }
}

export const diversityRerankerService = new DiversityRerankerService();
