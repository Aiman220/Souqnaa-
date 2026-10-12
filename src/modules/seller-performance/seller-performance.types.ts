import { PerformanceGrade, PerformanceDataStatus } from '@prisma/client';

export { PerformanceGrade, PerformanceDataStatus };

export interface PerformanceWeights {
  satisfaction: number; // default 0.35
  response: number;     // default 0.20
  completion: number;   // default 0.20
  fulfillment: number;  // default 0.15
  issueRate: number;    // default 0.10
}

export interface PerformanceGradeThresholds {
  excellent: number;       // default 90
  veryGood: number;        // default 80
  good: number;            // default 70
  fair: number;            // default 60
}

export interface ResponseTimeThresholds {
  excellentMinutes: number; // <= 5 min -> 100 score
  veryGoodMinutes: number;  // <= 15 min -> 85 score
  goodMinutes: number;      // <= 60 min (1 hr) -> 70 score
  fairMinutes: number;      // <= 360 min (6 hrs) -> 50 score
  poorMinutes: number;      // > 360 min -> 20 score
}

export interface PerformanceEngineConfig {
  enabled: boolean;
  customerVisible: boolean;
  sellerVisible: boolean;
  recalculationEnabled: boolean;
  minOrders: number;        // default 5
  minReviews: number;       // default 3
  windowDays: number;       // default 30
  fulfillmentSlaHours: number; // default 48
  weights: PerformanceWeights;
  gradeThresholds: PerformanceGradeThresholds;
  responseTimeThresholds: ResponseTimeThresholds;
  algorithmVersion: string;
  configVersion: number;
}

export interface RawPerformanceMetrics {
  eligibleOrdersCount: number;
  deliveredOrdersCount: number;
  sellerCancelledOrdersCount: number;
  customerCancelledOrdersCount: number;
  onTimeOrdersCount: number;
  eligibleReviewsCount: number;
  ratingAverage: number;
  totalConversationsCount: number;
  answeredConversationsCount: number;
  medianResponseMinutes: number;
  averageResponseMinutes: number;
  confirmedDisputesCount: number;
  sellerIssuesCount: number;
}

export interface ComponentScores {
  customerSatisfactionScore: number; // 0 - 100
  responseTimeScore: number;          // 0 - 100
  orderCompletionScore: number;       // 0 - 100
  onTimeFulfillmentScore: number;     // 0 - 100
  issueRateScore: number;             // 0 - 100
}

export interface CalculatedPerformanceResult {
  finalScore: number;
  grade: PerformanceGrade;
  dataStatus: PerformanceDataStatus;
  components: ComponentScores;
  rates: {
    ratingAverage: number;
    responseRate: number;
    medianResponseMinutes: number;
    orderCompletionRate: number;
    onTimeFulfillmentRate: number;
    sellerCancellationRate: number;
    issueRate: number;
  };
  counts: {
    eligibleOrderCount: number;
    eligibleReviewCount: number;
    totalConversationsCount: number;
    answeredConversationsCount: number;
  };
  recommendations: SellerImprovementGuidance[];
  calculationWindow: string;
  calculationWindowDays: number;
  algorithmVersion: string;
  configVersion: number;
}

export interface SellerImprovementGuidance {
  key: 'CUSTOMER_SATISFACTION' | 'RESPONSE_TIME' | 'ORDER_COMPLETION' | 'ON_TIME_FULFILLMENT' | 'ISSUE_RATE';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  titleAr: string;
  titleEn: string;
  messageAr: string;
  messageEn: string;
  currentValueFormatted: string;
  targetFormatted: string;
  actionRoute?: string;
}

export interface PublicSellerPerformance {
  sellerId: string;
  grade: PerformanceGrade;
  gradeLabelAr: string;
  gradeLabelEn: string;
  ratingAverage: number;
  reviewCount: number;
  usuallyRespondsFast: boolean;
  highOrderCompletion: boolean;
  isReliable: boolean;
  score?: number | null;
  dataStatus: PerformanceDataStatus;
  statusLabelAr: string;
  statusLabelEn: string;
}

export interface AdminPerformanceFilter {
  grade?: PerformanceGrade;
  dataStatus?: PerformanceDataStatus;
  search?: string;
  sortBy?: 'score' | 'orders' | 'reviews' | 'calculatedAt';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}
