export interface GuestSessionInfo {
  guestSessionId: string;
  createdAt: string;
  expiresAt: string;
}

export interface GuestCartItemInput {
  id?: string;
  productId: string;
  variantId?: string | null;
  storeId?: string;
  quantity: number;
  lastKnownPrice?: number;
  lastKnownImage?: string;
  productName?: string;
  selectedOptions?: Record<string, string>;
}

export interface GuestCartValidationRequest {
  items: GuestCartItemInput[];
  couponCode?: string;
}

export interface GuestCartItemOutput {
  id: string;
  productId: string;
  variantId: string | null;
  storeId: string;
  storeName: string;
  productName: string;
  productNameAr?: string | null;
  image: string | null;
  unitPrice: number;
  compareAtPrice: number | null;
  quantity: number;
  itemTotal: number;
  isAvailable: boolean;
  stock: number;
  isFlashSale: boolean;
  flashSaleReservationId?: string | null;
  warning?: string | null;
}

export interface GuestStoreGroup {
  store: {
    id: string;
    sellerId: string;
    name: string;
    slug: string;
    logo?: string | null;
    isActive: boolean;
    isVerified: boolean;
  };
  items: GuestCartItemOutput[];
  subtotal: number;
}

export interface GuestCartValidationResponse {
  valid: boolean;
  cartId: string;
  stores: GuestStoreGroup[];
  itemCount: number;
  subtotal: number;
  couponCode?: string | null;
  discountAmount: number;
  currency: string;
  warnings: string[];
  priceChanged: boolean;
  quantityAdjusted: boolean;
  outOfStock: boolean;
}

export interface GuestWishlistItemInput {
  productId: string;
  variantId?: string | null;
  addedPrice?: number;
}

export interface GuestWishlistValidationResponse {
  items: Array<{
    productId: string;
    variantId?: string | null;
    productName: string;
    productNameAr?: string | null;
    storeId: string;
    storeName: string;
    image: string | null;
    currentPrice: number;
    compareAtPrice: number | null;
    isInStock: boolean;
    availableStock: number;
    isPriceDropped: boolean;
    priceDropAmount: number;
    priceDropPercentage: number;
    currency: string;
  }>;
  totalCount: number;
}

export interface GuestContactInfo {
  fullName: string;
  phoneNumber: string;
  email?: string;
  notes?: string;
}

export interface GuestAddressInfo {
  governorate?: string;
  city: string;
  cityId?: string;
  neighborhood?: string;
  street: string;
  latitude?: number;
  longitude?: number;
}

export interface GuestCheckoutPrepareRequest {
  guestSessionId: string;
  items: GuestCartItemInput[];
  contact: GuestContactInfo;
  address: GuestAddressInfo;
  deliveryMethodCode?: string; // 'standard' | 'express' | 'scheduled'
  isExpress?: boolean;
  deliveryScheduleType?: 'ASAP' | 'SCHEDULED' | 'EXPRESS';
  deliveryDate?: string;
  deliveryTimeSlotId?: string;
  couponCode?: string;
  paymentMethod?: string;
}

export interface GuestCheckoutPrepareResponse {
  valid: boolean;
  guestSessionId: string;
  contact: GuestContactInfo;
  address: GuestAddressInfo;
  deliverySelection: {
    deliveryMethodCode: string;
    isExpress: boolean;
    deliveryScheduleType: string;
    deliveryDate?: string;
    deliveryTimeSlotId?: string;
  };
  stores: GuestStoreGroup[];
  financials: {
    subtotal: number;
    discountAmount: number;
    calculatedDeliveryFee: number;
    deliveryDiscount: number;
    deliverySubsidy: number;
    customerDeliveryCharge: number;
    fundingSource: 'PLATFORM' | 'SELLER' | 'CUSTOMER';
    total: number;
    currency: string;
  };
  warnings: string[];
  requiresAuthToFinalize: boolean;
  availablePaymentMethods: Array<{
    code: string;
    nameAr: string;
    nameEn: string;
    requiresAccount: boolean;
    descriptionAr: string;
  }>;
}

export interface GuestMergeRequest {
  guestSessionId: string;
  cartItems?: GuestCartItemInput[];
  wishlistItems?: GuestWishlistItemInput[];
}

export interface GuestMergeResponse {
  success: boolean;
  mergedCartItemCount: number;
  mergedWishlistItemCount: number;
  adjustments: string[];
  cart: any; // Full user cart
}
