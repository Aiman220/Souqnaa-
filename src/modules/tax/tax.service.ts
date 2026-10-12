/**
 * SOUQNAA Marketplace — Production-Grade Centralized Tax Engine
 * Authoritative backend tax calculations, deterministic rule resolution,
 * immutable order snapshots, safe monetary rounding, and tax-aware refunds.
 */

import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import {
  TaxCalculationMethod,
  TaxTargetType,
  TaxExemptionEntityType,
  TaxAuditAction,
  DiscountTaxTreatment,
  RoundingStrategy,
  RoundingLevel,
  TaxConfiguration,
  TaxRule,
  TaxExemption,
  Prisma,
} from '@prisma/client';
import { TaxMath } from './tax.math';
import { TaxRuleResolver } from './tax-rule-resolver.service';
import {
  TaxCalculationInput,
  TaxCalculationResult,
  ItemTaxBreakdown,
  SellerTaxBreakdown,
  RefundTaxCalculationInput,
  RefundTaxCalculationResult,
  RefundTaxItemResult,
  CreateTaxRuleDto,
  UpdateTaxRuleDto,
  CreateTaxExemptionDto,
  UpdateTaxConfigDto,
} from './tax.types';
import { remoteConfigService } from '../remote-config/remote-config.service';

export class TaxEngine {
  private static readonly DEFAULT_CONFIG_ID = 'global';

  /**
   * Fetch effective global tax configuration with Remote Config fallback
   */
  public static async getEffectiveTaxConfiguration(): Promise<TaxConfiguration> {
    let config = await prisma.taxConfiguration.findUnique({
      where: { id: this.DEFAULT_CONFIG_ID },
    });

    if (!config) {
      // Auto-bootstrap default SOUQNAA tax configuration if not present
      config = await prisma.taxConfiguration.create({
        data: {
          id: this.DEFAULT_CONFIG_ID,
          taxEnabled: true,
          taxInclusivePrices: false,
          taxOnShippingEnabled: false,
          taxOnPlatformFeesEnabled: false,
          taxOnPaymentFeesEnabled: false,
          discountTreatment: DiscountTaxTreatment.AFTER_DISCOUNT,
          roundingStrategy: RoundingStrategy.HALF_UP,
          roundingLevel: RoundingLevel.LINE_ITEM,
          defaultRate: 0.05, // 5% configurable default VAT
          currency: 'YER',
          version: 1,
        },
      });

      // Ensure a default SOUQNAA Tax Rule exists
      const existingDefaultRule = await prisma.taxRule.findFirst({
        where: { targetType: TaxTargetType.DEFAULT, active: true },
      });

      if (!existingDefaultRule) {
        await prisma.taxRule.create({
          data: {
            name: 'ضريبة القيمة المضافة الافتراضية (سوقناا)',
            code: 'VAT_STANDARD_DEFAULT',
            description: 'الضريبة العامة الموحدة لمنصة سوقناا',
            rate: 0.05,
            calculationMethod: TaxCalculationMethod.PERCENTAGE,
            priceIncludesTax: false,
            appliesToProducts: true,
            appliesToShipping: false,
            appliesToPlatformFees: false,
            appliesToPaymentFees: false,
            appliesToDiscounts: true,
            active: true,
            priority: 100,
            targetType: TaxTargetType.DEFAULT,
            version: 1,
          },
        });
      }
    }

    return config;
  }

  /**
   * Main Cart / Order Tax Calculation Pipeline
   * Never trust client calculations — strictly authoritative on the server.
   */
  public static async calculateCartTax(
    input: TaxCalculationInput
  ): Promise<TaxCalculationResult> {
    const config = await this.getEffectiveTaxConfiguration();

    // Check Remote Config feature flag override
    let isTaxEngineActive = config.taxEnabled;
    try {
      const isFeatureActive = await remoteConfigService.isFeatureActive('tax_engine_enabled', {
        userId: input.customerId,
      });
      if (!isFeatureActive) {
        isTaxEngineActive = false;
      }
    } catch {
      // Keep DB config if remoteConfig throws
    }

    const currency = input.currency || config.currency || 'YER';
    const roundingStrategy = config.roundingStrategy;
    const discountTreatment = config.discountTreatment;
    const priceIncludesTax = config.taxInclusivePrices;

    // Fast-path: Taxation disabled
    if (!isTaxEngineActive) {
      return this.buildZeroTaxResult(input, config, currency);
    }

    // Step 1: Pre-fetch category IDs for items if missing to resolve category rules
    const productIdsNeedingCategory = input.items
      .filter((i) => !i.categoryId)
      .map((i) => i.productId);

    const categoryMap = new Map<string, string>();
    if (productIdsNeedingCategory.length > 0) {
      const products = await prisma.product.findMany({
        where: { id: { in: productIdsNeedingCategory } },
        select: { id: true, categoryId: true },
      });
      for (const p of products) {
        if (p.categoryId) categoryMap.set(p.id, p.categoryId);
      }
    }

    const itemBreakdowns: ItemTaxBreakdown[] = [];
    const sellerBreakdowns: Record<string, SellerTaxBreakdown> = {};

    let orderSubtotal = 0;
    let orderDiscountTotal = 0;
    let orderTaxableSubtotal = 0;
    let orderProductTax = 0;

    // Step 2: Line-Item Calculation Pipeline
    for (const item of input.items) {
      const categoryId = item.categoryId || categoryMap.get(item.productId) || null;
      const unitPrice = TaxMath.nonNegative(item.unitPrice);
      const quantity = Math.max(1, Math.floor(item.quantity));
      const grossAmount = TaxMath.multiply(unitPrice, quantity);
      const discountAmount = Math.min(grossAmount, TaxMath.nonNegative(item.discountAmount || 0));

      // Resolve deterministic rule
      const resolution = await TaxRuleResolver.resolve({
        productId: item.productId,
        categoryId,
        sellerId: item.sellerId,
        customerId: input.customerId,
      });

      let taxableAmount = 0;
      let taxAmount = 0;
      let taxRate = 0;
      let ruleCode: string | null = null;
      let ruleName: string | null = null;
      let ruleId: string | null = null;
      let ruleVersion = 1;
      let itemPriceIncludesTax = priceIncludesTax;
      let method: TaxCalculationMethod = TaxCalculationMethod.PERCENTAGE;

      if (!resolution.isExempt && resolution.rule) {
        const rule = resolution.rule;
        ruleId = rule.id;
        ruleCode = rule.code;
        ruleName = rule.name;
        ruleVersion = rule.version;
        taxRate = rule.rate;
        method = rule.calculationMethod;
        itemPriceIncludesTax = rule.priceIncludesTax || priceIncludesTax;

        // Calculate taxable base according to discount treatment
        const baseAmount =
          discountTreatment === DiscountTaxTreatment.AFTER_DISCOUNT
            ? TaxMath.subtract(grossAmount, discountAmount)
            : grossAmount;

        if (method === TaxCalculationMethod.FIXED_AMOUNT) {
          taxableAmount = baseAmount;
          taxAmount = TaxMath.multiply(taxRate, quantity);
        } else {
          // PERCENTAGE method
          if (itemPriceIncludesTax) {
            const split = TaxMath.extractInclusiveTax(baseAmount, taxRate, roundingStrategy);
            taxableAmount = split.netAmount;
            taxAmount = split.taxAmount;
          } else {
            taxableAmount = baseAmount;
            taxAmount = TaxMath.calculateExclusiveTax(taxableAmount, taxRate, roundingStrategy);
          }
        }
      } else {
        // Exempt or zero tax rule
        taxableAmount =
          discountTreatment === DiscountTaxTreatment.AFTER_DISCOUNT
            ? TaxMath.subtract(grossAmount, discountAmount)
            : grossAmount;
        taxAmount = 0;
        taxRate = 0;
      }

      orderSubtotal = TaxMath.add(orderSubtotal, grossAmount);
      orderDiscountTotal = TaxMath.add(orderDiscountTotal, discountAmount);
      orderTaxableSubtotal = TaxMath.add(orderTaxableSubtotal, taxableAmount);
      orderProductTax = TaxMath.add(orderProductTax, taxAmount);

      const itemBreakdown: ItemTaxBreakdown = {
        itemId: item.id,
        productId: item.productId,
        variantId: item.variantId || null,
        sellerId: item.sellerId,
        productNameAr: item.productNameAr,
        productNameEn: item.productNameEn,
        unitPrice,
        quantity,
        grossAmount,
        discountAmount,
        taxableAmount,
        taxRate,
        taxAmount,
        calculationMethod: method,
        priceIncludesTax: itemPriceIncludesTax,
        ruleId,
        ruleCode,
        ruleName,
        ruleVersion,
        isExempt: resolution.isExempt,
        exemptionReason: resolution.exemptionReason,
      };

      itemBreakdowns.push(itemBreakdown);

      // Group per seller
      if (!sellerBreakdowns[item.sellerId]) {
        sellerBreakdowns[item.sellerId] = {
          sellerId: item.sellerId,
          sellerSubtotal: 0,
          sellerDiscount: 0,
          sellerTaxableAmount: 0,
          sellerProductTax: 0,
          sellerShippingAmount: 0,
          sellerShippingTax: 0,
          sellerTotalTax: 0,
          sellerTotal: 0,
          items: [],
        };
      }

      const sbd = sellerBreakdowns[item.sellerId];
      sbd.sellerSubtotal = TaxMath.add(sbd.sellerSubtotal, grossAmount);
      sbd.sellerDiscount = TaxMath.add(sbd.sellerDiscount, discountAmount);
      sbd.sellerTaxableAmount = TaxMath.add(sbd.sellerTaxableAmount, taxableAmount);
      sbd.sellerProductTax = TaxMath.add(sbd.sellerProductTax, taxAmount);
      sbd.items.push(itemBreakdown);
    }

    // Step 3: Shipping Tax Treatment
    let orderShippingTax = 0;
    const shippingAmount = TaxMath.nonNegative(input.shippingAmount || 0);

    if (config.taxOnShippingEnabled && shippingAmount > 0) {
      // Resolve default tax rule for shipping
      const defaultRule = await prisma.taxRule.findFirst({
        where: { targetType: TaxTargetType.DEFAULT, active: true },
      });
      const shippingTaxRate = defaultRule ? defaultRule.rate : config.defaultRate;
      orderShippingTax = TaxMath.calculateExclusiveTax(
        shippingAmount,
        shippingTaxRate,
        roundingStrategy
      );

      // Distribute shipping tax to sellers if seller shipping is provided
      if (input.sellerShippingAmounts) {
        for (const [sellerId, sAmount] of Object.entries(input.sellerShippingAmounts)) {
          if (sellerBreakdowns[sellerId]) {
            const roundedSAmount = TaxMath.nonNegative(sAmount);
            const sTax = TaxMath.calculateExclusiveTax(
              roundedSAmount,
              shippingTaxRate,
              roundingStrategy
            );
            sellerBreakdowns[sellerId].sellerShippingAmount = roundedSAmount;
            sellerBreakdowns[sellerId].sellerShippingTax = sTax;
          }
        }
      }
    }

    // Step 4: Fees Tax Treatment
    let orderPlatformFeeTax = 0;
    const platformFee = TaxMath.nonNegative(input.platformFee || 0);
    if (config.taxOnPlatformFeesEnabled && platformFee > 0) {
      orderPlatformFeeTax = TaxMath.calculateExclusiveTax(
        platformFee,
        config.defaultRate,
        roundingStrategy
      );
    }

    let orderPaymentFeeTax = 0;
    const paymentFee = TaxMath.nonNegative(input.paymentFee || 0);
    if (config.taxOnPaymentFeesEnabled && paymentFee > 0) {
      orderPaymentFeeTax = TaxMath.calculateExclusiveTax(
        paymentFee,
        config.defaultRate,
        roundingStrategy
      );
    }

    // Step 5: Final Aggregation
    const totalTax = TaxMath.add(
      TaxMath.add(orderProductTax, orderShippingTax),
      TaxMath.add(orderPlatformFeeTax, orderPaymentFeeTax)
    );

    // Compute seller totals
    for (const sellerId of Object.keys(sellerBreakdowns)) {
      const sbd = sellerBreakdowns[sellerId];
      sbd.sellerTotalTax = TaxMath.add(sbd.sellerProductTax, sbd.sellerShippingTax);
      sbd.sellerTotal = TaxMath.add(
        TaxMath.subtract(sbd.sellerSubtotal, sbd.sellerDiscount),
        sbd.sellerTotalTax
      );
    }

    // Grand total: if prices are tax-inclusive, tax is already inside subtotal.
    // If tax-exclusive, grand total = (subtotal - discount) + deliveryFee + totalTax + fees.
    const netSubtotal = TaxMath.subtract(orderSubtotal, orderDiscountTotal);
    const grandTotal = priceIncludesTax
      ? TaxMath.add(TaxMath.add(netSubtotal, shippingAmount), TaxMath.add(platformFee, paymentFee))
      : TaxMath.add(
          TaxMath.add(netSubtotal, totalTax),
          TaxMath.add(shippingAmount, TaxMath.add(platformFee, paymentFee))
        );

    // Representative tax summary for simple client display
    const dominantRate = itemBreakdowns.find((i) => i.taxRate > 0)?.taxRate || config.defaultRate;
    const dominantName =
      itemBreakdowns.find((i) => i.ruleName)?.ruleName || 'ضريبة القيمة المضافة (VAT)';

    return {
      subtotal: orderSubtotal,
      discountTotal: orderDiscountTotal,
      taxableSubtotal: orderTaxableSubtotal,
      productTax: orderProductTax,
      shippingTax: orderShippingTax,
      platformFeeTax: orderPlatformFeeTax,
      paymentFeeTax: orderPaymentFeeTax,
      totalTax,
      grandTotal,
      currency,
      priceIncludesTax,
      discountTreatment,
      roundingStrategy,
      roundingLevel: config.roundingLevel,
      tax: {
        name: dominantName,
        rate: dominantRate,
        amount: totalTax,
        taxableAmount: orderTaxableSubtotal,
      },
      breakdown: itemBreakdowns,
      sellerBreakdowns,
      calculatedAt: new Date().toISOString(),
      configVersion: config.version,
    };
  }

  /**
   * Server-side authoritative validation:
   * Protects checkout against tampering with client-submitted taxes, discounts, or subtotals.
   */
  public static async validateTax(
    orderInput: TaxCalculationInput,
    clientTaxAmount?: number
  ): Promise<{ isValid: boolean; expectedTax: number; calculatedResult: TaxCalculationResult }> {
    const authoritativeResult = await this.calculateCartTax(orderInput);

    if (clientTaxAmount !== undefined && clientTaxAmount !== null) {
      const diff = Math.abs(authoritativeResult.totalTax - clientTaxAmount);
      if (diff > 0.05) {
        // Discrepancy beyond rounding epsilon indicates manipulation or stale cart state
        return {
          isValid: false,
          expectedTax: authoritativeResult.totalTax,
          calculatedResult: authoritativeResult,
        };
      }
    }

    return {
      isValid: true,
      expectedTax: authoritativeResult.totalTax,
      calculatedResult: authoritativeResult,
    };
  }

  /**
   * Save immutable OrderTaxSnapshot records at checkout
   * Ensures historical orders never recalculate using future tax configurations.
   */
  public static async createOrderTaxSnapshots(
    tx: Prisma.TransactionClient,
    orderId: string,
    result: TaxCalculationResult,
    sellerOrderMap: Map<string, string>, // sellerId -> sellerOrderId
    orderItemMap: Map<string, string> // clientItemId -> orderItemId
  ): Promise<void> {
    const snapshotsToCreate: Prisma.OrderTaxSnapshotCreateManyInput[] = [];

    for (const item of result.breakdown) {
      const sellerOrderId = sellerOrderMap.get(item.sellerId) || null;
      const orderItemId = orderItemMap.get(item.itemId) || null;

      snapshotsToCreate.push({
        orderId,
        sellerOrderId,
        orderItemId,
        sellerId: item.sellerId,
        taxRuleId: item.ruleId || null,
        taxRuleVersion: item.ruleVersion,
        taxName: item.ruleName || 'ضريبة القيمة المضافة',
        taxRate: item.taxRate,
        taxableAmount: item.taxableAmount,
        taxAmount: item.taxAmount,
        calculationMethod: item.calculationMethod,
        priceIncludesTax: item.priceIncludesTax,
        discountAmount: item.discountAmount,
        shippingTax: 0,
        feeTax: 0,
        currency: result.currency,
        calculatedAt: new Date(),
        metadata: JSON.stringify({
          productId: item.productId,
          variantId: item.variantId,
          grossAmount: item.grossAmount,
          isExempt: item.isExempt,
          exemptionReason: item.exemptionReason,
        }),
      });
    }

    // Add shipping & fee snapshots if applicable
    if (result.shippingTax > 0 || result.platformFeeTax > 0 || result.paymentFeeTax > 0) {
      snapshotsToCreate.push({
        orderId,
        sellerOrderId: null,
        orderItemId: null,
        sellerId: null,
        taxRuleId: null,
        taxRuleVersion: result.configVersion,
        taxName: 'ضريبة الشحن والرسوم الإدارية',
        taxRate: result.tax.rate,
        taxableAmount: TaxMath.add(result.shippingTax > 0 ? result.totalTax : 0, 0),
        taxAmount: TaxMath.add(
          result.shippingTax,
          TaxMath.add(result.platformFeeTax, result.paymentFeeTax)
        ),
        calculationMethod: 'PERCENTAGE',
        priceIncludesTax: result.priceIncludesTax,
        discountAmount: 0,
        shippingTax: result.shippingTax,
        feeTax: TaxMath.add(result.platformFeeTax, result.paymentFeeTax),
        currency: result.currency,
        calculatedAt: new Date(),
        metadata: JSON.stringify({
          shippingTax: result.shippingTax,
          platformFeeTax: result.platformFeeTax,
          paymentFeeTax: result.paymentFeeTax,
        }),
      });
    }

    if (snapshotsToCreate.length > 0) {
      await tx.orderTaxSnapshot.createMany({
        data: snapshotsToCreate,
      });
    }
  }

  /**
   * Tax-aware Refund Calculation (Section 13)
   * Idempotent: Never refunds more tax than originally collected on any item or order.
   */
  public static async calculateRefundTax(
    input: RefundTaxCalculationInput
  ): Promise<RefundTaxCalculationResult> {
    const { orderId, items, refundShipping, shippingRefundAmount } = input;

    // Load original immutable order snapshots
    const snapshots = await prisma.orderTaxSnapshot.findMany({
      where: { orderId },
    });

    if (snapshots.length === 0) {
      // Order had no tax or snapshots recorded
      return {
        orderId,
        totalRefundableTax: 0,
        totalRefundableAmount: 0,
        shippingTaxRefund: 0,
        items: [],
        calculationReference: 'NO_TAX_RECORDED',
        currency: 'YER',
      };
    }

    // Load past refund tax records to prevent duplicate tax refunds
    const pastRefundRecords = await prisma.refundTaxRecord.findMany({
      where: { orderId },
    });

    const previouslyRefundedPerItem = new Map<string, number>();
    for (const record of pastRefundRecords) {
      if (record.orderItemId) {
        const cur = previouslyRefundedPerItem.get(record.orderItemId) || 0;
        previouslyRefundedPerItem.set(
          record.orderItemId,
          TaxMath.add(cur, record.refundedTax)
        );
      }
    }

    const itemResults: RefundTaxItemResult[] = [];
    let totalItemRefundableTax = 0;
    let totalItemRefundAmount = 0;

    for (const item of items) {
      const snapshot = snapshots.find((s) => s.orderItemId === item.orderItemId);
      if (!snapshot) continue;

      const originalTax = TaxMath.nonNegative(snapshot.taxAmount);
      const originalTaxable = TaxMath.nonNegative(snapshot.taxableAmount);
      const prevRefunded = previouslyRefundedPerItem.get(item.orderItemId) || 0;
      const remainingTax = Math.max(0, TaxMath.subtract(originalTax, prevRefunded));

      // Calculate proportional tax for the refunded portion
      let itemTaxToRefund = 0;
      if (originalTaxable > 0 && originalTax > 0) {
        const ratio = Math.min(1.0, item.refundAmount / originalTaxable);
        const calculatedTax = TaxMath.round(originalTax * ratio, RoundingStrategy.HALF_UP);
        itemTaxToRefund = Math.min(remainingTax, calculatedTax);
      }

      totalItemRefundableTax = TaxMath.add(totalItemRefundableTax, itemTaxToRefund);
      totalItemRefundAmount = TaxMath.add(totalItemRefundAmount, item.refundAmount);

      itemResults.push({
        orderItemId: item.orderItemId,
        productId: snapshot.metadata ? JSON.parse(snapshot.metadata).productId : '',
        sellerId: snapshot.sellerId || '',
        originalTax,
        previouslyRefundedTax: prevRefunded,
        refundableTax: itemTaxToRefund,
        remainingTax: TaxMath.subtract(remainingTax, itemTaxToRefund),
      });
    }

    // Shipping tax refund handling
    let shippingTaxRefund = 0;
    if (refundShipping && shippingRefundAmount && shippingRefundAmount > 0) {
      const shippingSnapshot = snapshots.find((s) => s.shippingTax > 0);
      if (shippingSnapshot) {
        const pastShippingRefunds = pastRefundRecords
          .filter((r) => !r.orderItemId && r.calculationReference.includes('SHIPPING'))
          .reduce((sum, r) => TaxMath.add(sum, r.refundedTax), 0);

        const remainingShippingTax = Math.max(
          0,
          TaxMath.subtract(shippingSnapshot.shippingTax, pastShippingRefunds)
        );

        shippingTaxRefund = Math.min(
          remainingShippingTax,
          TaxMath.calculateExclusiveTax(shippingRefundAmount, shippingSnapshot.taxRate)
        );
      }
    }

    const totalRefundableTax = TaxMath.add(totalItemRefundableTax, shippingTaxRefund);
    const totalRefundableAmount = TaxMath.add(totalItemRefundAmount, shippingTaxRefund);

    return {
      orderId,
      totalRefundableTax,
      totalRefundableAmount,
      shippingTaxRefund,
      items: itemResults,
      calculationReference: `REFUND_TAX_CALC_${new Date().getTime()}`,
      currency: snapshots[0].currency,
    };
  }

  /**
   * Record permanent, idempotent RefundTaxRecord entries inside refund transaction
   */
  public static async recordRefundTax(
    tx: Prisma.TransactionClient,
    refundRequestId: string,
    result: RefundTaxCalculationResult
  ): Promise<void> {
    for (const item of result.items) {
      if (item.refundableTax <= 0) continue;

      await tx.refundTaxRecord.create({
        data: {
          refundId: refundRequestId,
          orderId: result.orderId,
          orderItemId: item.orderItemId,
          originalTax: item.originalTax,
          refundedTax: item.refundableTax,
          remainingTax: item.remainingTax,
          calculationReference: result.calculationReference,
        },
      });
    }

    if (result.shippingTaxRefund > 0) {
      await tx.refundTaxRecord.create({
        data: {
          refundId: refundRequestId,
          orderId: result.orderId,
          orderItemId: null,
          originalTax: result.shippingTaxRefund,
          refundedTax: result.shippingTaxRefund,
          remainingTax: 0,
          calculationReference: `${result.calculationReference}_SHIPPING`,
        },
      });
    }
  }

  /**
   * Helper to build a zero-tax calculation result when tax engine is disabled or exempt
   */
  private static buildZeroTaxResult(
    input: TaxCalculationInput,
    config: TaxConfiguration,
    currency: string
  ): TaxCalculationResult {
    let subtotal = 0;
    let discountTotal = 0;
    const items: ItemTaxBreakdown[] = [];
    const sellerBreakdowns: Record<string, SellerTaxBreakdown> = {};

    for (const item of input.items) {
      const gross = TaxMath.multiply(item.unitPrice, item.quantity);
      const discount = Math.min(gross, item.discountAmount || 0);
      subtotal = TaxMath.add(subtotal, gross);
      discountTotal = TaxMath.add(discountTotal, discount);

      const bd: ItemTaxBreakdown = {
        itemId: item.id,
        productId: item.productId,
        variantId: item.variantId || null,
        sellerId: item.sellerId,
        productNameAr: item.productNameAr,
        productNameEn: item.productNameEn,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        grossAmount: gross,
        discountAmount: discount,
        taxableAmount: TaxMath.subtract(gross, discount),
        taxRate: 0,
        taxAmount: 0,
        calculationMethod: TaxCalculationMethod.PERCENTAGE,
        priceIncludesTax: config.taxInclusivePrices,
        ruleId: null,
        ruleCode: 'TAX_EXEMPT_OR_DISABLED',
        ruleName: 'غير خاضع للضريبة',
        ruleVersion: 1,
        isExempt: true,
        exemptionReason: 'محرك الضرائب غير مفعل أو المنتج معفى',
      };
      items.push(bd);

      if (!sellerBreakdowns[item.sellerId]) {
        sellerBreakdowns[item.sellerId] = {
          sellerId: item.sellerId,
          sellerSubtotal: 0,
          sellerDiscount: 0,
          sellerTaxableAmount: 0,
          sellerProductTax: 0,
          sellerShippingAmount: 0,
          sellerShippingTax: 0,
          sellerTotalTax: 0,
          sellerTotal: 0,
          items: [],
        };
      }
      const sbd = sellerBreakdowns[item.sellerId];
      sbd.sellerSubtotal = TaxMath.add(sbd.sellerSubtotal, gross);
      sbd.sellerDiscount = TaxMath.add(sbd.sellerDiscount, discount);
      sbd.sellerTaxableAmount = TaxMath.add(sbd.sellerTaxableAmount, bd.taxableAmount);
      sbd.items.push(bd);
      sbd.sellerTotal = TaxMath.subtract(sbd.sellerSubtotal, sbd.sellerDiscount);
    }

    const shipping = TaxMath.nonNegative(input.shippingAmount || 0);
    const fees = TaxMath.add(
      TaxMath.nonNegative(input.platformFee || 0),
      TaxMath.nonNegative(input.paymentFee || 0)
    );
    const grandTotal = TaxMath.add(TaxMath.subtract(subtotal, discountTotal), TaxMath.add(shipping, fees));

    return {
      subtotal,
      discountTotal,
      taxableSubtotal: TaxMath.subtract(subtotal, discountTotal),
      productTax: 0,
      shippingTax: 0,
      platformFeeTax: 0,
      paymentFeeTax: 0,
      totalTax: 0,
      grandTotal,
      currency,
      priceIncludesTax: config.taxInclusivePrices,
      discountTreatment: config.discountTreatment,
      roundingStrategy: config.roundingStrategy,
      roundingLevel: config.roundingLevel,
      tax: {
        name: 'غير خاضع للضريبة',
        rate: 0,
        amount: 0,
        taxableAmount: 0,
      },
      breakdown: items,
      sellerBreakdowns,
      calculatedAt: new Date().toISOString(),
      configVersion: config.version,
    };
  }

  // ==========================================
  // ADMIN MANAGEMENT & AUDITING
  // ==========================================

  /**
   * Create a new Tax Rule with Audit Log
   */
  public static async createTaxRule(
    dto: CreateTaxRuleDto,
    adminId?: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<TaxRule> {
    if (dto.rate < 0) {
      throw new AppError('نسبة الضريبة لا يمكن أن تكون قيمة سالبة', 400);
    }

    const created = await prisma.taxRule.create({
      data: {
        name: dto.name,
        code: dto.code.toUpperCase().trim(),
        description: dto.description || null,
        rate: dto.rate,
        calculationMethod: dto.calculationMethod || TaxCalculationMethod.PERCENTAGE,
        priceIncludesTax: dto.priceIncludesTax ?? false,
        appliesToProducts: dto.appliesToProducts ?? true,
        appliesToShipping: dto.appliesToShipping ?? false,
        appliesToPlatformFees: dto.appliesToPlatformFees ?? false,
        appliesToPaymentFees: dto.appliesToPaymentFees ?? false,
        appliesToDiscounts: dto.appliesToDiscounts ?? true,
        active: dto.active ?? true,
        priority: dto.priority ?? 100,
        targetType: dto.targetType || TaxTargetType.DEFAULT,
        targetId: dto.targetId || null,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : null,
        effectiveUntil: dto.effectiveUntil ? new Date(dto.effectiveUntil) : null,
        createdBy: adminId || null,
        version: 1,
      },
    });

    // Write audit log
    await prisma.taxAuditLog.create({
      data: {
        adminId: adminId || null,
        action: TaxAuditAction.CREATE,
        ruleId: created.id,
        previousValue: null,
        newValue: JSON.stringify(created),
        reason: 'إنشاء قاعدة ضريبية جديدة',
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      },
    });

    TaxRuleResolver.invalidateCache();
    return created;
  }

  /**
   * Update an existing Tax Rule.
   * If the rule has already been referenced by historical order snapshots,
   * a NEW VERSION is automatically spawned to preserve audit integrity (Section 10).
   */
  public static async updateTaxRule(
    id: string,
    dto: UpdateTaxRuleDto,
    adminId?: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<TaxRule> {
    const existing = await prisma.taxRule.findUnique({
      where: { id },
      include: { snapshots: { select: { id: true }, take: 1 } },
    });

    if (!existing) {
      throw new AppError('القاعدة الضريبية غير موجودة', 404);
    }

    if (dto.rate !== undefined && dto.rate < 0) {
      throw new AppError('نسبة الضريبة لا يمكن أن تكون قيمة سالبة', 400);
    }

    const hasHistoricalOrders = existing.snapshots.length > 0;

    let updatedRule: TaxRule;

    if (hasHistoricalOrders) {
      // VERSIONING REQUIREMENT (Section 10 & 15):
      // Archive current rule and spawn version N+1
      await prisma.taxRule.update({
        where: { id: existing.id },
        data: { active: false, isArchived: true },
      });

      updatedRule = await prisma.taxRule.create({
        data: {
          name: dto.name ?? existing.name,
          code: dto.code ? dto.code.toUpperCase().trim() : existing.code,
          description: dto.description !== undefined ? dto.description : existing.description,
          rate: dto.rate ?? existing.rate,
          calculationMethod: dto.calculationMethod ?? existing.calculationMethod,
          priceIncludesTax: dto.priceIncludesTax ?? existing.priceIncludesTax,
          appliesToProducts: dto.appliesToProducts ?? existing.appliesToProducts,
          appliesToShipping: dto.appliesToShipping ?? existing.appliesToShipping,
          appliesToPlatformFees: dto.appliesToPlatformFees ?? existing.appliesToPlatformFees,
          appliesToPaymentFees: dto.appliesToPaymentFees ?? existing.appliesToPaymentFees,
          appliesToDiscounts: dto.appliesToDiscounts ?? existing.appliesToDiscounts,
          active: dto.active ?? true,
          priority: dto.priority ?? existing.priority,
          targetType: dto.targetType ?? existing.targetType,
          targetId: dto.targetId !== undefined ? dto.targetId : existing.targetId,
          effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : existing.effectiveFrom,
          effectiveUntil: dto.effectiveUntil ? new Date(dto.effectiveUntil) : existing.effectiveUntil,
          createdBy: existing.createdBy,
          updatedBy: adminId || null,
          version: existing.version + 1,
          parentRuleId: existing.id,
        },
      });

      await prisma.taxAuditLog.create({
        data: {
          adminId: adminId || null,
          action: TaxAuditAction.VERSION_CREATED,
          ruleId: updatedRule.id,
          previousValue: JSON.stringify(existing),
          newValue: JSON.stringify(updatedRule),
          reason: dto.changeReason || `ترقية إصدار القاعدة الضريبية إلى الإصدار ${updatedRule.version}`,
          ipAddress: meta?.ipAddress,
          userAgent: meta?.userAgent,
        },
      });
    } else {
      // In-place update if no historical orders ever used this rule
      updatedRule = await prisma.taxRule.update({
        where: { id },
        data: {
          name: dto.name ?? existing.name,
          code: dto.code ? dto.code.toUpperCase().trim() : existing.code,
          description: dto.description !== undefined ? dto.description : existing.description,
          rate: dto.rate ?? existing.rate,
          calculationMethod: dto.calculationMethod ?? existing.calculationMethod,
          priceIncludesTax: dto.priceIncludesTax ?? existing.priceIncludesTax,
          appliesToProducts: dto.appliesToProducts ?? existing.appliesToProducts,
          appliesToShipping: dto.appliesToShipping ?? existing.appliesToShipping,
          appliesToPlatformFees: dto.appliesToPlatformFees ?? existing.appliesToPlatformFees,
          appliesToPaymentFees: dto.appliesToPaymentFees ?? existing.appliesToPaymentFees,
          appliesToDiscounts: dto.appliesToDiscounts ?? existing.appliesToDiscounts,
          active: dto.active ?? existing.active,
          priority: dto.priority ?? existing.priority,
          targetType: dto.targetType ?? existing.targetType,
          targetId: dto.targetId !== undefined ? dto.targetId : existing.targetId,
          effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : existing.effectiveFrom,
          effectiveUntil: dto.effectiveUntil ? new Date(dto.effectiveUntil) : existing.effectiveUntil,
          updatedBy: adminId || null,
        },
      });

      await prisma.taxAuditLog.create({
        data: {
          adminId: adminId || null,
          action: TaxAuditAction.UPDATE,
          ruleId: updatedRule.id,
          previousValue: JSON.stringify(existing),
          newValue: JSON.stringify(updatedRule),
          reason: dto.changeReason || 'تعديل القاعدة الضريبية',
          ipAddress: meta?.ipAddress,
          userAgent: meta?.userAgent,
        },
      });
    }

    TaxRuleResolver.invalidateCache();
    return updatedRule;
  }

  /**
   * Activate a tax rule
   */
  public static async activateTaxRule(
    id: string,
    adminId?: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<TaxRule> {
    const rule = await prisma.taxRule.update({
      where: { id },
      data: { active: true, updatedBy: adminId || null },
    });

    await prisma.taxAuditLog.create({
      data: {
        adminId: adminId || null,
        action: TaxAuditAction.ACTIVATE,
        ruleId: rule.id,
        previousValue: JSON.stringify({ active: false }),
        newValue: JSON.stringify({ active: true }),
        reason: 'تفعيل القاعدة الضريبية',
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      },
    });

    TaxRuleResolver.invalidateCache();
    return rule;
  }

  /**
   * Deactivate a tax rule
   */
  public static async deactivateTaxRule(
    id: string,
    adminId?: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<TaxRule> {
    const rule = await prisma.taxRule.update({
      where: { id },
      data: { active: false, updatedBy: adminId || null },
    });

    await prisma.taxAuditLog.create({
      data: {
        adminId: adminId || null,
        action: TaxAuditAction.DEACTIVATE,
        ruleId: rule.id,
        previousValue: JSON.stringify({ active: true }),
        newValue: JSON.stringify({ active: false }),
        reason: 'تعطيل القاعدة الضريبية',
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      },
    });

    TaxRuleResolver.invalidateCache();
    return rule;
  }

  /**
   * Safe deletion or archival of a tax rule (§25 Database Integrity)
   * Historical rules with existing snapshots are never physically deleted.
   */
  public static async deleteTaxRule(
    id: string,
    adminId?: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ action: 'ARCHIVED' | 'DELETED'; rule: TaxRule }> {
    const existing = await prisma.taxRule.findUnique({
      where: { id },
      include: { _count: { select: { snapshots: true } } },
    });

    if (!existing) {
      throw new AppError('القاعدة الضريبية غير موجودة', 404);
    }

    if (existing._count.snapshots > 0) {
      // Rule has historical orders: Archive and deactivate (never physically delete)
      const rule = await prisma.taxRule.update({
        where: { id },
        data: { active: false, isArchived: true, updatedBy: adminId || null },
      });

      await prisma.taxAuditLog.create({
        data: {
          adminId: adminId || null,
          action: TaxAuditAction.DEACTIVATE,
          ruleId: rule.id,
          previousValue: JSON.stringify({ active: existing.active, isArchived: existing.isArchived }),
          newValue: JSON.stringify({ active: false, isArchived: true }),
          reason: 'أرشفة وتعطيل القاعدة الضريبية نظراً لارتباطها بطلبات تاريخية سابقة',
          ipAddress: meta?.ipAddress,
          userAgent: meta?.userAgent,
        },
      });

      TaxRuleResolver.invalidateCache();
      return { action: 'ARCHIVED', rule };
    } else {
      // Safe to physically delete since no order has ever used it
      await prisma.taxRule.delete({ where: { id } });

      await prisma.taxAuditLog.create({
        data: {
          adminId: adminId || null,
          action: TaxAuditAction.DEACTIVATE,
          ruleId: null,
          previousValue: JSON.stringify(existing),
          newValue: JSON.stringify({ deleted: true }),
          reason: 'حذف القاعدة الضريبية لعدم ارتباطها بأي طلبات سابقة',
          ipAddress: meta?.ipAddress,
          userAgent: meta?.userAgent,
        },
      });

      TaxRuleResolver.invalidateCache();
      return { action: 'DELETED', rule: existing };
    }
  }

  /**
   * Create a Tax Exemption
   */
  public static async createTaxExemption(
    dto: CreateTaxExemptionDto,
    adminId?: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<TaxExemption> {
    const exemption = await prisma.taxExemption.create({
      data: {
        entityType: dto.entityType,
        entityId: dto.entityId,
        reason: dto.reason,
        validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
        createdBy: adminId || null,
        active: true,
      },
    });

    await prisma.taxAuditLog.create({
      data: {
        adminId: adminId || null,
        action: TaxAuditAction.EXEMPT,
        exemptionId: exemption.id,
        previousValue: null,
        newValue: JSON.stringify(exemption),
        reason: `إنشاء إعفاء ضريبي: ${dto.reason}`,
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      },
    });

    TaxRuleResolver.invalidateCache();
    return exemption;
  }

  /**
   * Remove / Deactivate a Tax Exemption
   */
  public static async removeTaxExemption(
    id: string,
    adminId?: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<void> {
    const existing = await prisma.taxExemption.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('الإعفاء الضريبي غير موجود', 404);
    }

    await prisma.taxAuditLog.create({
      data: {
        adminId: adminId || null,
        action: TaxAuditAction.REMOVE_EXEMPTION,
        exemptionId: null,
        previousValue: JSON.stringify(existing),
        newValue: null,
        reason: `إلغاء الإعفاء الضريبي: ${existing.reason} (${existing.entityType}: ${existing.entityId})`,
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      },
    });

    await prisma.taxExemption.delete({ where: { id } });

    TaxRuleResolver.invalidateCache();
  }

  /**
   * Update global system tax configuration
   */
  public static async updateTaxConfiguration(
    dto: UpdateTaxConfigDto,
    adminId?: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<TaxConfiguration> {
    const current = await this.getEffectiveTaxConfiguration();

    const updated = await prisma.taxConfiguration.update({
      where: { id: this.DEFAULT_CONFIG_ID },
      data: {
        taxEnabled: dto.taxEnabled ?? current.taxEnabled,
        taxInclusivePrices: dto.taxInclusivePrices ?? current.taxInclusivePrices,
        taxOnShippingEnabled: dto.taxOnShippingEnabled ?? current.taxOnShippingEnabled,
        taxOnPlatformFeesEnabled: dto.taxOnPlatformFeesEnabled ?? current.taxOnPlatformFeesEnabled,
        taxOnPaymentFeesEnabled: dto.taxOnPaymentFeesEnabled ?? current.taxOnPaymentFeesEnabled,
        discountTreatment: dto.discountTreatment ?? current.discountTreatment,
        roundingStrategy: dto.roundingStrategy ?? current.roundingStrategy,
        roundingLevel: dto.roundingLevel ?? current.roundingLevel,
        defaultTaxRuleId: dto.defaultTaxRuleId !== undefined ? dto.defaultTaxRuleId : current.defaultTaxRuleId,
        defaultRate: dto.defaultRate ?? current.defaultRate,
        currency: dto.currency ?? current.currency,
        version: current.version + 1,
        updatedBy: adminId || null,
      },
    });

    await prisma.taxAuditLog.create({
      data: {
        adminId: adminId || null,
        action: TaxAuditAction.UPDATE,
        previousValue: JSON.stringify(current),
        newValue: JSON.stringify(updated),
        reason: 'تحديث إعدادات النظام الضريبي العامة',
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      },
    });

    TaxRuleResolver.invalidateCache();
    return updated;
  }

  /**
   * Get immutable snapshots for an order
   */
  public static async getOrderTaxSnapshot(orderId: string): Promise<any> {
    const snapshots = await prisma.orderTaxSnapshot.findMany({
      where: { orderId },
      include: {
        orderItem: {
          select: {
            id: true,
            productNameAr: true,
            productNameEn: true,
            unitPrice: true,
            quantity: true,
            totalPrice: true,
          },
        },
        taxRule: {
          select: {
            id: true,
            name: true,
            code: true,
            rate: true,
          },
        },
      },
    });

    const refundRecords = await prisma.refundTaxRecord.findMany({
      where: { orderId },
    });

    return {
      orderId,
      snapshotCount: snapshots.length,
      snapshots,
      refundRecords,
    };
  }

  /**
   * Generate Tax Reports and Analytics
   */
  public static async getTaxReports(params: {
    startDate?: string;
    endDate?: string;
    sellerId?: string;
  }): Promise<any> {
    const whereClause: Prisma.OrderTaxSnapshotWhereInput = {};

    if (params.startDate || params.endDate) {
      whereClause.calculatedAt = {};
      if (params.startDate) whereClause.calculatedAt.gte = new Date(params.startDate);
      if (params.endDate) whereClause.calculatedAt.lte = new Date(params.endDate);
    }

    if (params.sellerId) {
      whereClause.sellerId = params.sellerId;
    }

    const [snapshots, refundRecords] = await Promise.all([
      prisma.orderTaxSnapshot.findMany({
        where: whereClause,
      }),
      prisma.refundTaxRecord.findMany({
        where: {
          ...(params.startDate || params.endDate
            ? {
                createdAt: {
                  ...(params.startDate ? { gte: new Date(params.startDate) } : {}),
                  ...(params.endDate ? { lte: new Date(params.endDate) } : {}),
                },
              }
            : {}),
        },
      }),
    ]);

    let totalGrossTax = 0;
    let totalTaxableVolume = 0;
    const sellerSummary: Record<string, { sellerId: string; taxCollected: number; taxableVolume: number; orderCount: number }> = {};
    const ruleSummary: Record<string, { taxName: string; taxRate: number; totalTax: number; count: number }> = {};

    for (const snap of snapshots) {
      totalGrossTax = TaxMath.add(totalGrossTax, snap.taxAmount);
      totalTaxableVolume = TaxMath.add(totalTaxableVolume, snap.taxableAmount);

      if (snap.sellerId) {
        if (!sellerSummary[snap.sellerId]) {
          sellerSummary[snap.sellerId] = {
            sellerId: snap.sellerId,
            taxCollected: 0,
            taxableVolume: 0,
            orderCount: 0,
          };
        }
        const s = sellerSummary[snap.sellerId];
        s.taxCollected = TaxMath.add(s.taxCollected, snap.taxAmount);
        s.taxableVolume = TaxMath.add(s.taxableVolume, snap.taxableAmount);
        s.orderCount += 1;
      }

      const ruleKey = `${snap.taxName}_${snap.taxRate}`;
      if (!ruleSummary[ruleKey]) {
        ruleSummary[ruleKey] = {
          taxName: snap.taxName,
          taxRate: snap.taxRate,
          totalTax: 0,
          count: 0,
        };
      }
      ruleSummary[ruleKey].totalTax = TaxMath.add(ruleSummary[ruleKey].totalTax, snap.taxAmount);
      ruleSummary[ruleKey].count += 1;
    }

    const totalRefundedTax = refundRecords.reduce(
      (sum, r) => TaxMath.add(sum, r.refundedTax),
      0
    );
    const netTaxCollected = TaxMath.subtract(totalGrossTax, totalRefundedTax);

    return {
      period: {
        startDate: params.startDate || null,
        endDate: params.endDate || null,
      },
      summary: {
        totalTaxableVolume,
        totalGrossTax,
        totalRefundedTax,
        netTaxCollected,
        totalTransactions: snapshots.length,
      },
      sellerSummary: Object.values(sellerSummary),
      ruleSummary: Object.values(ruleSummary),
    };
  }
}
