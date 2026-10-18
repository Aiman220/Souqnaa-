/**
 * SOUQNAA Marketplace — Statement Numbering Service
 * Database-backed, atomic, concurrency-safe, immutable sequence generator.
 * Formats:
 * - SQ-SELL-STMT-YYYY-XXXXXX (Seller Statement)
 * - SQ-SET-STMT-YYYY-XXXXXX (Settlement Statement)
 * - SQ-COM-STMT-YYYY-XXXXXX (Commission Statement)
 * - SQ-TAX-STMT-YYYY-XXXXXX (Tax Statement)
 */

import { prisma } from '../../database/prisma';
import { StatementType } from '@prisma/client';

export class StatementNumberService {
  private static readonly PREFIXES: Record<StatementType, string> = {
    SELLER_STATEMENT: 'SQ-SELL-STMT',
    SETTLEMENT_STATEMENT: 'SQ-SET-STMT',
    COMMISSION_STATEMENT: 'SQ-COM-STMT',
    TAX_STATEMENT: 'SQ-TAX-STMT',
  };

  /**
   * Generates a unique, atomic, concurrency-safe statement number within a database transaction.
   */
  public static async generateNextNumber(statementType: StatementType, year?: number): Promise<string> {
    const currentYear = year || new Date().getFullYear();
    const prefix = this.PREFIXES[statementType] || 'SQ-STMT';

    // Use direct atomic upsert with increment for strict concurrency safety in PostgreSQL
    const seq = await prisma.statementSequence.upsert({
      where: {
        statementType_year: {
          statementType,
          year: currentYear,
        },
      },
      create: {
        statementType,
        year: currentYear,
        currentValue: 1,
      },
      update: {
        currentValue: {
          increment: 1,
        },
      },
    });

    const sequenceFormatted = String(seq.currentValue).padStart(6, '0');
    return `${prefix}-${currentYear}-${sequenceFormatted}`;
  }

  /**
   * Parses statement type and year from a statement number string.
   */
  public static parseStatementNumber(statementNumber: string): {
    prefix: string;
    year: number;
    sequence: number;
    isValid: boolean;
  } {
    const parts = statementNumber.split('-');
    if (parts.length < 5) {
      return { prefix: '', year: 0, sequence: 0, isValid: false };
    }

    const prefix = `${parts[0]}-${parts[1]}-${parts[2]}`;
    const year = parseInt(parts[3], 10);
    const sequence = parseInt(parts[4], 10);

    return {
      prefix,
      year: isNaN(year) ? 0 : year,
      sequence: isNaN(sequence) ? 0 : sequence,
      isValid: !isNaN(year) && !isNaN(sequence),
    };
  }
}
