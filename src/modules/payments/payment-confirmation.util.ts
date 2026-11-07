import { AppError } from '../../middleware/error.middleware';

export function requireProviderVerifiedPayment(): never {
  throw new AppError(
    'Payment confirmation requires a verified provider callback or an authorized manual transfer review.',
    403,
    'PAYMENT_PROVIDER_VERIFICATION_REQUIRED'
  );
}
