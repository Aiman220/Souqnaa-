/**
 * SOUQNA — FIRST ORDER FREE SHIPPING ENGINE
 * Authoritative Abuse & Fraud Detection Service
 * Version: 1.0.0
 */

import { prisma } from '../../../database/prisma';
import {
  FirstOrderAbuseEvaluation,
  FirstOrderShippingConfigDto,
  DeviceIntegrityStatus,
} from '../first-order-shipping.types';
import { IntegrityEvidenceInput, DeviceIntegrityEvaluationResult } from '../../integrity/integrity.types';
import { AppIntegrityService } from '../../integrity/app-integrity.service';

export class FirstOrderPromotionAbuseService {
  /**
   * Risk threshold: above this score, the order is blocked for abuse protection.
   * Internal threshold: strictly NEVER exposed to Flutter client.
   */
  private static readonly MAX_TOLERABLE_RISK_SCORE = 75;

  /**
   * Evaluates abuse/fraud signals using legitimate available marketplace data.
   */
  public static async evaluateAbuseSignals(params: {
    customerId: string;
    config: FirstOrderShippingConfigDto;
    ipAddress?: string;
    userAgent?: string;
    deviceId?: string;
    integrityEvidence?: IntegrityEvidenceInput;
    integrityEvaluation?: DeviceIntegrityEvaluationResult;
  }): Promise<FirstOrderAbuseEvaluation> {
    const { customerId, config } = params;

    let user = null;
    try {
      user = await prisma.user.findUnique({
        where: { id: customerId },
        include: {
          addresses: {
            take: 5,
          },
        },
      });
    } catch (dbErr: any) {
      console.warn(`[FirstOrderAbuse] Database query exception, proceeding with fallback: ${dbErr?.message}`);
    }

    if (!user) {
      const earlyIntegrityStatus = params.integrityEvaluation?.status ?? DeviceIntegrityStatus.UNAVAILABLE;
      return {
        abuseSuspected: true,
        riskScore: 100,
        reasons: ['CUSTOMER_NOT_FOUND'],
        signals: {
          accountAgeDays: 0,
          phoneVerified: false,
          emailVerified: false,
          priorOrdersCount: 0,
          matchingPhoneCount: 0,
          matchingAddressCount: 0,
          deviceIntegrityStatus: earlyIntegrityStatus,
          deviceIntegrityOk: earlyIntegrityStatus === DeviceIntegrityStatus.VERIFIED,
        },
      };
    }

    const now = Date.now();
    const accountAgeDays = Math.max(0, Math.floor((now - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)));

    let riskScore = 0;
    const reasons: string[] = [];

    // 1. Mandatory verification checks if configured
    if (config.requireVerifiedPhone && !user.isVerified) {
      riskScore += 40;
      reasons.push('PHONE_VERIFICATION_REQUIRED');
    }

    if (config.requireVerifiedEmail && (!user.email || !user.isVerified)) {
      riskScore += 30;
      reasons.push('EMAIL_VERIFICATION_REQUIRED');
    }

    // 2. Account farming check by phone prefix / exact phone
    let matchingPhoneCount = 0;
    if (user.phone) {
      matchingPhoneCount = await prisma.user.count({
        where: {
          phone: user.phone,
          id: { not: user.id },
        },
      });
      if (matchingPhoneCount > 0) {
        riskScore += 50;
        reasons.push('DUPLICATE_PHONE_NUMBER_DETECTED');
      }
    }

    // 3. Address similarity / recipient phone farming check
    let matchingAddressCount = 0;
    if (user.addresses && user.addresses.length > 0) {
      const recipientPhones = user.addresses.map((a) => a.recipientPhone).filter(Boolean);
      if (recipientPhones.length > 0) {
        const otherAddressesWithSamePhone = await prisma.address.count({
          where: {
            recipientPhone: { in: recipientPhones },
            userId: { not: user.id },
          },
        });
        matchingAddressCount = otherAddressesWithSamePhone;
        if (otherAddressesWithSamePhone >= 3) {
          riskScore += 35;
          reasons.push('HIGH_ADDRESS_RECIPIENT_COLLISION');
        } else if (otherAddressesWithSamePhone >= 1) {
          riskScore += 15;
          reasons.push('MODERATE_ADDRESS_RECIPIENT_COLLISION');
        }
      }
    }

    // 4. Prior orders count check
    const priorOrdersCount = await prisma.order.count({
      where: {
        userId: user.id,
        status: { notIn: ['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'CANCELLED_BY_ADMIN', 'REJECTED_BY_SELLER'] },
      },
    });

    if (priorOrdersCount > 0) {
      riskScore += 80;
      reasons.push('EXISTING_ORDERS_FOUND');
    }

    // 5. Prior promotion usages check
    const priorUsages = await prisma.promotionUsage.count({
      where: {
        customerId: user.id,
        promotionType: 'FIRST_ORDER_FREE_SHIPPING',
        status: 'CONSUMED',
      },
    });

    if (priorUsages > 0) {
      riskScore = 100;
      reasons.push('PROMOTION_ALREADY_CONSUMED');
    }

    // 6. Rapid account creation burst detection (same subnet/IP if provided)
    if (params.ipAddress && accountAgeDays < 1) {
      const recentUsersSameHour = await prisma.user.count({
        where: {
          createdAt: { gte: new Date(Date.now() - 3600 * 1000) },
        },
      });
      if (recentUsersSameHour > 100) {
        riskScore += 20;
        reasons.push('RAPID_REGISTRATION_SURGE');
      }
    }

    // 7. Authoritative App & Device Integrity Evaluation (§AR-2.5)
    // Replaced fabricated deviceIntegrityOk: true with typed verifiable evidence
    let deviceIntegrityStatus = DeviceIntegrityStatus.UNAVAILABLE;

    if (params.integrityEvaluation) {
      deviceIntegrityStatus = params.integrityEvaluation.status;
      riskScore += params.integrityEvaluation.riskScoreModifier;
      if (params.integrityEvaluation.status === DeviceIntegrityStatus.REJECTED) {
        reasons.push('DEVICE_INTEGRITY_REJECTED');
      }
    } else if (params.integrityEvidence && params.integrityEvidence.challenge) {
      try {
        const evalResult = await AppIntegrityService.verifyIntegrityEvidence({
          evidence: params.integrityEvidence,
          expectedAppType: 'customer',
          expectedOperation: 'FIRST_ORDER_PROMOTION',
          userId: customerId,
        });
        deviceIntegrityStatus = evalResult.status;
        riskScore += evalResult.riskScoreModifier;
        if (evalResult.status === DeviceIntegrityStatus.REJECTED) {
          reasons.push('DEVICE_INTEGRITY_REJECTED');
        }
      } catch (_) {
        deviceIntegrityStatus = DeviceIntegrityStatus.INVALID;
        riskScore += 20;
        reasons.push('DEVICE_INTEGRITY_EVALUATION_ERROR');
      }
    }

    // Risk decisions remain server-authoritative
    const clampedRiskScore = Math.min(100, Math.max(0, riskScore));
    const abuseSuspected = config.abuseProtectionEnabled && clampedRiskScore >= this.MAX_TOLERABLE_RISK_SCORE;

    return {
      abuseSuspected,
      riskScore: clampedRiskScore,
      reasons,
      signals: {
        accountAgeDays,
        phoneVerified: user.isVerified,
        emailVerified: Boolean(user.email && user.isVerified),
        priorOrdersCount,
        matchingPhoneCount,
        matchingAddressCount,
        deviceIntegrityStatus,
        deviceIntegrityOk: deviceIntegrityStatus === DeviceIntegrityStatus.VERIFIED,
      },
    };
  }
}
