import { AppError } from '../../middleware/error.middleware';

export function resolveRefundAmount(
  requestedAmount: unknown,
  capturedAmount: number,
  alreadyRefundedAmount: number
): number {
  if (!Number.isFinite(capturedAmount) || capturedAmount <= 0 ||
      !Number.isFinite(alreadyRefundedAmount) || alreadyRefundedAmount < 0) {
    throw new AppError('Stored payment amount is invalid.', 409, 'INVALID_REFUND_BALANCE');
  }

  const remainingRefundable = Number(Math.max(0, capturedAmount - alreadyRefundedAmount).toFixed(2));
  const amount = requestedAmount === undefined || requestedAmount === null
    ? remainingRefundable
    : Number(requestedAmount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError('Refund amount must be a positive finite number.', 400, 'INVALID_REFUND_AMOUNT');
  }
  if (amount > remainingRefundable) {
    throw new AppError('Refund amount exceeds the remaining refundable balance.', 409, 'REFUND_AMOUNT_EXCEEDS_REMAINING');
  }

  const roundedAmount = Number(amount.toFixed(2));
  if (roundedAmount <= 0) {
    throw new AppError('Refund amount is below the supported precision.', 400, 'INVALID_REFUND_AMOUNT');
  }
  return roundedAmount;
}
