import {
  RewardTxType,
  RewardTxSource,
  RewardTxStatus,
  CoinLotStatus,
  RewardFundingSource,
  CoinReservationStatus,
  MissionType,
  MissionStatus,
  CoinCampaignType,
  CoinCampaignStatus,
  ReferralRecordStatus,
} from '@prisma/client';

export {
  RewardTxType,
  RewardTxSource,
  RewardTxStatus,
  CoinLotStatus,
  RewardFundingSource,
  CoinReservationStatus,
  MissionType,
  MissionStatus,
  CoinCampaignType,
  CoinCampaignStatus,
  ReferralRecordStatus,
};

export interface CoinBalanceSummary {
  customerId: string;
  availableCoins: number;
  pendingCoins: number;
  expiringSoonCoins: number;
  expiringSoonDate: string | null;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  lifetimeExpired: number;
  referralCode: string;
  currentStreak: number;
  longestStreak: number;
  lastCheckInDate: string | null;
  canCheckInToday: boolean;
  currencyEquivalent: number; // e.g., availableCoins / 100 in YER
  currencyCode: string;
  riskFlag: boolean;
}

export interface CoinQuoteRequest {
  customerId: string;
  orderSubtotal: number;
  coinsRequested?: number;
  currency?: string;
  orderId?: string;
}

export interface CoinQuoteResponse {
  quoteId: string;
  quoteVersion: string;
  availableCoins: number;
  maxUsableCoins: number;
  coinsRequested: number;
  coinsAccepted: number;
  conversionRate: number; // e.g. 100 coins = 1 YER
  discountAmount: number; // in currency
  orderSubtotal: number;
  remainingPayable: number;
  currency: string;
  maxOrderPercentage: number;
  expiresAt: string; // ISO string
  eligible: boolean;
  reason?: string;
}

export interface CoinReservationRequest {
  customerId: string;
  quoteId: string;
  coins: number;
  discountAmount: number;
  orderId?: string;
  idempotencyKey?: string;
}

export interface DailyCheckinStatus {
  todayDate: string; // "YYYY-MM-DD"
  hasClaimedToday: boolean;
  currentStreak: number;
  longestStreak: number;
  todayRewardCoins: number;
  schedule: Array<{
    dayNumber: number;
    coins: number;
    bonusCoins: number;
    labelAr: string;
    labelEn: string;
    isToday: boolean;
    isClaimed: boolean;
    isMissed: boolean;
  }>;
}

export interface MissionWithProgress {
  id: string;
  titleAr: string;
  titleEn: string;
  descriptionAr: string;
  descriptionEn: string;
  type: MissionType;
  target: number;
  rewardCoins: number;
  badgeIcon: string | null;
  progress: number;
  completed: boolean;
  claimed: boolean;
  completedAt: string | null;
  claimedAt: string | null;
  startAt: string;
  endAt: string;
  expiresInHours: number;
}

export interface ReferralSummary {
  referralCode: string;
  shareUrl: string;
  referrerRewardCoins: number;
  refereeRewardCoins: number;
  minOrderAmount: number;
  totalInvited: number;
  totalCompleted: number;
  totalCoinsEarned: number;
  records: Array<{
    id: string;
    refereeName: string;
    status: ReferralRecordStatus;
    rewardEarned: number;
    createdAt: string;
    completedAt: string | null;
  }>;
}

export interface GlobalRewardRules {
  purchaseRewardRate: number; // e.g. 0.01 (1 coin per 100 currency units)
  minPurchaseForReward: number;
  maxRewardPerOrder: number;
  reviewTextReward: number;
  reviewPhotoReward: number;
  reviewVideoReward: number;
  referralReferrerReward: number;
  referralRefereeReward: number;
  referralMinOrderAmount: number;
  redemptionRatio: number; // e.g. 100 coins = 1 currency unit
  maxOrderPercentage: number; // e.g. 0.20 (20%)
  maxCoinsPerOrder: number;
  minCoinsRequired: number;
  minOrderAmount: number;
  defaultExpirationDays: number;
  warningDays: number;
  coinsCoverDelivery: boolean;
  negativeBalanceAllowed: boolean;
  version: string;
}

export interface FeatureFlagsConfig {
  'rewards_coins.enabled': boolean;
  'rewards_coin_redemption.enabled': boolean;
  'rewards_daily_checkin.enabled': boolean;
  'rewards_missions.enabled': boolean;
  'rewards_purchase_rewards.enabled': boolean;
  'rewards_review_rewards.enabled': boolean;
  'rewards_photo_review_rewards.enabled': boolean;
  'rewards_video_review_rewards.enabled': boolean;
  'rewards_referrals.enabled': boolean;
  'rewards_campaign_bonus.enabled': boolean;
  'rewards_seller_rewards.enabled': boolean;
  'rewards_coin_expiration.enabled': boolean;
}
