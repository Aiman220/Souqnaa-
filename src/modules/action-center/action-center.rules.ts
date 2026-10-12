import {
  CustomerAction,
  CustomerActionPriority,
} from './action-center.types';

export class ActionCenterRulesEngine {
  private static readonly PRIORITY_WEIGHTS: Record<CustomerActionPriority, number> = {
    [CustomerActionPriority.CRITICAL]: 400,
    [CustomerActionPriority.HIGH]: 300,
    [CustomerActionPriority.MEDIUM]: 200,
    [CustomerActionPriority.LOW]: 100,
  };

  /**
   * Returns numeric priority weight for sorting.
   */
  public static getPriorityWeight(priority: CustomerActionPriority): number {
    return this.PRIORITY_WEIGHTS[priority] ?? 100;
  }

  /**
   * Filters out expired actions.
   */
  public static filterExpired(actions: CustomerAction[], referenceDate: Date = new Date()): CustomerAction[] {
    const nowTime = referenceDate.getTime();
    return actions.filter((action) => {
      if (!action.expiresAt) return true;
      const expireTime = new Date(action.expiresAt).getTime();
      return expireTime > nowTime;
    });
  }

  /**
   * Deduplicates actions based on deduplicationKey.
   * If duplicates exist, keeps the one with the highest priority and latest update.
   */
  public static deduplicate(actions: CustomerAction[]): CustomerAction[] {
    const keyMap = new Map<string, CustomerAction>();

    for (const action of actions) {
      const key = action.deduplicationKey || action.id;
      const existing = keyMap.get(key);

      if (!existing) {
        keyMap.set(key, action);
      } else {
        const existingWeight = this.getPriorityWeight(existing.priority);
        const newWeight = this.getPriorityWeight(action.priority);

        if (newWeight > existingWeight) {
          keyMap.set(key, action);
        } else if (newWeight === existingWeight) {
          const existingTime = new Date(existing.updatedAt || existing.createdAt).getTime();
          const newTime = new Date(action.updatedAt || action.createdAt).getTime();
          if (newTime > existingTime) {
            keyMap.set(key, action);
          }
        }
      }
    }

    return Array.from(keyMap.values());
  }

  /**
   * Deterministically sorts actions according to business requirements:
   * 1. Criticality / Priority (CRITICAL > HIGH > MEDIUM > LOW)
   * 2. Expiration urgency (actions with near-future expiration rank higher within same priority)
   * 3. Action creation / update time
   */
  public static sortActions(actions: CustomerAction[]): CustomerAction[] {
    const now = Date.now();

    return [...actions].sort((a, b) => {
      // 1. Priority
      const weightA = this.getPriorityWeight(a.priority);
      const weightB = this.getPriorityWeight(b.priority);
      if (weightA !== weightB) {
        return weightB - weightA; // higher weight first
      }

      // 2. Expiration Urgency (closer expiration first if within 7 days)
      if (a.expiresAt && b.expiresAt) {
        const expA = new Date(a.expiresAt).getTime();
        const expB = new Date(b.expiresAt).getTime();
        if (expA !== expB) {
          return expA - expB; // earlier expiration first
        }
      } else if (a.expiresAt && !b.expiresAt) {
        return -1; // action with expiration prioritized over infinite
      } else if (!a.expiresAt && b.expiresAt) {
        return 1;
      }

      // 3. Recency
      const timeA = new Date(a.updatedAt || a.createdAt).getTime();
      const timeB = new Date(b.updatedAt || b.createdAt).getTime();
      return timeB - timeA;
    });
  }
}
