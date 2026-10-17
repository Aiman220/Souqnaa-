/**
 * Utility to format Prisma Product entities into customer/client-ready DTOs.
 * Bridges Prisma schema (which uses nameAr/nameEn, inventory.quantity, and ProductImage relation)
 * with the Flutter ProductModel (which expects name, currency, stock, and string[] images).
 */
export function formatProductForClient(product: any, campaignPresentation?: any): any {
  if (!product) return null;

  // Flatten images to string array of URLs
  let images: string[] = [];
  if (Array.isArray(product.images)) {
    images = product.images
      .map((img: any) => {
        if (typeof img === 'string') return img;
        return img?.url || img?.path || '';
      })
      .filter((url: string) => url.length > 0);
  } else if (product.imageUrl) {
    images = [product.imageUrl];
  }

  // Format variants
  let variants: any[] = [];
  if (Array.isArray(product.variants) && product.variants.length > 0) {
    variants = product.variants.map((v: any) => ({
      ...v,
      id: String(v.id || ''),
      productId: String(v.productId || product.id || ''),
      sku: v.sku || '',
      price: Number(v.price) || Number(product.price) || 0,
      compareAtPrice: v.compareAtPrice != null ? Number(v.compareAtPrice) : null,
      stock: typeof v.stock === 'number' ? v.stock : (typeof v.stockQuantity === 'number' ? v.stockQuantity : 0),
      nameAr: v.nameAr || v.name || v.sku,
      nameEn: v.nameEn || v.name || v.sku,
      image: v.image || v.imageUrl || null,
      attributes: typeof v.attributes === 'object' && v.attributes !== null ? v.attributes : {},
      isActive: v.isActive !== undefined ? Boolean(v.isActive) : true,
    }));
  }

  // Calculate real stock from inventory or variants
  let stock = typeof product.stock === 'number' ? product.stock : null;
  if (stock === null) {
    if (product.inventory && typeof product.inventory.quantity === 'number') {
      stock = Math.max(0, product.inventory.quantity - (product.inventory.reserved || 0));
    } else if (variants.length > 0) {
      stock = variants.reduce((acc: number, v: any) => acc + (v.stock || 0), 0);
    } else {
      stock = 0;
    }
  }

  // Determine sellerId
  const sellerId = product.sellerId || product.store?.sellerId || product.storeId || 'seller-system';

  // Primary name for mobile display
  const name = product.name || product.nameAr || product.nameEn || product.slug || 'منتج';

  // Determine store
  let store = product.store;
  if (store && typeof store === 'object') {
    const productCount = typeof store.productCount === 'number'
      ? store.productCount
      : (typeof store._count?.products === 'number' ? store._count.products : 0);

    store = {
      ...store,
      id: store.id || product.storeId || '',
      sellerId: store.sellerId || product.storeId || store.id || sellerId,
      name: store.name || store.nameAr || 'متجر سوقناا',
      slug: store.slug || store.id || 'souqnaa-store',
      logo: store.logo || store.avatar || null,
      banner: store.banner || store.cover || null,
      rating: typeof store.rating === 'number' ? store.rating : 0,
      reviewCount: typeof store.reviewCount === 'number' ? store.reviewCount : 0,
      productCount,
      isActive: store.isActive !== undefined ? Boolean(store.isActive) : true,
      isVerified: store.isVerified !== undefined ? Boolean(store.isVerified) : false,
      performance: store.performance ?? null,
      createdAt: store.createdAt ? new Date(store.createdAt).toISOString() : new Date().toISOString(),
    };
  }

  // Compute real rating & reviewCount
  let rating = 0;
  let reviewCount = 0;
  if (product.ratingSummary && typeof product.ratingSummary.averageRating === 'number') {
    rating = product.ratingSummary.averageRating;
    reviewCount = product.ratingSummary.totalReviews || 0;
  } else if (Array.isArray(product.productReviews) && product.productReviews.length > 0) {
    reviewCount = product.productReviews.length;
    const sum = product.productReviews.reduce((acc: number, r: any) => acc + (Number(r.rating) || 0), 0);
    rating = Math.round((sum / reviewCount) * 10) / 10;
  } else if (typeof product.rating === 'number') {
    rating = product.rating;
    reviewCount = typeof product.reviewCount === 'number' ? product.reviewCount : 0;
  }

  const rawSold = product.soldCount ?? product.sold_count ?? product.unitsSold ?? product.totalSold;
  const soldCount = typeof rawSold === 'number'
    ? rawSold
    : (typeof rawSold === 'string' ? parseInt(rawSold, 10) || 0 : 0);

  const presentation = campaignPresentation !== undefined
    ? campaignPresentation
    : (product.campaignPresentation ?? null);

  return {
    ...product,
    name,
    nameAr: product.nameAr || name,
    nameEn: product.nameEn || name,
    currency: (product.currency === 'SAR' || product.currency === '﷼' || !product.currency) ? 'ر.ي' : product.currency,
    stock,
    rating,
    reviewCount,
    soldCount,
    sold_count: soldCount, // Canonical backward-compatible alias
    variants,
    sellerId,
    images,
    store,
    campaignPresentation: presentation,
    campaign: presentation, // Backward-compatible alias matching Section 10 & 57
  };
}

export function formatProductsForClient(products: any[], campaignPresentationMap?: Map<string, any>): any[] {
  if (!Array.isArray(products)) return [];
  return products.map((p) => {
    const presentation = campaignPresentationMap ? campaignPresentationMap.get(p.id) : undefined;
    return formatProductForClient(p, presentation);
  }).filter(Boolean);
}

/**
 * High-performance batch product formatter that resolves active campaign presentation badges.
 */
export async function formatProductsWithCampaigns(products: any[], locale = 'ar'): Promise<any[]> {
  if (!Array.isArray(products) || products.length === 0) return [];
  try {
    const { campaignBadgeService } = await import('../modules/promotions/services/campaign-badge.service');
    const presentationMap = await campaignBadgeService.batchResolveCampaignPresentations(products, locale);
    return formatProductsForClient(products, presentationMap);
  } catch (err) {
    console.error('[formatProductsWithCampaigns] Failed to resolve badges, falling back without badges:', err);
    return formatProductsForClient(products);
  }
}

/**
 * Single product formatter that resolves active campaign presentation badge.
 */
export async function formatProductWithCampaign(product: any, locale = 'ar'): Promise<any> {
  if (!product) return null;
  try {
    const { campaignBadgeService } = await import('../modules/promotions/services/campaign-badge.service');
    const presentationMap = await campaignBadgeService.batchResolveCampaignPresentations([product], locale);
    const pres = presentationMap.get(product.id) || null;
    return formatProductForClient(product, pres);
  } catch (err) {
    console.error('[formatProductWithCampaign] Failed to resolve badge, falling back without badge:', err);
    return formatProductForClient(product);
  }
}
