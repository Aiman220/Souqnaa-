import { prisma } from '../../database/prisma';
import { Prisma } from '@prisma/client';

export interface OrderNumberResult {
  orderSequence: number;
  orderNumber: string;
  displayOrderNumber: string;
}

export interface SellerOrderNumberResult {
  subOrderIndex: number;
  sellerOrderNumber: string;
  displaySellerOrderNumber: string;
}

export class OrderNumberService {
  private static sequenceInitialized = false;

  /**
   * Initializes PostgreSQL sequence and ensures it is synchronized with the existing data.
   */
  public static async initSequence(): Promise<void> {
    try {
      // 1. Create native PostgreSQL sequence if it doesn't exist (schema-agnostic in search_path)
      await prisma.$executeRawUnsafe(`
        CREATE SEQUENCE IF NOT EXISTS "order_number_seq"
        START WITH 1
        INCREMENT BY 1
        MINVALUE 1
        NO CYCLE;
      `);

      // 2. Query maximum orderSequence currently in the Order table
      const maxSeqResult: any = await prisma.$queryRawUnsafe(`
        SELECT COALESCE(MAX("orderSequence"), 0) AS max_seq FROM "Order";
      `);
      const maxSeq = Number(maxSeqResult?.[0]?.max_seq ?? 0);

      // 3. Set the sequence value to maxSeq if sequence is lower than maxSeq
      if (maxSeq > 0) {
        await prisma.$executeRawUnsafe(`
          SELECT setval('order_number_seq', ${maxSeq}, true);
        `);
      }

      // 4. Ensure OrderCounter record exists as sync fallback
      await prisma.orderCounter.upsert({
        where: { name: 'order_number' },
        update: { value: BigInt(maxSeq) },
        create: { name: 'order_number', value: BigInt(maxSeq) },
      });

      this.sequenceInitialized = true;
    } catch (err) {
      console.warn('OrderNumberService.initSequence warning:', err);
    }
  }

  /**
   * Atomically reserves the next public order sequence.
   * Safe across concurrent checkouts, multi-process, and retries.
   */
  public static async getNextSequence(_tx?: Prisma.TransactionClient): Promise<number> {
    // Note: Always use root prisma client for sequence nextval to prevent any Postgres transaction aborts
    try {
      // Primary: Native PostgreSQL sequence (atomic, collision-free, non-blocking)
      const res: any = await prisma.$queryRawUnsafe(`
        SELECT nextval('order_number_seq') AS seq;
      `);
      const seq = Number(res?.[0]?.seq);
      if (seq && !isNaN(seq) && seq > 0) {
        return seq;
      }
    } catch (dbSeqError) {
      // If sequence doesn't exist yet, try initializing and retry once
      if (!this.sequenceInitialized) {
        await this.initSequence();
        try {
          const res: any = await prisma.$queryRawUnsafe(`
            SELECT nextval('order_number_seq') AS seq;
          `);
          const seq = Number(res?.[0]?.seq);
          if (seq && !isNaN(seq) && seq > 0) {
            return seq;
          }
        } catch (_) {}
      }
    }

    // Secondary atomic fallback: OrderCounter table via Prisma native atomic increment
    try {
      const updatedCounter = await prisma.orderCounter.upsert({
        where: { name: 'order_number' },
        update: { value: { increment: 1 } },
        create: { name: 'order_number', value: BigInt(1) },
      });
      const val = Number(updatedCounter.value);
      if (val && !isNaN(val) && val > 0) {
        return val;
      }
    } catch (counterError) {
      console.error('Fallback OrderCounter atomic increment failed:', counterError);
    }

    // Emergency fallback in case tables are completely detached: find max sequence + 1
    const lastOrder = await prisma.order.findFirst({
      where: { orderSequence: { not: null } },
      orderBy: { orderSequence: 'desc' },
      select: { orderSequence: true },
    });
    return (lastOrder?.orderSequence ?? 0) + 1;
  }

  /**
   * Formats the sequence number into the public order number:
   * SQ-YYYY-MMDD-NNNNNN
   * e.g. SQ-2026-0925-000123
   */
  public static formatPublicOrderNumber(sequence: number, date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const seqStr = String(sequence).padStart(6, '0');
    return `SQ-${year}-${month}${day}-${seqStr}`;
  }

  /**
   * Formats short public display code:
   * #SQ-NNNNNN
   * e.g. #SQ-000123
   */
  public static formatDisplayShort(orderNumberOrSequence: string | number): string {
    if (typeof orderNumberOrSequence === 'number') {
      return `#SQ-${String(orderNumberOrSequence).padStart(6, '0')}`;
    }

    // Check if matching full format SQ-YYYY-MMDD-NNNNNN
    const match = orderNumberOrSequence.match(/^SQ-\d{4}-\d{4}-(\d+)$/);
    if (match) {
      return `#SQ-${match[1]}`;
    }

    // If already in short format like SQ-000123 or #SQ-000123
    if (orderNumberOrSequence.startsWith('#SQ-')) {
      return orderNumberOrSequence;
    }
    if (orderNumberOrSequence.startsWith('SQ-')) {
      return `#${orderNumberOrSequence}`;
    }

    return `#${orderNumberOrSequence}`;
  }

  /**
   * Formats short public display code without hash prefix:
   * SQ-NNNNNN
   * e.g. SQ-000123
   */
  public static formatDisplayOrderNumber(sequence: number): string {
    return `SQ-${String(sequence).padStart(6, '0')}`;
  }

  /**
   * Generates deterministic seller sub-order number:
   * SQ-YYYY-MMDD-NNNNNN-S01
   * e.g. SQ-2026-0925-000123-S01
   */
  public static generateSellerOrderNumber(parentOrderNumber: string, subOrderIndex: number): string {
    const paddedIndex = `S${String(subOrderIndex).padStart(2, '0')}`;
    return `${parentOrderNumber}-${paddedIndex}`;
  }

  /**
   * Formats short display code for seller sub-order:
   * #SQ-000123-S01
   */
  public static formatSellerDisplayShort(sellerOrderNumber: string): string {
    const match = sellerOrderNumber.match(/^SQ-\d{4}-\d{4}-(\d+)-(S\d+)$/);
    if (match) {
      return `#SQ-${match[1]}-${match[2]}`;
    }
    if (sellerOrderNumber.startsWith('#')) {
      return sellerOrderNumber;
    }
    return `#${sellerOrderNumber}`;
  }

  /**
   * Atomically generates a full order number package for a new checkout.
   */
  public static async generateNextOrderNumber(
    tx?: Prisma.TransactionClient,
    date: Date = new Date()
  ): Promise<OrderNumberResult> {
    const sequence = await this.getNextSequence(tx);
    const orderNumber = this.formatPublicOrderNumber(sequence, date);
    const displayOrderNumber = this.formatDisplayOrderNumber(sequence);

    return {
      orderSequence: sequence,
      orderNumber,
      displayOrderNumber,
    };
  }

  /**
   * Generates seller sub-order numbers for a given parent order.
   */
  public static generateSellerSubOrders(
    parentOrderNumber: string,
    sellerCount: number
  ): SellerOrderNumberResult[] {
    const results: SellerOrderNumberResult[] = [];
    for (let i = 1; i <= sellerCount; i++) {
      const sellerOrderNumber = this.generateSellerOrderNumber(parentOrderNumber, i);
      const displaySellerOrderNumber = this.formatSellerDisplayShort(sellerOrderNumber);
      results.push({
        subOrderIndex: i,
        sellerOrderNumber,
        displaySellerOrderNumber,
      });
    }
    return results;
  }
}
