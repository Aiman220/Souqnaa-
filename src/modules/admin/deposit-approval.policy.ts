import { AppError } from '../../middleware/error.middleware';

/** Resolve a customer wallet deposit credit without allowing an override above verified funds. */
export function resolveCustomerDepositApprovalAmount(requestedAmount: number, approvedInput?: unknown): number {
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    throw new AppError('مبلغ الإيداع المسجل غير صالح.', 400, 'INVALID_DEPOSIT_AMOUNT');
  }

  if (approvedInput === undefined || approvedInput === null || approvedInput === '') {
    return requestedAmount;
  }

  const approvedAmount = typeof approvedInput === 'number' ? approvedInput : Number(String(approvedInput).trim());
  if (!Number.isFinite(approvedAmount) || approvedAmount <= 0 || approvedAmount > requestedAmount) {
    throw new AppError('مبلغ الاعتماد يجب أن يكون موجباً وألا يتجاوز مبلغ الإيداع.', 400, 'INVALID_APPROVED_DEPOSIT_AMOUNT');
  }

  return approvedAmount;
}
