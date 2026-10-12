export enum RecommendationType {
  FOR_YOU = 'FOR_YOU',
  TRENDING = 'TRENDING',
  POPULAR = 'POPULAR',
  NEW_ARRIVALS = 'NEW_ARRIVALS',
  SIMILAR_PRODUCTS = 'SIMILAR_PRODUCTS',
  FREQUENTLY_BOUGHT_TOGETHER = 'FREQUENTLY_BOUGHT_TOGETHER',
  RECENTLY_VIEWED = 'RECENTLY_VIEWED',
  BECAUSE_YOU_VIEWED = 'BECAUSE_YOU_VIEWED',
  BECAUSE_YOU_BOUGHT = 'BECAUSE_YOU_BOUGHT',
  BASED_ON_WISHLIST = 'BASED_ON_WISHLIST',
  BASED_ON_CART = 'BASED_ON_CART',
  CATEGORY_RECOMMENDATIONS = 'CATEGORY_RECOMMENDATIONS',
  SELLER_RECOMMENDATIONS = 'SELLER_RECOMMENDATIONS',
  PRICE_DROP_RECOMMENDATIONS = 'PRICE_DROP_RECOMMENDATIONS',
  BACK_IN_STOCK_RECOMMENDATIONS = 'BACK_IN_STOCK_RECOMMENDATIONS',
  CAMPAIGN_RECOMMENDATIONS = 'CAMPAIGN_RECOMMENDATIONS',
  FLASH_SALE_RECOMMENDATIONS = 'FLASH_SALE_RECOMMENDATIONS',
  MEGA_CAMPAIGN_RECOMMENDATIONS = 'MEGA_CAMPAIGN_RECOMMENDATIONS',
  PERSONALIZED_HOME = 'PERSONALIZED_HOME',
}

export enum RecommendationEventType {
  PRODUCT_VIEW = 'PRODUCT_VIEW',
  PRODUCT_CLICK = 'PRODUCT_CLICK',
  SEARCH = 'SEARCH',
  SEARCH_RESULT_CLICK = 'SEARCH_RESULT_CLICK',
  ADD_TO_CART = 'ADD_TO_CART',
  REMOVE_FROM_CART = 'REMOVE_FROM_CART',
  ADD_TO_WISHLIST = 'ADD_TO_WISHLIST',
  REMOVE_FROM_WISHLIST = 'REMOVE_FROM_WISHLIST',
  PURCHASE = 'PURCHASE',
  ORDER_COMPLETED = 'ORDER_COMPLETED',
  PRODUCT_SHARE = 'PRODUCT_SHARE',
  PRODUCT_IMAGE_VIEW = 'PRODUCT_IMAGE_VIEW',
  PRODUCT_REVIEW = 'PRODUCT_REVIEW',
  PRODUCT_RATING = 'PRODUCT_RATING',
  CATEGORY_VIEW = 'CATEGORY_VIEW',
  SELLER_VIEW = 'SELLER_VIEW',
  FOLLOW_SELLER = 'FOLLOW_SELLER',
  UNFOLLOW_SELLER = 'UNFOLLOW_SELLER',
  COUPON_USED = 'COUPON_USED',
  FLASH_SALE_CLICK = 'FLASH_SALE_CLICK',
  CAMPAIGN_CLICK = 'CAMPAIGN_CLICK',
}

export interface RecommendationExplanation {
  reason: string;
  reasonAr: string;
  sourceType: string;
  sourceName?: string;
  sourceNameAr?: string;
}

export interface RecommendationContext {
  userId?: string;
  sessionId: string;
  currentProductId?: string;
  currentCategoryId?: string;
  currentSellerId?: string;
  searchQuery?: string;
  cartProductIds?: string[];
  wishlistProductIds?: string[];
  recentViewedIds?: string[];
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
  dayOfWeek?: number;
  platform?: string;
  appVersion?: string;
  locale?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface CandidateProduct {
  productId: string;
  source: 'PERSONAL_HISTORY' | 'COLLABORATIVE' | 'SIMILAR' | 'POPULAR' | 'TRENDING' | 'CATEGORY' | 'SELLER' | 'FBT' | 'CAMPAIGN' | 'NEW_ARRIVALS' | 'LIGHTFM';
  rawScore: number;
  sourceMetadata?: Record<string, any>;
}

export interface ScoredCandidate {
  productId: string;
  product: any; // Full Prisma Product with relations
  candidateSources: string[];
  personalizationScore: number;
  behaviorSimilarityScore: number;
  popularityScore: number;
  trendingScore: number;
  purchaseAssociationScore: number;
  freshnessScore: number;
  productQualityScore: number;
  sellerQualityScore: number;
  campaignRelevanceScore: number;
  priceRelevanceScore: number;
  finalScore: number;
  isExploration: boolean;
  explanation: RecommendationExplanation;
}

export interface RecommendationSectionDto {
  id: string;
  type: RecommendationType;
  title: string;
  titleAr: string;
  subtitle?: string;
  subtitleAr?: string;
  products: any[];
  items?: Array<{
    product: any;
    score: number;
    explanation?: RecommendationExplanation;
    algorithm?: string;
  }>;
  nextCursor?: string;
  hasMore: boolean;
  algorithm: string;
}

export interface EventIngestionDto {
  userId?: string;
  sessionId: string;
  eventType: RecommendationEventType;
  productId?: string;
  categoryId?: string;
  sellerId?: string;
  searchQuery?: string;
  orderId?: string;
  platform?: string;
  appVersion?: string;
  metadata?: Record<string, any>;
  timestamp?: string;
}

export interface BatchEventIngestionDto {
  events: EventIngestionDto[];
}
