import { prisma } from '../../../database/prisma';
import { PlacementPageType, PlacementSlotType } from '@prisma/client';

export interface DefaultPlacementDef {
  key: string;
  name: string;
  description: string;
  pageType: PlacementPageType;
  slotType: PlacementSlotType;
  maxItems: number;
  carouselEnabled: boolean;
  autoplayEnabled: boolean;
  autoplayInterval: number;
  desktopEnabled: boolean;
  tabletEnabled: boolean;
  mobileEnabled: boolean;
  displayOrder: number;
}

export const DEFAULT_PLACEMENTS: DefaultPlacementDef[] = [
  {
    key: 'HOME_HERO',
    name: 'Home Hero Carousel',
    description: 'Top banner carousel on the marketplace home screen',
    pageType: 'HOME',
    slotType: 'CAROUSEL',
    maxItems: 8,
    carouselEnabled: true,
    autoplayEnabled: true,
    autoplayInterval: 4000,
    desktopEnabled: true,
    tabletEnabled: true,
    mobileEnabled: true,
    displayOrder: 1,
  },
  {
    key: 'HOME_SECONDARY',
    name: 'Home Secondary Promotional Banner',
    description: 'Mid-page promotional banner on the home screen',
    pageType: 'HOME',
    slotType: 'BANNER',
    maxItems: 2,
    carouselEnabled: false,
    autoplayEnabled: false,
    autoplayInterval: 0,
    desktopEnabled: true,
    tabletEnabled: true,
    mobileEnabled: true,
    displayOrder: 2,
  },
  {
    key: 'HOME_VOUCHER',
    name: 'Home Voucher Strip',
    description: 'Interactive voucher collection strip on home screen',
    pageType: 'HOME',
    slotType: 'STRIP',
    maxItems: 4,
    carouselEnabled: false,
    autoplayEnabled: false,
    autoplayInterval: 0,
    desktopEnabled: true,
    tabletEnabled: true,
    mobileEnabled: true,
    displayOrder: 3,
  },
  {
    key: 'HOME_FLASH_SALE',
    name: 'Flash Sale Highlight Banner',
    description: 'Banner accompanying flash sale section with countdown link',
    pageType: 'HOME',
    slotType: 'BANNER',
    maxItems: 2,
    carouselEnabled: false,
    autoplayEnabled: false,
    autoplayInterval: 0,
    desktopEnabled: true,
    tabletEnabled: true,
    mobileEnabled: true,
    displayOrder: 4,
  },
  {
    key: 'CATEGORY_TOP',
    name: 'Category Top Banner',
    description: 'Banner displayed at the top of category products listing',
    pageType: 'CATEGORY',
    slotType: 'BANNER',
    maxItems: 3,
    carouselEnabled: true,
    autoplayEnabled: true,
    autoplayInterval: 5000,
    desktopEnabled: true,
    tabletEnabled: true,
    mobileEnabled: true,
    displayOrder: 1,
  },
  {
    key: 'SEARCH_TOP',
    name: 'Search Results Sponsored Banner',
    description: 'Promotional banner matching search queries and categories',
    pageType: 'SEARCH',
    slotType: 'BANNER',
    maxItems: 1,
    carouselEnabled: false,
    autoplayEnabled: false,
    autoplayInterval: 0,
    desktopEnabled: true,
    tabletEnabled: true,
    mobileEnabled: true,
    displayOrder: 1,
  },
  {
    key: 'STORE_TOP',
    name: 'Store Header Promotional Banner',
    description: 'Seller store campaign banner displayed on store front',
    pageType: 'STORE',
    slotType: 'BANNER',
    maxItems: 3,
    carouselEnabled: true,
    autoplayEnabled: true,
    autoplayInterval: 5000,
    desktopEnabled: true,
    tabletEnabled: true,
    mobileEnabled: true,
    displayOrder: 1,
  },
  {
    key: 'PRODUCT_TOP',
    name: 'Product Details Promotional Banner',
    description: 'Banner on product details page linking to related campaign or voucher',
    pageType: 'PRODUCT',
    slotType: 'STRIP',
    maxItems: 1,
    carouselEnabled: false,
    autoplayEnabled: false,
    autoplayInterval: 0,
    desktopEnabled: true,
    tabletEnabled: true,
    mobileEnabled: true,
    displayOrder: 1,
  },
  {
    key: 'CHECKOUT_PROMOTION',
    name: 'Checkout Voucher Callout',
    description: 'Banner at checkout encouraging customer to collect vouchers or join promotion',
    pageType: 'CHECKOUT',
    slotType: 'STRIP',
    maxItems: 1,
    carouselEnabled: false,
    autoplayEnabled: false,
    autoplayInterval: 0,
    desktopEnabled: true,
    tabletEnabled: true,
    mobileEnabled: true,
    displayOrder: 1,
  },
];

class PlacementService {
  /**
   * Seed default placements if they don't already exist.
   */
  async seedDefaultPlacements(): Promise<void> {
    for (const def of DEFAULT_PLACEMENTS) {
      await prisma.bannerPlacement.upsert({
        where: { key: def.key },
        create: { ...def },
        update: {
          name: def.name,
          description: def.description,
          pageType: def.pageType,
          slotType: def.slotType,
          maxItems: def.maxItems,
          carouselEnabled: def.carouselEnabled,
          autoplayEnabled: def.autoplayEnabled,
          autoplayInterval: def.autoplayInterval,
          desktopEnabled: def.desktopEnabled,
          tabletEnabled: def.tabletEnabled,
          mobileEnabled: def.mobileEnabled,
          displayOrder: def.displayOrder,
        },
      });
    }
  }

  async getAllPlacements(onlyActive = false) {
    return prisma.bannerPlacement.findMany({
      where: onlyActive ? { isActive: true } : undefined,
      orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }],
    });
  }

  async getPlacementByKey(key: string) {
    return prisma.bannerPlacement.findUnique({
      where: { key },
    });
  }

  async getPlacementById(id: string) {
    return prisma.bannerPlacement.findUnique({
      where: { id },
    });
  }

  async createPlacement(data: {
    key: string;
    name: string;
    description?: string;
    pageType?: PlacementPageType;
    slotType?: PlacementSlotType;
    maxItems?: number;
    carouselEnabled?: boolean;
    autoplayEnabled?: boolean;
    autoplayInterval?: number;
    desktopEnabled?: boolean;
    tabletEnabled?: boolean;
    mobileEnabled?: boolean;
    displayOrder?: number;
  }) {
    return prisma.bannerPlacement.create({
      data: {
        key: data.key.toUpperCase(),
        name: data.name,
        description: data.description,
        pageType: data.pageType || 'HOME',
        slotType: data.slotType || 'BANNER',
        maxItems: data.maxItems ?? 5,
        carouselEnabled: data.carouselEnabled ?? true,
        autoplayEnabled: data.autoplayEnabled ?? true,
        autoplayInterval: data.autoplayInterval ?? 4000,
        desktopEnabled: data.desktopEnabled ?? true,
        tabletEnabled: data.tabletEnabled ?? true,
        mobileEnabled: data.mobileEnabled ?? true,
        displayOrder: data.displayOrder ?? 0,
      },
    });
  }

  async updatePlacement(id: string, data: Partial<DefaultPlacementDef & { isActive: boolean }>) {
    return prisma.bannerPlacement.update({
      where: { id },
      data,
    });
  }

  async deletePlacement(id: string) {
    return prisma.bannerPlacement.delete({
      where: { id },
    });
  }
}

export const placementService = new PlacementService();
