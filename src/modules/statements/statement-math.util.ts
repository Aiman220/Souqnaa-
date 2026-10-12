/**
 * SOUQNAA Marketplace — Statement Financial Math Utility
 * Protects against floating-point inaccuracies, ensuring accurate monetary arithmetic.
 * Never uses raw floating-point operations for financial calculations.
 */

import { TaxMath } from '../tax/tax.math';
import { RoundingStrategy } from '@prisma/client';

export class StatementMath {
  private static readonly DECIMALS = 2;

  public static add(a: number, b: number): number {
    return TaxMath.add(a || 0, b || 0, this.DECIMALS);
  }

  public static subtract(a: number, b: number): number {
    return TaxMath.subtract(a || 0, b || 0, this.DECIMALS);
  }

  public static multiply(a: number, b: number): number {
    return TaxMath.multiply(a || 0, b || 0, this.DECIMALS);
  }

  public static divide(a: number, b: number): number {
    return TaxMath.divide(a || 0, b || 1, this.DECIMALS);
  }

  public static round(amount: number): number {
    return TaxMath.round(amount || 0, RoundingStrategy.HALF_UP, this.DECIMALS);
  }

  public static sum(values: number[]): number {
    return values.reduce((acc, curr) => this.add(acc, curr), 0);
  }
}
