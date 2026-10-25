/**
 * SOUQNAA Marketplace — Statement PDF & Document Generation Service
 * Renders high-fidelity, print-ready, bilingual (Arabic RTL + English LTR) A4 documents
 * for ONLY the 4 supported financial statements:
 * - SELLER_STATEMENT
 * - SETTLEMENT_STATEMENT
 * - COMMISSION_STATEMENT
 * - TAX_STATEMENT
 * Consumes ONLY the immutable finalized statement snapshot. NEVER recalculates financial values.
 */

import QRCode from 'qrcode';
import { config } from '../../config';
import { StatementSnapshotDto, StatementType } from './statement.types';
import { StatementPeriodService } from './statement-period.service';
import { SellerOrderPrintService } from '../../services/orders/seller-order-print.service';

export interface StatementRenderOptions {
  autoPrint?: boolean;
  exportUrl?: string;
}

export class StatementPdfService {
  /**
   * Generates a QR Code as Data URI for verification.
   */
  public static async generateQrDataUri(payload: string): Promise<string> {
    try {
      return await QRCode.toDataURL(payload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 140,
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
      });
    } catch {
      return '';
    }
  }

  /**
   * Formats numbers to currency string with 2 decimals
   */
  public static formatAmount(val: number | undefined | null, currency: string = 'ر.ي'): string {
    const num = Number(val || 0);
    return `${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }

  /**
   * Renders the complete HTML document for a finalized statement snapshot.
   */
  public static async renderStatementHtml(
    snapshot: StatementSnapshotDto,
    options?: StatementRenderOptions
  ): Promise<string> {
    snapshot = { ...snapshot, currency: snapshot.currency || config.marketplace.currencySymbol || 'ر.ي' };
    const autoPrint = options?.autoPrint ?? false;
    const exportUrl = options?.exportUrl ?? '';
    const qrPayload = snapshot.metadata?.qrPayload || `SOUQNAA-STMT|${snapshot.statementNumber}|${snapshot.statementType}`;
    const qrDataUri = await this.generateQrDataUri(qrPayload);
    const logoDataUri = SellerOrderPrintService.getSouqnaLogoDataUri();
    const periodText = StatementPeriodService.formatPeriodText(snapshot.periodStart, snapshot.periodEnd);

    const titleMap: Record<StatementType, { ar: string; en: string }> = {
      SELLER_STATEMENT: {
        ar: 'كشف حساب التاجر المالي الدوري',
        en: 'SOUQNAA SELLER FINANCIAL STATEMENT',
      },
      SETTLEMENT_STATEMENT: {
        ar: 'كشف التسوية المالية للبائع',
        en: 'SOUQNAA SETTLEMENT STATEMENT',
      },
      COMMISSION_STATEMENT: {
        ar: 'كشف عمولات منصة سوقناا',
        en: 'SOUQNAA COMMISSION STATEMENT',
      },
      TAX_STATEMENT: {
        ar: 'كشف الإقرار الضريبي للبائع',
        en: 'SOUQNAA TAX STATEMENT',
      },
    };

    const docTitle = titleMap[snapshot.statementType] || { ar: 'كشف مالي معتمد', en: 'FINANCIAL STATEMENT' };

    let summaryHtml = '';
    let tableHeadersHtml = '';
    let tableRowsHtml = '';

    if (snapshot.statementType === StatementType.SELLER_STATEMENT) {
      const s = snapshot.summary as any;
      summaryHtml = `
        <div class="summary-grid">
          <div class="summary-box">
            <span class="label">الرصيد الافتتاحي — Opening Balance</span>
            <span class="value">${this.formatAmount(s.openingBalance, snapshot.currency)}</span>
          </div>
          <div class="summary-box highlight-positive">
            <span class="label">إجمالي المبيعات — Gross Sales</span>
            <span class="value">${this.formatAmount(s.grossSales, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">خصومات المنتجات — Discounts</span>
            <span class="value text-danger">-${this.formatAmount(s.productDiscounts, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">المبالغ المسترجعة — Refunds</span>
            <span class="value text-danger">-${this.formatAmount(s.refunds, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">الضريبة المحصلة — Tax Collected</span>
            <span class="value">${this.formatAmount(s.tax, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">عمولة المنصة — Platform Commission</span>
            <span class="value text-danger">-${this.formatAmount(s.platformCommission, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">بدلات التوصيل — Delivery Fees</span>
            <span class="value">${this.formatAmount(s.deliveryAdjustments, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">السحوبات المنفذة — Withdrawals</span>
            <span class="value text-danger">-${this.formatAmount(s.withdrawals, snapshot.currency)}</span>
          </div>
          <div class="summary-box highlight-total">
            <span class="label">صافي الحركة — Net Activity</span>
            <span class="value">${this.formatAmount(s.netActivity, snapshot.currency)}</span>
          </div>
          <div class="summary-box highlight-closing">
            <span class="label">الرصيد الختامي — Closing Balance</span>
            <span class="value">${this.formatAmount(s.closingBalance, snapshot.currency)}</span>
          </div>
        </div>
      `;

      tableHeadersHtml = `
        <tr>
          <th style="width: 50px;">#</th>
          <th>التاريخ — Date</th>
          <th style="width: 140px; text-align: center;">المرجع — Reference</th>
          <th>النوع — Type</th>
          <th>البيان — Description</th>
          <th>المبلغ الإجمالي — Gross</th>
          <th>الخصم — Disc.</th>
          <th>الضريبة — Tax</th>
          <th>العمولة — Comm.</th>
          <th>الصافي — Net</th>
        </tr>
      `;

      tableRowsHtml = snapshot.lineItems.map((li) => `
        <tr>
          <td>${li.lineIndex}</td>
          <td>${new Date(li.transactionDate).toLocaleDateString('en-GB')}</td>
          <td class="font-mono" style="text-align: center;" dir="ltr">${li.reference}</td>
          <td><span class="badge badge-${li.type.toLowerCase()}">${li.type}</span></td>
          <td>${li.description}</td>
          <td>${this.formatAmount(li.grossAmount, '')}</td>
          <td>${li.discountAmount ? this.formatAmount(li.discountAmount, '') : '-'}</td>
          <td>${li.taxAmount ? this.formatAmount(li.taxAmount, '') : '-'}</td>
          <td>${li.commissionAmount ? this.formatAmount(li.commissionAmount, '') : '-'}</td>
          <td class="font-bold ${li.netAmount < 0 ? 'text-danger' : 'text-success'}">${this.formatAmount(li.netAmount, snapshot.currency)}</td>
        </tr>
      `).join('');

    } else if (snapshot.statementType === StatementType.SETTLEMENT_STATEMENT) {
      const s = snapshot.summary as any;
      summaryHtml = `
        <div class="summary-grid">
          <div class="summary-box">
            <span class="label">رقم التسوية — Settlement ID</span>
            <span class="value font-mono">${s.settlementNumber}</span>
          </div>
          <div class="summary-box highlight-positive">
            <span class="label">إجمالي مبيعات التسوية — Gross Sales</span>
            <span class="value">${this.formatAmount(s.grossSales, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">خصومات المبيعات — Discounts</span>
            <span class="value text-danger">-${this.formatAmount(s.productDiscounts, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">الاسترجاعات — Refunds</span>
            <span class="value text-danger">-${this.formatAmount(s.refunds, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">عمولة المنصة — Platform Commission</span>
            <span class="value text-danger">-${this.formatAmount(s.platformCommission, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">تسويات ضريبية ورسوم (Tax & Fees)</span>
            <span class="value">${this.formatAmount(s.taxAdjustments, snapshot.currency)}</span>
          </div>
          <div class="summary-box highlight-closing full-width">
            <span class="label">صافي مبلغ التسوية المستحق للبائع — NET SETTLEMENT PAYOUT</span>
            <span class="value grand-total">${this.formatAmount(s.netSettlement, snapshot.currency)}</span>
          </div>
        </div>
      `;

      tableHeadersHtml = `
        <tr>
          <th style="width: 50px;">#</th>
          <th>تاريخ الطلب — Date</th>
          <th style="width: 140px; text-align: center;">رقم الطلب — Order ID</th>
          <th>إجمالي الطلب — Gross</th>
          <th>الخصم — Discount</th>
          <th>المسترجع — Refund</th>
          <th>الضريبة — Tax</th>
          <th>العمولة — Comm.</th>
          <th>صافي التاجر — Net Seller Payout</th>
        </tr>
      `;

      tableRowsHtml = snapshot.lineItems.map((li) => `
        <tr>
          <td>${li.lineIndex}</td>
          <td>${new Date(li.transactionDate).toLocaleDateString('en-GB')}</td>
          <td class="font-mono" style="text-align: center;" dir="ltr">${li.reference}</td>
          <td>${this.formatAmount(li.grossAmount, '')}</td>
          <td>${li.discountAmount ? this.formatAmount(li.discountAmount, '') : '-'}</td>
          <td>${li.adjustmentAmount ? this.formatAmount(li.adjustmentAmount, '') : '-'}</td>
          <td>${li.taxAmount ? this.formatAmount(li.taxAmount, '') : '-'}</td>
          <td>${li.commissionAmount ? this.formatAmount(li.commissionAmount, '') : '-'}</td>
          <td class="font-bold text-success">${this.formatAmount(li.netAmount, snapshot.currency)}</td>
        </tr>
      `).join('');

    } else if (snapshot.statementType === StatementType.COMMISSION_STATEMENT) {
      const s = snapshot.summary as any;
      const ratePct = ((s.effectiveCommissionRate || 0) * 100).toFixed(1);
      summaryHtml = `
        <div class="summary-grid">
          <div class="summary-box">
            <span class="label">إجمالي المبيعات — Gross Sales</span>
            <span class="value">${this.formatAmount(s.grossSales, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">المبيعات المؤهلة — Eligible Sales</span>
            <span class="value">${this.formatAmount(s.eligibleSales, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">وعاء احتساب العمولة — Commission Base</span>
            <span class="value">${this.formatAmount(s.commissionBase, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">متوسط نسبة العمولة — Effective Rate</span>
            <span class="value font-bold">${ratePct}%</span>
          </div>
          <div class="summary-box highlight-closing full-width">
            <span class="label">إجمالي عمولة المنصة المستحقة — TOTAL PLATFORM COMMISSION</span>
            <span class="value grand-total">${this.formatAmount(s.totalCommission, snapshot.currency)}</span>
          </div>
        </div>
      `;

      tableHeadersHtml = `
        <tr>
          <th style="width: 50px;">#</th>
          <th>التاريخ — Date</th>
          <th style="width: 140px; text-align: center;">رقم الطلب — Order ID</th>
          <th>البيان — Description</th>
          <th>قيمة المبيعات — Sale Amount</th>
          <th>وعاء العمولة — Base</th>
          <th>النسبة — Rate</th>
          <th>مبلغ العمولة — Commission</th>
        </tr>
      `;

      tableRowsHtml = snapshot.lineItems.map((li) => {
        const rate = li.metadata?.commissionRate !== undefined ? `${((li.metadata.commissionRate || 0) * 100).toFixed(1)}%` : '-';
        return `
          <tr>
            <td>${li.lineIndex}</td>
            <td>${new Date(li.transactionDate).toLocaleDateString('en-GB')}</td>
            <td class="font-mono" style="text-align: center;" dir="ltr">${li.reference}</td>
            <td>${li.description}</td>
            <td>${this.formatAmount(li.grossAmount, '')}</td>
            <td>${this.formatAmount(li.metadata?.commissionBase || li.grossAmount, '')}</td>
            <td>${rate}</td>
            <td class="font-bold text-danger">${this.formatAmount(li.commissionAmount, snapshot.currency)}</td>
          </tr>
        `;
      }).join('');

    } else if (snapshot.statementType === StatementType.TAX_STATEMENT) {
      const s = snapshot.summary as any;
      summaryHtml = `
        <div class="summary-grid">
          <div class="summary-box">
            <span class="label">المبيعات الخاضعة للضريبة — Gross Taxable Sales</span>
            <span class="value">${this.formatAmount(s.grossTaxableSales, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">المبيعات المعفاة — Tax-Exempt Sales</span>
            <span class="value">${this.formatAmount(s.taxExemptSales, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">المبيعات الصفرية — Zero-Rated Sales</span>
            <span class="value">${this.formatAmount(s.zeroRatedSales, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">الوعاء الضريبي — Taxable Amount</span>
            <span class="value">${this.formatAmount(s.taxableAmount, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">إجمالي الضريبة المحصلة — Tax Collected</span>
            <span class="value">${this.formatAmount(s.taxCollected, snapshot.currency)}</span>
          </div>
          <div class="summary-box">
            <span class="label">ضريبة المسترجعات — Tax Refunded</span>
            <span class="value text-danger">-${this.formatAmount(s.taxRefunded, snapshot.currency)}</span>
          </div>
          <div class="summary-box highlight-closing full-width">
            <span class="label">صافي الضريبة للإقرار — NET TAX PAYABLE</span>
            <span class="value grand-total">${this.formatAmount(s.netTax, snapshot.currency)}</span>
          </div>
        </div>
      `;

      tableHeadersHtml = `
        <tr>
          <th style="width: 50px;">#</th>
          <th>التاريخ — Date</th>
          <th style="width: 140px; text-align: center;">المرجع — Ref / Order</th>
          <th>البيان — Tax Description</th>
          <th>الولاية الضريبية — Jurisdiction</th>
          <th>النسبة — Rate</th>
          <th>الوعاء الضريبي — Taxable</th>
          <th>مبلغ الضريبة — Tax Amount</th>
        </tr>
      `;

      tableRowsHtml = snapshot.lineItems.map((li) => {
        const rate = li.metadata?.taxRate !== undefined ? `${((li.metadata.taxRate || 0) * 100).toFixed(0)}%` : '5%';
        const jurisdiction = li.metadata?.taxJurisdiction || 'YEMEN_GENERAL';
        return `
          <tr>
            <td>${li.lineIndex}</td>
            <td>${new Date(li.transactionDate).toLocaleDateString('en-GB')}</td>
            <td class="font-mono" style="text-align: center;" dir="ltr">${li.reference}</td>
            <td>${li.description}</td>
            <td>${jurisdiction}</td>
            <td>${rate}</td>
            <td>${this.formatAmount(li.grossAmount, '')}</td>
            <td class="font-bold ${li.netAmount < 0 ? 'text-danger' : 'text-success'}">${this.formatAmount(li.netAmount, snapshot.currency)}</td>
          </tr>
        `;
      }).join('');
    }

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>${docTitle.ar} - ${snapshot.statementNumber}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 12mm 10mm;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      margin: 0;
      padding: 24px 16px;
      font-size: 13px;
      direction: rtl;
    }
    .page-container {
      max-width: 960px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 32px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.04);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2.5px solid #ff6b00;
      padding-bottom: 16px;
      margin-bottom: 24px;
      gap: 16px;
    }
    .brand-section {
      display: flex;
      align-items: center;
      gap: 16px;
      min-width: 0;
    }
    .brand-logo {
      height: 48px;
      width: auto;
      max-width: 140px;
      object-fit: contain;
      flex-shrink: 0;
    }
    .brand-titles {
      min-width: 0;
    }
    .brand-titles h1 {
      margin: 0;
      font-size: 20px;
      color: #0f172a;
      font-weight: 800;
      line-height: 1.3;
    }
    .brand-titles p {
      margin: 3px 0 0;
      color: #64748b;
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    .statement-meta {
      text-align: left;
      direction: ltr;
      flex-shrink: 0;
    }
    .stmt-number {
      font-family: monospace;
      font-size: 14px;
      font-weight: 800;
      color: #ff6b00;
      background: #fff7ed;
      border: 1px solid #ffedd5;
      padding: 5px 12px;
      border-radius: 6px;
      display: inline-block;
      white-space: nowrap;
      margin-bottom: 4px;
    }
    .stmt-date {
      font-size: 11px;
      color: #64748b;
      white-space: nowrap;
    }
    .info-card-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .info-col h3 {
      margin: 0 0 10px;
      font-size: 13px;
      color: #ff6b00;
      font-weight: 700;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .info-label {
      color: #64748b;
      flex-shrink: 0;
    }
    .info-val {
      font-weight: 600;
      color: #0f172a;
      text-align: left;
      direction: ltr;
      word-break: break-all;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-bottom: 28px;
    }
    .summary-box {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 12px 14px;
    }
    .summary-box .label {
      display: block;
      font-size: 11px;
      color: #64748b;
      margin-bottom: 4px;
    }
    .summary-box .value {
      font-size: 15px;
      font-weight: 700;
      color: #0f172a;
    }
    .highlight-positive { background: #fff7ed; border-color: #ffedd5; }
    .highlight-total { background: #eff6ff; border-color: #bfdbfe; }
    .highlight-closing { background: #fff7ed; border-color: #fdba74; }
    .full-width { grid-column: 1 / -1; }
    .grand-total { font-size: 20px !important; color: #ff6b00 !important; }
    .text-danger { color: #ef4444 !important; }
    .text-success { color: #16a34a !important; }
    .font-mono { font-family: monospace; }
    .font-bold { font-weight: 700; }
    .section-title {
      font-size: 13.5px;
      font-weight: 800;
      color: #0f172a;
      margin: 0 0 12px;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 6px;
    }
    .table-container {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      margin-bottom: 24px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
    }
    table {
      width: 100%;
      min-width: 650px;
      border-collapse: collapse;
      margin-bottom: 0;
      font-size: 11px;
    }
    th {
      background: #0f172a;
      color: #ffffff;
      text-align: right;
      padding: 8px 10px;
      font-weight: 700;
      white-space: nowrap;
    }
    td {
      padding: 8px 10px;
      border-bottom: 1px solid #f1f5f9;
      color: #1e293b;
    }
    tr:nth-child(even) td { background: #f8fafc; }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
    }
    .badge-sale { background: #dcfce7; color: #15803d; }
    .badge-refund { background: #fee2e2; color: #b91c1c; }
    .badge-commission { background: #fef3c7; color: #b45309; }
    .badge-tax { background: #e0e7ff; color: #4338ca; }
    .badge-withdrawal { background: #f3e8ff; color: #7e22ce; }
    .badge-adjustment { background: #f1f5f9; color: #475569; }
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid #e2e8f0;
      padding-top: 16px;
      margin-top: 24px;
      font-size: 11px;
      color: #64748b;
      gap: 16px;
      flex-wrap: wrap;
    }
    .verification-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .qr-img {
      width: 64px;
      height: 64px;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .versions-meta {
      font-family: monospace;
      font-size: 10px;
      color: #94a3b8;
      text-align: left;
      direction: ltr;
    }
    .no-print-toolbar {
      max-width: 960px;
      margin: 0 auto 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      padding: 12px 18px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.06);
    }
    .toolbar-title {
      font-size: 13.5px;
      font-weight: 700;
      color: #0f172a;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .toolbar-doc-name {
      white-space: nowrap;
    }
    .toolbar-stmt-num {
      font-family: monospace;
      color: #ff6b00;
      white-space: nowrap;
      font-weight: 800;
      font-size: 13px;
    }
    .toolbar-badge {
      background: #fff7ed;
      color: #ea580c;
      border: 1px solid #ffedd5;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .toolbar-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    .t-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      border: none;
      font-family: inherit;
      white-space: nowrap;
    }
    .t-btn-primary {
      background: #ff6b00;
      color: #ffffff;
    }
    .t-btn-primary:hover { background: #ea580c; }
    .t-btn-secondary {
      background: #f8fafc;
      color: #0f172a;
      border: 1px solid #cbd5e1;
    }
    .t-btn-secondary:hover { background: #e2e8f0; }

    @media (max-width: 820px) {
      body {
        padding: 8px;
      }
      .page-container {
        padding: 16px 12px;
        border-radius: 8px;
      }
      .no-print-toolbar {
        flex-direction: column;
        align-items: stretch;
        gap: 12px;
        padding: 12px;
      }
      .toolbar-title {
        justify-content: space-between;
        width: 100%;
      }
      .toolbar-actions {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
        width: 100%;
      }
      .t-btn {
        width: 100%;
        justify-content: center;
        padding: 8px 4px;
        font-size: 12px;
        white-space: nowrap;
      }
      .header {
        flex-direction: column-reverse;
        align-items: flex-start;
        gap: 14px;
        padding-bottom: 14px;
        margin-bottom: 18px;
      }
      .statement-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
        text-align: right;
        direction: rtl;
      }
      .brand-section {
        width: 100%;
        gap: 12px;
      }
      .brand-logo {
        height: 40px;
        max-width: 110px;
      }
      .brand-titles h1 {
        font-size: 16px;
        white-space: normal;
        word-break: normal;
      }
      .brand-titles p {
        font-size: 10px;
      }
      .info-card-grid {
        grid-template-columns: 1fr;
        gap: 12px;
        padding: 12px;
        margin-bottom: 18px;
      }
      .summary-grid {
        grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 8px;
        margin-bottom: 18px;
      }
      .summary-box {
        padding: 10px;
      }
      .summary-box .value {
        font-size: 14px;
      }
      .footer {
        flex-direction: column;
        align-items: flex-start;
        gap: 14px;
      }
      .verification-info {
        width: 100%;
      }
      .versions-meta {
        width: 100%;
        text-align: right;
        direction: rtl;
      }
    }

    @media (max-width: 480px) {
      .toolbar-actions {
        grid-template-columns: 1fr;
      }
      .summary-grid {
        grid-template-columns: 1fr;
      }
      .brand-titles h1 {
        font-size: 15px;
      }
    }

    @media print {
      .no-print-toolbar { display: none !important; }
      body { background: #fff !important; padding: 0 !important; }
      .page-container { border: none !important; box-shadow: none !important; padding: 0 !important; max-width: 100% !important; margin: 0 !important; }
      .header { flex-direction: row !important; align-items: flex-start !important; }
      .statement-meta { width: auto !important; display: block !important; text-align: left !important; direction: ltr !important; }
      .info-card-grid { grid-template-columns: 1fr 1fr !important; }
      .table-container { overflow: visible !important; border: none !important; }
      table { min-width: 100% !important; }
      .footer { flex-direction: row !important; align-items: center !important; }
    }
  </style>
</head>
<body>
  <div class="no-print-toolbar">
    <div class="toolbar-title">
      <span class="toolbar-badge">معتمد ومجمد</span>
      <span class="toolbar-doc-name">${docTitle.ar}</span>
      <span class="toolbar-stmt-num">${snapshot.statementNumber}</span>
    </div>
    <div class="toolbar-actions">
      <button type="button" class="t-btn t-btn-primary" onclick="window.print();">طباعة المستند</button>
      <button type="button" class="t-btn t-btn-secondary" onclick="window.print();">حفظ كـ PDF</button>
      ${exportUrl ? `<a href="${exportUrl}" class="t-btn t-btn-secondary" download>تصدير Excel / CSV</a>` : ''}
      <button type="button" class="t-btn t-btn-secondary" onclick="window.close();">إغلاق</button>
    </div>
  </div>
  <div class="page-container">
    <!-- Header -->
    <div class="header">
      <div class="brand-section">
        ${logoDataUri ? `<img src="${logoDataUri}" alt="SOUQNAA" class="brand-logo"/>` : ''}
        <div class="brand-titles">
          <h1>${docTitle.ar}</h1>
          <p>${docTitle.en}</p>
        </div>
      </div>
      <div class="statement-meta">
        <div class="stmt-number">${snapshot.statementNumber}</div>
        <div class="stmt-date">Finalized: ${new Date(snapshot.createdAt).toISOString().slice(0, 10)}</div>
      </div>
    </div>

    <!-- Metadata Grid -->
    <div class="info-card-grid">
      <div class="info-col">
        <h3>بيانات التاجر والمتجر — Seller Details</h3>
        <div class="info-row">
          <span class="info-label">اسم المتجر / البائع:</span>
          <span class="info-val">${snapshot.metadata?.storeName || 'متجر معتمد'}</span>
        </div>
        ${(snapshot.metadata?.storeEmail || snapshot.metadata?.sellerEmail || snapshot.metadata?.email) ? `
        <div class="info-row">
          <span class="info-label">البريد الإلكتروني:</span>
          <span class="info-val" dir="ltr">${snapshot.metadata?.storeEmail || snapshot.metadata?.sellerEmail || snapshot.metadata?.email}</span>
        </div>` : ''}
        ${snapshot.metadata?.sellerCrNumber ? `
        <div class="info-row">
          <span class="info-label">رقم السجل التجاري — CR:</span>
          <span class="info-val font-mono">${snapshot.metadata.sellerCrNumber}</span>
        </div>` : ''}
        ${snapshot.metadata?.sellerTaxNumber ? `
        <div class="info-row">
          <span class="info-label">الرقم الضريبي — Tax ID:</span>
          <span class="info-val font-mono">${snapshot.metadata.sellerTaxNumber}</span>
        </div>` : ''}
      </div>
      <div class="info-col">
        <h3>بيانات الكشف المالي — Statement Specs</h3>
        <div class="info-row">
          <span class="info-label">فترة الكشف — Period:</span>
          <span class="info-val">${periodText.ar}</span>
        </div>
        <div class="info-row">
          <span class="info-label">العملة المعتمدة — Currency:</span>
          <span class="info-val">ر.ي</span>
        </div>
        <div class="info-row">
          <span class="info-label">الولاية الضريبية — Jurisdiction:</span>
          <span class="info-val">الجمهورية اليمنية — YEMEN_GENERAL</span>
        </div>
      </div>
    </div>

    <!-- Summary Box -->
    <div class="section-title">ملخص الأرقام والمؤشرات المالية — Financial Summary</div>
    ${summaryHtml}

    <!-- Table of Lines -->
    <div class="section-title">سجل العمليات والبنود التفصيلية — Itemized Transactions</div>
    <div class="table-container">
      <table>
        <thead>
          ${tableHeadersHtml}
        </thead>
        <tbody>
          ${tableRowsHtml}
        </tbody>
      </table>
    </div>

    <!-- Footer & Verification -->
    <div class="footer">
      <div class="verification-info">
        ${qrDataUri ? `<img src="${qrDataUri}" alt="Verification QR" class="qr-img"/>` : ''}
        <div>
          <div style="font-weight: 700; color: #ff6b00;">وثيقة مالية رسمية معتمدة ومجمدة إلكترونياً</div>
          <div>رمز التحقق الأمني: <span class="font-mono">${(snapshot.metadata?.verificationHash || '').slice(0, 24)}...</span></div>
          <div style="color: #94a3b8; font-size: 10px;">تم إصدار هذا الكشف آلياً بواسطة محرك التقارير المالية لمنصة سوقناا.</div>
        </div>
      </div>
      <div class="versions-meta">
        <div>Statement Engine: ${snapshot.calculationVersions.statementEngineVersion}</div>
        <div>Tax Engine: ${snapshot.calculationVersions.taxEngineVersion}</div>
        <div>Commission Engine: ${snapshot.calculationVersions.commissionEngineVersion}</div>
        <div>Settlement Engine: ${snapshot.calculationVersions.settlementEngineVersion}</div>
      </div>
    </div>
  </div>
  <script>
    if (${autoPrint} || new URLSearchParams(window.location.search).get('autoPrint') === 'true') {
      window.addEventListener('DOMContentLoaded', () => setTimeout(() => window.print(), 350));
    }
  </script>
</body>
</html>`;
  }
}
