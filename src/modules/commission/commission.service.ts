/**
 * SOUQNAA Marketplace — Authoritative Platform Commission Engine
 * Handles commission rate resolution, order item commission calculation,
 * commission record queries, and tiered/custom commission models.
 * Version: 1.1.0
 */

import { prisma } from '../../database/prisma';
import { config } from '../../config';
import { TaxMath } from '../tax/tax.math';

export enum CommissionType {
  PERCENTAGE = 'PERCENTAGE',
  FIXED = 'FIXED',
  CATEGORY_BASED = 'CATEGORY_BASED',
  PRODUCT_BASED = 'PRODUCT_BASED',
  SELLER_BASED = 'SELLER_BASED',
  CAMPAIGN_BASED = 'CAMPAIGN_BASED',
}

export interface CommissionResolutionResult {
  rate: number;
  commissionType: CommissionType;
  source: 'PRODUCT' | 'SELLER' | 'CATEGORY' | 'GLOBAL_DEFAULT';
  sourceId?: string;
}

export interface CalculatedItemCommission {
  orderItemId?: string;
  productId?: string;
  productName: string;
  commissionBase: number;
  commissionRate: number;
  commissionAmount: number;
  commissionType: CommissionType;
  currency: string;
}

export interface CalculatedOrderCommission {
  sellerOrderId: string;
  sellerId: string;
  totalCommissionBase: number;
  totalCommissionAmount: number;
  items: CalculatedItemCommission[];
  currency: string;
}

export class CommissionEngine {
  public static readonly VERSION = '1.1.0';

  /**
   * Resolves the authoritative effective commission rate for a product and seller according to SOUQNAA hierarchy:
   * 1. Product specific override (PRODUCT_BASED)
   * 2. Seller specific contract rate (SELLER_BASED)
   * 3. Category standard rate (CATEGORY_BASED)
   * 4. Platform global default rate (PERCENTAGE)
   */
  public static async resolveEffectiveRate(params: {
    productId?: string;
    sellerId?: string;
    categoryId?: string;
  }): Promise<CommissionResolutionResult> {
    // 1. Check Product-level commission rate
    if (params.productId) {
      const product = await prisma.product.findUnique({
        where: { id: params.productId },
        select: { id: true, commissionRate: true, categoryId: true, store: { select: { sellerId: true } } },
      });

      if (product) {
        if (product.commissionRate !== null && product.commissionRate !== undefined && product.commissionRate >= 0) {
          return {
            rate: product.commissionRate,
            commissionType: CommissionType.PRODUCT_BASED,
            source: 'PRODUCT',
            sourceId: product.id,
          };
        }
        if (!params.categoryId && product.categoryId) {
          params.categoryId = product.categoryId;
        }
        if (!params.sellerId && product.store?.sellerId) {
          params.sellerId = product.store.sellerId;
        }
      }
    }

    // 2. Check Seller contract rate
    if (params.sellerId) {
      const seller = await prisma.seller.findUnique({
        where: { id: params.sellerId },
        select: { id: true, commissionRate: true },
      });

      if (seller && seller.commissionRate !== null && seller.commissionRate !== undefined && seller.commissionRate >= 0) {
        return {
          rate: seller.commissionRate,
          commissionType: CommissionType.SELLER_BASED,
          source: 'SELLER',
          sourceId: seller.id,
        };
      }
    }

    // 3. Check Category-level rate
    if (params.categoryId) {
      const category = await prisma.category.findUnique({
        where: { id: params.categoryId },
        select: { id: true, commissionRate: true },
      });

      if (category && category.commissionRate !== null && category.commissionRate !== undefined && category.commissionRate >= 0) {
        return {
          rate: category.commissionRate,
          commissionType: CommissionType.CATEGORY_BASED,
          source: 'CATEGORY',
          sourceId: category.id,
        };
      }
    }

    // 4. Fallback to centralized platform default
    const globalRate = config.marketplace.defaultCommissionRate || 0.10;
    return {
      rate: globalRate,
      commissionType: CommissionType.PERCENTAGE,
      source: 'GLOBAL_DEFAULT',
    };
  }

  /**
   * Computes commission for a list of order items
   */
  public static async calculateOrderCommission(params: {
    sellerOrderId: string;
    sellerId: string;
    items: Array<{
      orderItemId?: string;
      productId?: string;
      productName: string;
      price: number;
      quantity: number;
      discount?: number;
      categoryId?: string;
    }>;
  }): Promise<CalculatedOrderCommission> {
    const currency = config.marketplace.currency || 'YER';
    let totalCommissionBase = 0;
    let totalCommissionAmount = 0;
    const itemsResult: CalculatedItemCommission[] = [];

    for (const item of params.items) {
      const resolution = await this.resolveEffectiveRate({
        productId: item.productId,
        sellerId: params.sellerId,
        categoryId: item.categoryId,
      });

      const lineGross = TaxMath.multiply(item.price, item.quantity);
      const lineDiscount = item.discount || 0;
      // Commission base is after product-level discounts
      const commissionBase = Math.max(0, TaxMath.subtract(lineGross, lineDiscount));
      const commissionAmount = TaxMath.multiply(commissionBase, resolution.rate);

      totalCommissionBase = TaxMath.add(totalCommissionBase, commissionBase);
      totalCommissionAmount = TaxMath.add(totalCommissionAmount, commissionAmount);

      itemsResult.push({
        orderItemId: item.orderItemId,
        productId: item.productId,
        productName: item.productName,
        commissionBase,
        commissionRate: resolution.rate,
        commissionAmount,
        commissionType: resolution.commissionType,
        currency,
      });
    }

    return {
      sellerOrderId: params.sellerOrderId,
      sellerId: params.sellerId,
      totalCommissionBase,
      totalCommissionAmount,
      items: itemsResult,
      currency,
    };
  }

  /**
   * Retrieves authoritative commission records for a seller within a date window
   */
  public static async getSellerCommissions(params: {
    sellerId: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const where: any = {
      sellerId: params.sellerId,
    };

    if (params.startDate || params.endDate) {
      where.createdAt = {};
      if (params.startDate) where.createdAt.gte = params.startDate;
      if (params.endDate) where.createdAt.lte = params.endDate;
    }

    const sellerOrders = await prisma.sellerOrder.findMany({
      where,
      include: {
        order: { select: { id: true, orderNumber: true, createdAt: true, status: true } },
        items: {
          include: {
            product: { select: { id: true, nameAr: true, nameEn: true, commissionRate: true, categoryId: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit,
      skip: params.page && params.limit ? (params.page - 1) * params.limit : undefined,
    });

    return sellerOrders.map((so) => ({
      sellerOrderId: so.id,
      orderId: so.orderId,
      orderNumber: so.order.orderNumber,
      orderDate: so.order.createdAt,
      orderStatus: so.status,
      grossSales: so.subtotal,
      discount: Number(so.sellerFundedDiscount || 0),
      commissionBase: Math.max(0, so.subtotal - Number(so.sellerFundedDiscount || 0)),
      commissionAmount: so.commissionAmount,
      currency: config.marketplace.currency || 'YER',
      items: so.items.map((it) => ({
        id: it.id,
        productId: it.productId,
        productName: it.product?.nameAr || 'منتج',
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        totalPrice: it.totalPrice,
      })),
    }));
  }
}
