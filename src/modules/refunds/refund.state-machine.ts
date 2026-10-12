import { RefundStatus, RefundActorType } from '@prisma/client';
import { AppError } from '../../middleware/error.middleware';

/**
 * Authoritative Production Refund State Machine
 *
 * Strict Valid Transitions:
 * SUBMITTED → [UNDER_SELLER_REVIEW, CANCELLED]
 * UNDER_SELLER_REVIEW → [SELLER_ACCEPTED, SELLER_REJECTED, CANCELLED]
 * SELLER_ACCEPTED → [CUSTOMER_ACCEPTED, CUSTOMER_DISPUTED]
 * SELLER_REJECTED → [CUSTOMER_DISPUTED, CLOSED]
 * CUSTOMER_ACCEPTED → [REFUND_PENDING]
 * CUSTOMER_DISPUTED → [ADMIN_REVIEW]
 * ADMIN_REVIEW → [ADMIN_APPROVED, ADMIN_REJECTED, CLOSED]
 * ADMIN_APPROVED → [REFUND_PENDING]
 * REFUND_PENDING → [REFUND_PROCESSING]
 * REFUND_PROCESSING → [REFUND_COMPLETED, REFUND_FAILED]
 * REFUND_FAILED → [REFUND_PROCESSING, CLOSED]
 *
 * Terminal States: [REFUND_COMPLETED, CLOSED, CANCELLED]
 */

export const ALLOWED_REFUND_TRANSITIONS: Record<RefundStatus, RefundStatus[]> = {
  [RefundStatus.DRAFT]: [RefundStatus.SUBMITTED, RefundStatus.CANCELLED],
  [RefundStatus.SUBMITTED]: [
    RefundStatus.UNDER_SELLER_REVIEW,
    RefundStatus.CANCELLED,
    RefundStatus.ADMIN_REVIEW, // High-value auto-escalation
  ],
  [RefundStatus.UNDER_SELLER_REVIEW]: [
    RefundStatus.SELLER_ACCEPTED,
    RefundStatus.SELLER_REJECTED,
    RefundStatus.CANCELLED,
    RefundStatus.ADMIN_REVIEW,
  ],
  [RefundStatus.SELLER_ACCEPTED]: [
    RefundStatus.CUSTOMER_ACCEPTED,
    RefundStatus.CUSTOMER_DISPUTED,
  ],
  [RefundStatus.SELLER_REJECTED]: [
    RefundStatus.CUSTOMER_DISPUTED,
    RefundStatus.CLOSED,
  ],
  [RefundStatus.CUSTOMER_ACCEPTED]: [
    RefundStatus.REFUND_PENDING,
  ],
  [RefundStatus.CUSTOMER_DISPUTED]: [
    RefundStatus.ADMIN_REVIEW,
  ],
  [RefundStatus.ADMIN_REVIEW]: [
    RefundStatus.ADMIN_APPROVED,
    RefundStatus.ADMIN_REJECTED,
    RefundStatus.APPROVED,
    RefundStatus.REJECTED,
    RefundStatus.CLOSED,
  ],
  [RefundStatus.ADMIN_APPROVED]: [
    RefundStatus.REFUND_PENDING,
  ],
  [RefundStatus.ADMIN_REJECTED]: [
    RefundStatus.CLOSED,
  ],
  [RefundStatus.REFUND_PENDING]: [
    RefundStatus.REFUND_PROCESSING,
  ],
  [RefundStatus.REFUND_PROCESSING]: [
    RefundStatus.REFUND_COMPLETED,
    RefundStatus.REFUNDED,
    RefundStatus.REFUND_FAILED,
  ],
  [RefundStatus.REFUND_FAILED]: [
    RefundStatus.REFUND_PROCESSING,
    RefundStatus.CLOSED,
  ],
  [RefundStatus.EXPIRED]: [],
  [RefundStatus.REFUND_COMPLETED]: [],
  [RefundStatus.CLOSED]: [],
  [RefundStatus.CANCELLED]: [],

  // Legacy mappings for backwards compatibility
  [RefundStatus.REQUESTED]: [
    RefundStatus.UNDER_SELLER_REVIEW,
    RefundStatus.SELLER_REVIEW,
    RefundStatus.CANCELLED,
    RefundStatus.ADMIN_REVIEW,
  ],
  [RefundStatus.SELLER_REVIEW]: [
    RefundStatus.SELLER_ACCEPTED,
    RefundStatus.SELLER_REJECTED,
    RefundStatus.APPROVED,
    RefundStatus.REJECTED,
  ],
  [RefundStatus.APPROVED]: [
    RefundStatus.REFUND_PENDING,
    RefundStatus.REFUND_PROCESSING,
    RefundStatus.REFUNDED,
  ],
  [RefundStatus.REFUNDED]: [],
  [RefundStatus.REJECTED]: [
    RefundStatus.DISPUTED,
    RefundStatus.CUSTOMER_DISPUTED,
    RefundStatus.CLOSED,
  ],
  [RefundStatus.DISPUTED]: [
    RefundStatus.ADMIN_REVIEW,
    RefundStatus.CLOSED,
  ],
};

export const PERMITTED_ROLE_TRANSITIONS: Record<RefundActorType, Record<string, RefundStatus[]>> = {
  [RefundActorType.CUSTOMER]: {
    [RefundStatus.SUBMITTED]: [RefundStatus.CANCELLED],
    [RefundStatus.REQUESTED]: [RefundStatus.CANCELLED],
    [RefundStatus.SELLER_ACCEPTED]: [RefundStatus.CUSTOMER_ACCEPTED, RefundStatus.CUSTOMER_DISPUTED],
    [RefundStatus.SELLER_REJECTED]: [RefundStatus.CUSTOMER_DISPUTED, RefundStatus.CLOSED],
    [RefundStatus.REJECTED]: [RefundStatus.DISPUTED, RefundStatus.CLOSED],
  },
  [RefundActorType.SELLER]: {
    [RefundStatus.SUBMITTED]: [RefundStatus.UNDER_SELLER_REVIEW],
    [RefundStatus.REQUESTED]: [RefundStatus.SELLER_REVIEW],
    [RefundStatus.UNDER_SELLER_REVIEW]: [RefundStatus.SELLER_ACCEPTED, RefundStatus.SELLER_REJECTED],
    [RefundStatus.SELLER_REVIEW]: [RefundStatus.APPROVED, RefundStatus.REJECTED],
  },
  [RefundActorType.ADMIN]: {
    [RefundStatus.SUBMITTED]: [RefundStatus.ADMIN_REVIEW, RefundStatus.CANCELLED],
    [RefundStatus.UNDER_SELLER_REVIEW]: [RefundStatus.ADMIN_REVIEW, RefundStatus.CANCELLED],
    [RefundStatus.CUSTOMER_DISPUTED]: [RefundStatus.ADMIN_REVIEW],
    [RefundStatus.DISPUTED]: [RefundStatus.ADMIN_REVIEW, RefundStatus.CLOSED],
    [RefundStatus.ADMIN_REVIEW]: [
      RefundStatus.ADMIN_APPROVED,
      RefundStatus.ADMIN_REJECTED,
      RefundStatus.APPROVED,
      RefundStatus.REJECTED,
      RefundStatus.CLOSED,
    ],
    [RefundStatus.REFUND_PENDING]: [RefundStatus.REFUND_PROCESSING],
    [RefundStatus.REFUND_FAILED]: [RefundStatus.REFUND_PROCESSING, RefundStatus.CLOSED],
  },
  [RefundActorType.SYSTEM]: {
    [RefundStatus.SUBMITTED]: [RefundStatus.UNDER_SELLER_REVIEW, RefundStatus.EXPIRED],
    [RefundStatus.CUSTOMER_ACCEPTED]: [RefundStatus.REFUND_PENDING],
    [RefundStatus.ADMIN_APPROVED]: [RefundStatus.REFUND_PENDING],
    [RefundStatus.REFUND_PENDING]: [RefundStatus.REFUND_PROCESSING],
    [RefundStatus.REFUND_PROCESSING]: [RefundStatus.REFUND_COMPLETED, RefundStatus.REFUND_FAILED],
    [RefundStatus.APPROVED]: [RefundStatus.REFUND_PROCESSING, RefundStatus.REFUNDED],
  },
};

export class RefundStateMachine {
  /**
   * Check if transition from currentStatus to targetStatus is valid in the graph.
   */
  static isValidTransition(currentStatus: RefundStatus, targetStatus: RefundStatus): boolean {
    const allowed = ALLOWED_REFUND_TRANSITIONS[currentStatus] || [];
    return allowed.includes(targetStatus);
  }

  /**
   * Check if a specific actor role is authorized to perform this transition.
   */
  static isAuthorized(
    currentStatus: RefundStatus,
    targetStatus: RefundStatus,
    actorType: RefundActorType
  ): boolean {
    if (actorType === RefundActorType.ADMIN || actorType === RefundActorType.SYSTEM) {
      return this.isValidTransition(currentStatus, targetStatus);
    }

    const roleTransitions = PERMITTED_ROLE_TRANSITIONS[actorType]?.[currentStatus] || [];
    return roleTransitions.includes(targetStatus);
  }

  /**
   * Validate and assert transition, throwing AppError if invalid or unauthorized.
   */
  static validateTransition(
    currentStatus: RefundStatus,
    targetStatus: RefundStatus,
    actorType: RefundActorType
  ): void {
    if (!this.isValidTransition(currentStatus, targetStatus)) {
      throw new AppError(
        `لا يمكن تحويل حالة طلب الاسترجاع من [${currentStatus}] إلى [${targetStatus}]`,
        422
      );
    }

    if (!this.isAuthorized(currentStatus, targetStatus, actorType)) {
      throw new AppError(
        `غير مصرح لهذا الدور (${actorType}) بتغيير حالة الطلب إلى [${targetStatus}]`,
        403
      );
    }
  }

  /**
   * Generates mutually exclusive actions available to the given actor for UI rendering.
   */
  static getAvailableActions(status: RefundStatus, actorType: RefundActorType): string[] {
    const actions: string[] = [];

    switch (actorType) {
      case RefundActorType.CUSTOMER:
        if (status === RefundStatus.SELLER_REJECTED || status === RefundStatus.REJECTED) {
          actions.push('CUSTOMER_ACCEPT', 'CUSTOMER_DISPUTE');
        } else if (status === RefundStatus.SUBMITTED || status === RefundStatus.REQUESTED) {
          actions.push('CUSTOMER_CANCEL');
        }
        break;

      case RefundActorType.SELLER:
        if (
          status === RefundStatus.SUBMITTED ||
          status === RefundStatus.UNDER_SELLER_REVIEW ||
          status === RefundStatus.REQUESTED ||
          status === RefundStatus.SELLER_REVIEW
        ) {
          actions.push('SELLER_ACCEPT', 'SELLER_REJECT');
        }
        break;

      case RefundActorType.ADMIN:
        if (
          status === RefundStatus.ADMIN_REVIEW ||
          status === RefundStatus.CUSTOMER_DISPUTED ||
          status === RefundStatus.DISPUTED
        ) {
          actions.push('ADMIN_APPROVE', 'ADMIN_REJECT', 'ADMIN_ADJUST');
        }
        if (status === RefundStatus.REFUND_PENDING) {
          actions.push('ADMIN_EXECUTE');
        }
        break;
    }

    return actions;
  }

  /**
   * Returns true if status is terminal (cannot change further).
   */
  static isTerminal(status: RefundStatus): boolean {
    return (
      status === RefundStatus.REFUND_COMPLETED ||
      status === RefundStatus.REFUNDED ||
      status === RefundStatus.CLOSED ||
      status === RefundStatus.CANCELLED ||
      status === RefundStatus.EXPIRED
    );
  }
}
