/**
 * SOUQNAA Marketplace — Statement Export Service
 * Exports finalized statement snapshot data to fully localized Arabic CSV
 * with UTF-8 BOM encoding for seamless display in Microsoft Excel and spreadsheet tools.
 * 
 * Supports specialized layouts for:
 * - SELLER_STATEMENT (كشف حساب التاجر الشامل)
 * - SETTLEMENT_STATEMENT (كشف التسويات المالية والمدفوعات)
 * - COMMISSION_STATEMENT (كشف عمولات منصة سوقناا)
 * - TAX_STATEMENT (كشف الإقرار الضريبي والضريبة المضافة)
 */

import {
  StatementSnapshotDto,
  StatementType,
  StatementLineType,
  StatementStatus,
  StatementLineItemDto,
} from './statement.types';

export class StatementExportService {
  /**
   * Title mapping in Arabic
   */
  private static readonly STATEMENT_TITLES: Record<StatementType, string> = {
    [StatementType.SELLER_STATEMENT]: 'كشف حساب التاجر المالي الشامل',
    [StatementType.SETTLEMENT_STATEMENT]: 'كشف التسوية المالية والمدفوعات للبائع',
    [StatementType.COMMISSION_STATEMENT]: 'كشف عمولات منصة سوقناا',
    [StatementType.TAX_STATEMENT]: 'كشف الإقرار الضريبي وضريبة القيمة المضافة',
  };

  /**
   * Line Item type translations in Arabic
   */
  private static readonly LINE_TYPE_MAP: Record<string, string> = {
    [StatementLineType.SALE]: 'مبيعات طلب',
    [StatementLineType.DISCOUNT]: 'خصم منتجات وعروض',
    [StatementLineType.REFUND]: 'استرجاع مالي / مرتجع',
    [StatementLineType.TAX]: 'ضريبة قيمة مضافة',
    [StatementLineType.COMMISSION]: 'عمولة منصة سوقناا',
    [StatementLineType.ADJUSTMENT]: 'تسوية مالية معتمدة',
    [StatementLineType.SETTLEMENT_PAYOUT]: 'صرف تسوية دورية',
    [StatementLineType.WITHDRAWAL]: 'سحب رصيد بنكي',
    [StatementLineType.FEE]: 'رسوم إدارية وبنكية',
  };

  /**
   * Status translations in Arabic
   */
  private static readonly STATUS_MAP: Record<string, string> = {
    [StatementStatus.DRAFT]: 'مسودة أولية',
    [StatementStatus.GENERATING]: 'قيد المعالجة والتوليد',
    [StatementStatus.READY]: 'جاهز للاعتماد',
    [StatementStatus.FINALIZED]: 'معتمد ونهائي',
    [StatementStatus.FAILED]: 'تعذر التوليد',
    [StatementStatus.SUPERSEDED]: 'ملغى ومستبدل',
    SETTLED: 'مسوى ومصروف',
    PENDING: 'قيد المعالجة',
    COMPLETED: 'مكتمل بنجاح',
  };

  /**
   * Comprehensive summary keys dictionary in Arabic
   */
  private static readonly SUMMARY_KEYS_AR: Record<string, string> = {
    // Seller Statement
    openingBalance: 'الرصيد الافتتاحي',
    grossSales: 'إجمالي المبيعات',
    productDiscounts: 'خصومات المنتجات والعروض',
    refunds: 'المبالغ المسترجعة (المرتجعات)',
    tax: 'الضريبة المحصلة',
    platformCommission: 'عمولة المنصة',
    paymentFees: 'رسوم بوابات الدفع والمعالجة',
    deliveryAdjustments: 'بدلات ورسوم التوصيل',
    otherAuthorizedAdjustments: 'تسويات إدارية أخرى معتمدة',
    withdrawals: 'السحوبات المنفذة للحساب البنكي',
    deposits: 'الإيداعات الإضافية',
    netActivity: 'صافي الحركة المالية للفترة',
    closingBalance: 'الرصيد الختامي المستحق للتاجر',
    totalOrdersCount: 'إجمالي عدد الطلبات',
    totalRefundsCount: 'إجمالي عدد المرتجعات',

    // Settlement Statement
    settlementNumber: 'رقم دورة التسوية',
    settlementId: 'معرف التسوية بالنظام',
    settlementDate: 'تاريخ الصرف والتحويل',
    authorizedAdjustments: 'تسويات معتمدة بالدورة',
    taxAdjustments: 'تسويات الضرائب والرسوم',
    netSettlement: 'صافي مبلغ التسوية المستحق للصرف',
    settlementStatus: 'حالة دورة التسوية',
    paymentReference: 'رقم المرجع البنكي / الحوالة',

    // Commission Statement
    eligibleSales: 'المبيعات الخاضعة لاحتساب العمولة',
    commissionBase: 'وعاء احتساب العمولة',
    effectiveCommissionRate: 'متوسط نسبة العمولة الفعلية (%)',
    commissionAmount: 'مبلغ عمولة المنصة الأساسي',
    commissionAdjustments: 'تسويات العمولة',
    taxOnCommission: 'ضريبة القيمة المضافة على العمولة',
    totalCommission: 'إجمالي عمولة المنصة المستحقة',

    // Tax Statement
    grossTaxableSales: 'المبيعات الخاضعة للضريبة',
    taxExemptSales: 'المبيعات المعفاة من الضريبة',
    zeroRatedSales: 'المبيعات ذات النسبة الصفرية (0%)',
    taxableAmount: 'الوعاء الضريبي الصافي',
    taxCollected: 'إجمالي الضريبة المحصلة',
    taxRefunded: 'ضريبة المبيعات المستردة',
    netTax: 'صافي الضريبة المستحقة للإقرار',
    totalTransactionsCount: 'إجمالي عدد المعاملات الضريبية',
  };

  /**
   * Safely formats and escapes a CSV cell
   */
  private static escapeCell(value: any): string {
    if (value === null || value === undefined) {
      return '""';
    }
    let str = String(value).trim();
    // Protect against CSV formula injection while preserving pure numbers
    const isPureNumber = typeof value === 'number' || (!isNaN(Number(str)) && !str.includes(' '));
    if (!isPureNumber && /^[=+\-@\t\r]/.test(str)) {
      str = `'${str}`;
    }
    // Escape quotes
    return `"${str.replace(/"/g, '""')}"`;
  }

  /**
   * Formats decimal numbers to standard currency string (2 decimals)
   */
  private static formatNumber(val: number | null | undefined): string {
    if (val === null || val === undefined || isNaN(Number(val))) {
      return '0.00';
    }
    return Number(val).toFixed(2);
  }

  /**
   * Formats currency representation to official Yemeni Rial standard
   */
  public static formatCurrency(curr?: string): string {
    if (!curr) return 'ر.ي';
    const c = curr.trim().toUpperCase();
    if (c === 'YER' || c === 'ر.ي' || c === 'ريال يمني') {
      return 'ر.ي';
    }
    return 'ر.ي';
  }

  /**
   * Generates UTF-8 BOM CSV text for the statement lines and summary with specialized Arabic organization.
   */
  public static generateCsv(snapshot: StatementSnapshotDto): string {
    const BOM = '\uFEFF';
    const lines: string[] = [];

    const statementTitleAr =
      this.STATEMENT_TITLES[snapshot.statementType] || 'كشف الحساب المالي المعتمد';

    // ── 1. Document Title & Metadata Block in Arabic ──────────────────────────
    lines.push(this.escapeCell(`سوقناا — ${statementTitleAr}`));
    lines.push('');
    lines.push(`${this.escapeCell('رقم الكشف:')},${this.escapeCell(snapshot.statementNumber)}`);
    lines.push(`${this.escapeCell('نوع الكشف:')},${this.escapeCell(statementTitleAr)}`);
    lines.push(`${this.escapeCell('اسم المتجر / التاجر:')},${this.escapeCell(snapshot.metadata?.storeName || snapshot.metadata?.sellerName || snapshot.sellerId)}`);

    if (snapshot.metadata?.sellerTaxNumber) {
      lines.push(`${this.escapeCell('الرقم الضريبي للتاجر:')},${this.escapeCell(snapshot.metadata.sellerTaxNumber)}`);
    }
    if (snapshot.metadata?.sellerCrNumber) {
      lines.push(`${this.escapeCell('رقم السجل التجاري:')},${this.escapeCell(snapshot.metadata.sellerCrNumber)}`);
    }

    const startDateStr = new Date(snapshot.periodStart).toISOString().slice(0, 10);
    const endDateStr = new Date(snapshot.periodEnd).toISOString().slice(0, 10);
    lines.push(`${this.escapeCell('الفترة المالية:')},${this.escapeCell(`من ${startDateStr} إلى ${endDateStr}`)}`);
    lines.push(`${this.escapeCell('عملة الكشف:')},${this.escapeCell(this.formatCurrency(snapshot.currency))}`);
    lines.push(`${this.escapeCell('تاريخ الإصدار والاعتماد:')},${this.escapeCell(new Date(snapshot.createdAt).toISOString().replace('T', ' ').slice(0, 19))}`);
    
    if (snapshot.settlementId) {
      lines.push(`${this.escapeCell('مرجع التسوية المرتبطة:')},${this.escapeCell(snapshot.settlementId)}`);
    }
    lines.push('');

    // ── 2. Summary Section (الملخص المالي) ───────────────────────────────────
    lines.push(this.escapeCell('=== الملخص المالي الإجمالي ==='));
    lines.push(`${this.escapeCell('البند المالي')},${this.escapeCell('القيمة')},${this.escapeCell('العملة')}`);

    const summary = (snapshot.summary || {}) as Record<string, any>;
    for (const [key, val] of Object.entries(summary)) {
      const labelAr = this.SUMMARY_KEYS_AR[key] || key;
      if (typeof val === 'number') {
        // Special case for rate percentage
        if (key === 'effectiveCommissionRate') {
          lines.push(`${this.escapeCell(labelAr)},${this.escapeCell(`${(val * 100).toFixed(2)}%`)},${this.escapeCell('%')}`);
        } else {
          lines.push(`${this.escapeCell(labelAr)},${this.formatNumber(val)},${this.escapeCell(this.formatCurrency(snapshot.currency))}`);
        }
      } else if (val instanceof Date) {
        lines.push(`${this.escapeCell(labelAr)},${this.escapeCell(val.toISOString().slice(0, 10))},""`);
      } else if (val !== null && val !== undefined) {
        const translatedVal = this.STATUS_MAP[String(val)] || String(val);
        lines.push(`${this.escapeCell(labelAr)},${this.escapeCell(translatedVal)},""`);
      }
    }
    lines.push('');

    // ── 3. Transactions & Line Items Table (تفاصيل العمليات والبنود) ─────────
    lines.push(this.escapeCell('=== تفاصيل العمليات والبنود المالية ==='));

    switch (snapshot.statementType) {
      case StatementType.TAX_STATEMENT:
        this.appendTaxStatementTable(lines, snapshot);
        break;

      case StatementType.COMMISSION_STATEMENT:
        this.appendCommissionStatementTable(lines, snapshot);
        break;

      case StatementType.SETTLEMENT_STATEMENT:
        this.appendSettlementStatementTable(lines, snapshot);
        break;

      case StatementType.SELLER_STATEMENT:
      default:
        this.appendSellerStatementTable(lines, snapshot);
        break;
    }

    lines.push('');
    lines.push(this.escapeCell('تم إصدار هذا الكشف المالي رسمياً عبر منصة سوقناا وموثق رقمياً وفقاً للأنظمة المالية المعتمدة.'));

    return BOM + lines.join('\r\n');
  }

  /**
   * Table formatter for SELLER_STATEMENT (كشف حساب التاجر الشامل)
   */
  private static appendSellerStatementTable(lines: string[], snapshot: StatementSnapshotDto): void {
    const headers = [
      'م',
      'تاريخ المعاملة',
      'رقم المرجع / الطلب',
      'نوع البند',
      'البيان والتفاصيل',
      'المبلغ الإجمالي',
      'الخصم',
      'الضريبة',
      'عمولة المنصة',
      'صافي البند',
      'العملة',
      'الحالة',
    ];
    lines.push(headers.map((h) => this.escapeCell(h)).join(','));

    for (const li of snapshot.lineItems) {
      const typeAr = this.LINE_TYPE_MAP[li.type] || li.type;
      const statusAr = this.STATUS_MAP[li.status] || li.status;
      const dateStr = li.transactionDate ? new Date(li.transactionDate).toISOString().slice(0, 10) : '';

      const row = [
        li.lineIndex,
        this.escapeCell(dateStr),
        this.escapeCell(li.reference || li.orderId || '-'),
        this.escapeCell(typeAr),
        this.escapeCell(li.description || ''),
        this.formatNumber(li.grossAmount),
        this.formatNumber(li.discountAmount),
        this.formatNumber(li.taxAmount),
        this.formatNumber(li.commissionAmount),
        this.formatNumber(li.netAmount),
        this.escapeCell(this.formatCurrency(li.currency || snapshot.currency)),
        this.escapeCell(statusAr),
      ];
      lines.push(row.join(','));
    }
  }

  /**
   * Table formatter for SETTLEMENT_STATEMENT (كشف التسويات والمدفوعات)
   */
  private static appendSettlementStatementTable(lines: string[], snapshot: StatementSnapshotDto): void {
    const headers = [
      'م',
      'تاريخ الطلب',
      'رقم الطلب / المرجع',
      'البيان',
      'إجمالي المبيعات',
      'الخصومات المطبقة',
      'الاسترجاعات',
      'الضريبة',
      'عمولة المنصة',
      'صافي المستحق للبائع',
      'العملة',
      'الحالة',
    ];
    lines.push(headers.map((h) => this.escapeCell(h)).join(','));

    for (const li of snapshot.lineItems) {
      const statusAr = this.STATUS_MAP[li.status] || li.status;
      const dateStr = li.transactionDate ? new Date(li.transactionDate).toISOString().slice(0, 10) : '';

      const row = [
        li.lineIndex,
        this.escapeCell(dateStr),
        this.escapeCell(li.reference || li.orderId || '-'),
        this.escapeCell(li.description || 'طلب بيع مسوى'),
        this.formatNumber(li.grossAmount),
        this.formatNumber(li.discountAmount),
        this.formatNumber(li.adjustmentAmount || 0),
        this.formatNumber(li.taxAmount),
        this.formatNumber(li.commissionAmount),
        this.formatNumber(li.netAmount),
        this.escapeCell(this.formatCurrency(li.currency || snapshot.currency)),
        this.escapeCell(statusAr),
      ];
      lines.push(row.join(','));
    }
  }

  /**
   * Table formatter for COMMISSION_STATEMENT (كشف عمولات منصة سوقناا)
   */
  private static appendCommissionStatementTable(lines: string[], snapshot: StatementSnapshotDto): void {
    const headers = [
      'م',
      'تاريخ المعاملة',
      'رقم الطلب / المرجع',
      'البيان',
      'قيمة المبيعات الإجمالية',
      'وعاء احتساب العمولة',
      'نسبة العمولة (%)',
      'مبلغ عمولة المنصة',
      'العملة',
      'الحالة',
    ];
    lines.push(headers.map((h) => this.escapeCell(h)).join(','));

    for (const li of snapshot.lineItems) {
      const statusAr = this.STATUS_MAP[li.status] || li.status;
      const dateStr = li.transactionDate ? new Date(li.transactionDate).toISOString().slice(0, 10) : '';
      const rateVal = li.metadata?.commissionRate !== undefined
        ? `${((li.metadata.commissionRate || 0) * 100).toFixed(1)}%`
        : '-';
      const baseVal = li.metadata?.commissionBase !== undefined
        ? li.metadata.commissionBase
        : li.grossAmount;

      const row = [
        li.lineIndex,
        this.escapeCell(dateStr),
        this.escapeCell(li.reference || li.orderId || '-'),
        this.escapeCell(li.description || 'عمولة مبيعات'),
        this.formatNumber(li.grossAmount),
        this.formatNumber(baseVal),
        this.escapeCell(rateVal),
        this.formatNumber(li.commissionAmount),
        this.escapeCell(this.formatCurrency(li.currency || snapshot.currency)),
        this.escapeCell(statusAr),
      ];
      lines.push(row.join(','));
    }
  }

  /**
   * Table formatter for TAX_STATEMENT (كشف الإقرار الضريبي)
   */
  private static appendTaxStatementTable(lines: string[], snapshot: StatementSnapshotDto): void {
    const headers = [
      'م',
      'تاريخ المعاملة',
      'رقم الفاتورة / المرجع',
      'البيان والوصف',
      'الولاية الضريبية',
      'نسبة الضريبة (%)',
      'الوعاء الخاضع للضريبة',
      'مبلغ الضريبة',
      'العملة',
      'الحالة الضريبية',
    ];
    lines.push(headers.map((h) => this.escapeCell(h)).join(','));

    for (const li of snapshot.lineItems) {
      const statusAr = this.STATUS_MAP[li.status] || li.status;
      const dateStr = li.transactionDate ? new Date(li.transactionDate).toISOString().slice(0, 10) : '';
      const taxRate = li.metadata?.taxRate !== undefined
        ? `${((li.metadata.taxRate || 0) * 100).toFixed(0)}%`
        : '5%';
      const jurisdiction = li.metadata?.taxJurisdiction || 'الجمهورية اليمنية (عام)';

      const row = [
        li.lineIndex,
        this.escapeCell(dateStr),
        this.escapeCell(li.reference || li.orderId || '-'),
        this.escapeCell(li.description || 'معاملة ضريبية'),
        this.escapeCell(jurisdiction),
        this.escapeCell(taxRate),
        this.formatNumber(li.grossAmount),
        this.formatNumber(li.taxAmount || li.netAmount),
        this.escapeCell(this.formatCurrency(li.currency || snapshot.currency)),
        this.escapeCell(statusAr),
      ];
      lines.push(row.join(','));
    }
  }
}
