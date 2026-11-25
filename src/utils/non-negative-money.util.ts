import { AppError } from '../middleware/error.middleware';

/** Parse API supplied monetary values while rejecting negative or non-finite amounts. */
export function parseNonNegativeMoney(value: unknown, field = 'Amount'): number {
  const amount = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AppError(`${field} must be a valid non-negative amount`, 400, 'INVALID_MONEY_AMOUNT');
  }
  return amount;
}
