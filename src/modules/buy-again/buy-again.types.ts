export interface BuyAgainItemVariantSummary {
  id: string;
  nameAr: string;
  nameEn: string;
  price: number;
  stockQuantity: number;
  sku?: string | null;
}

export interface BuyAgainItem {
  productId: string;
  variantId: string | null;
  variantNameAr: string | null;
  variantNameEn: string | null;
  sellerId: string;
  storeId: string;
  storeName: string;
  storeLogo: string | null;
  storeIsActive: boolean;
  storeIsOpen: boolean;
  productNameAr: string;
  productNameEn: string;
  productSlug: string;
  productImage: string | null;
  categoryId: string;
  lastPurchasedAt: string;
  purchaseCount: number;
  lastQuantity: number;
  lastOrderId: string;
  lastOrderNumber: string;
  historicalPrice: number; // Informational display only
  currentPrice: number;    // Authoritative backend price
  compareAtPrice: number | null;
  currency: string;
  availableStock: number;
  isAvailable: boolean;
  unavailabilityReason: string | null;
  hasMultipleVariants: boolean;
  isExactVariantAvailable: boolean;
  priceChanged: boolean;
  priceDifference: number;
  variants: BuyAgainItemVariantSummary[];
}

export interface BuyAgainQueryOptions {
  page?: number;
  limit?: number;
  sortBy?: 'recent' | 'frequent';
  search?: string;
}

export interface BuyAgainResponse {
  items: BuyAgainItem[];
  totalCount: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
  summary: {
    totalPurchasedProducts: number;
    availableForReorder: number;
    frequentlyPurchasedCount: number;
  };
}

export interface ReorderItemInput {
  productId: string;
  variantId?: string | null;
  quantity?: number;
}

export interface ReorderOrderResult {
  orderId: string;
  totalItems: number;
  addedItemsCount: number;
  skippedItemsCount: number;
  results: Array<{
    productId: string;
    variantId: string | null;
    productName: string;
    status: 'ADDED' | 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'VARIANT_UNAVAILABLE';
    quantity: number;
    unitPrice?: number;
    reason?: string;
  }>;
}

export interface BuyAgainAdminMetrics {
  totalEligibleCustomers: number;
  totalUniqueReorderProducts: number;
  reorderConversionRate: number;
  topReorderedProducts: Array<{
    productId: string;
    productNameAr: string;
    productNameEn: string;
    reorderCount: number;
    currentPrice: number;
  }>;
}
