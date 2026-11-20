/**
 * Decimal-safe monetary arithmetic utility.
 * Operates on integer minor units (e.g. cents / fils = amount * 100)
 * to avoid IEEE 754 floating-point inaccuracies.
 */
export class MoneyUtil {
  private static readonly FACTOR = 100;

  /** Convert numeric or string amount to integer minor units (rounded) */
  static toMinorUnits(amount: number | string | null | undefined): number {
    if (amount == null) return 0;
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(num)) return 0;
    return Math.round(num * MoneyUtil.FACTOR);
  }

  /** Convert integer minor units back to decimal float rounded to 2 decimal places */
  static fromMinorUnits(minorUnits: number): number {
    return Math.round(minorUnits) / MoneyUtil.FACTOR;
  }

  /** Decimal-safe multiplication of price by quantity */
  static multiply(price: number | string, quantity: number | string): number {
    const priceMinor = MoneyUtil.toMinorUnits(price);
    const qty = typeof quantity === 'string' ? parseFloat(quantity) : quantity;
    if (isNaN(qty) || qty <= 0) return 0;
    const totalMinor = Math.round(priceMinor * qty);
    return MoneyUtil.fromMinorUnits(totalMinor);
  }

  /** Decimal-safe addition of multiple monetary amounts */
  static add(...amounts: (number | string | null | undefined)[]): number {
    const sumMinor = amounts.reduce<number>(
      (acc, a) => acc + MoneyUtil.toMinorUnits(a),
      0
    );
    return MoneyUtil.fromMinorUnits(sumMinor);
  }

  /** Decimal-safe subtraction: a - b */
  static subtract(a: number | string, b: number | string): number {
    const aMinor = MoneyUtil.toMinorUnits(a);
    const bMinor = MoneyUtil.toMinorUnits(b);
    return MoneyUtil.fromMinorUnits(aMinor - bMinor);
  }

  /** Decimal-safe percentage calculation (e.g. discount or tax) */
  static percentage(amount: number | string, percent: number | string): number {
    const amountMinor = MoneyUtil.toMinorUnits(amount);
    const p = typeof percent === 'string' ? parseFloat(percent) : percent;
    if (isNaN(p) || p <= 0) return 0;
    const resultMinor = Math.round((amountMinor * p) / 100);
    return MoneyUtil.fromMinorUnits(resultMinor);
  }

  /** Format amount as currency string with 2 decimal places */
  static format(amount: number | string, currency = 'ر.ي'): string {
    const val = MoneyUtil.fromMinorUnits(MoneyUtil.toMinorUnits(amount));
    return `${val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency}`;
  }
}
