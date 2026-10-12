export interface SyncOperationInput {
  operationId: string;
  entityType: 'CART' | 'WISHLIST' | 'PROFILE' | 'RECENTLY_VIEWED' | string;
  entityId: string;
  operationType: string;
  payload: Record<string, any>;
  createdAt?: string;
  idempotencyKey: string;
  localRevision?: number;
}

export interface SyncCartItemInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
  lastKnownPrice?: number;
}

export interface SyncWishlistItemInput {
  productId: string;
  variantId?: string | null;
}

export interface SyncProfileInput {
  name?: string;
  phone?: string;
  preferredLanguage?: string;
  avatarUrl?: string;
}

export interface SyncBatchRequest {
  syncId?: string;
  idempotencyKey?: string;
  operations?: SyncOperationInput[];
  cart?: SyncCartItemInput[];
  wishlist?: SyncWishlistItemInput[];
  profile?: SyncProfileInput;
  clientTimestamp?: string;
}

export interface SyncBatchResponse {
  success: boolean;
  processedCount: number;
  failedCount: number;
  processedOperationIds: string[];
  failedOperationIds: string[];
  adjustments: string[];
  authoritativeCart: any;
  authoritativeWishlist: any;
  authoritativeProfile: any;
  serverRevision: number;
  syncedAt: string;
}
