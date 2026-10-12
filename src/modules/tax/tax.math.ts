/**
 * SOUQNAA Marketplace — Production-Grade Monetary & Tax Math Utility
 * Protects against floating-point inaccuracies, ensures deterministic rounding,
 * and maintains consistent precision across all marketplace financial calculations.
 */

import { RoundingStrategy } from '@prisma/client';

export class TaxMath {
  private static readonly DEFAULT_DECIMALS = 2;

  /**
   * Safe financial addition avoiding 0.1 + 0.2 = 0.30000000000000004
   */
  public static add(a: number, b: number, decimals: number = this.DEFAULT_DECIMALS): number {
    const factor = Math.pow(10, decimals);
    return Math.round((Math.round(a * factor) + Math.round(b * factor))) / factor;
  }

  /**
   * Safe financial subtraction
   */
  public static subtract(a: number, b: number, decimals: number = this.DEFAULT_DECIMALS): number {
    const factor = Math.pow(10, decimals);
    return Math.round((Math.round(a * factor) - Math.round(b * factor))) / factor;
  }

  /**
   * Safe financial multiplication
   */
  public static multiply(a: number, b: number, decimals: number = this.DEFAULT_DECIMALS): number {
    const factor = Math.pow(10, decimals);
    const result = (a * b);
    return this.round(result, RoundingStrategy.HALF_UP, decimals);
  }

  /**
   * Safe financial division
   */
  public static divide(a: number, b: number, decimals: number = this.DEFAULT_DECIMALS): number {
    if (b === 0) return 0;
    const result = a / b;
    return this.round(result, RoundingStrategy.HALF_UP, decimals);
  }

  /**
   * Deterministic financial rounding according to platform accounting strategy
   */
  public static round(
    amount: number,
    strategy: RoundingStrategy = RoundingStrategy.HALF_UP,
    decimals: number = this.DEFAULT_DECIMALS
  ): number {
    if (isNaN(amount) || !isFinite(amount)) return 0;

    const factor = Math.pow(10, decimals);
    const scaled = amount * factor;

    // Use epsilon to prevent floating-point representation quirks near .5
    const eps = 1e-10;

    switch (strategy) {
      case RoundingStrategy.HALF_DOWN: {
        const floorVal = Math.floor(scaled);
        const diff = scaled - floorVal;
        if (Math.abs(diff - 0.5) < eps) {
          return floorVal / factor;
        }
        return Math.round(scaled) / factor;
      }
      case RoundingStrategy.FLOOR:
        return Math.floor(scaled + eps) / factor;

      case RoundingStrategy.CEILING:
        return Math.ceil(scaled - eps) / factor;

      case RoundingStrategy.HALF_UP:
      default:
        return Math.round(scaled) / factor;
    }
  }

  /**
   * Calculate exclusive tax:
   * Tax = taxableAmount * rate
   */
  public static calculateExclusiveTax(
    taxableAmount: number,
    rate: number,
    strategy: RoundingStrategy = RoundingStrategy.HALF_UP,
    decimals: number = this.DEFAULT_DECIMALS
  ): number {
    if (taxableAmount <= 0 || rate <= 0) return 0;
    const rawTax = taxableAmount * rate;
    return this.round(rawTax, strategy, decimals);
  }

  /**
   * Calculate inclusive tax:
   * Net = grossAmount / (1 + rate)
   * Tax = grossAmount - Net
   */
  public static extractInclusiveTax(
    grossAmount: number,
    rate: number,
    strategy: RoundingStrategy = RoundingStrategy.HALF_UP,
    decimals: number = this.DEFAULT_DECIMALS
  ): { netAmount: number; taxAmount: number } {
    if (grossAmount <= 0 || rate <= 0) {
      return { netAmount: Math.max(0, grossAmount), taxAmount: 0 };
    }
    const net = grossAmount / (1 + rate);
    const roundedNet = this.round(net, strategy, decimals);
    const roundedTax = this.subtract(grossAmount, roundedNet, decimals);
    return {
      netAmount: roundedNet,
      taxAmount: Math.max(0, roundedTax),
    };
  }

  /**
   * Clamp a monetary amount to non-negative
   */
  public static nonNegative(amount: number): number {
    return Math.max(0, this.round(amount));
  }
}
