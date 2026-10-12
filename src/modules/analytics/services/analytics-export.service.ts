export class AnalyticsExportService {
  /**
   * Generates a clean UTF-8 CSV string with BOM for Arabic character preservation in Excel.
   */
  public static generateCsv(headers: string[], rows: (string | number)[][]): string {
    const BOM = '\uFEFF';
    const csvLines = [headers.map(this.escapeCsvCell).join(',')];

    for (const row of rows) {
      csvLines.push(row.map(this.escapeCsvCell).join(','));
    }

    return BOM + csvLines.join('\r\n');
  }

  private static escapeCsvCell(cell: string | number | null | undefined): string {
    if (cell === null || cell === undefined) return '""';
    const str = String(cell);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return `"${str}"`;
  }

  /**
   * Generates a high-quality HTML report suitable for PDF rendering or printing.
   */
  public static generateHtmlReport(params: {
    title: string;
    periodLabel: string;
    generatedAt: string;
    currency: string;
    kpis: { label: string; value: string; change?: string }[];
    tableHeaders: string[];
    tableRows: (string | number)[][];
    notes?: string[];
  }): string {
    const kpiCardsHtml = params.kpis
      .map(
        (k) => `
      <div class="kpi-card">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}</div>
        ${k.change ? `<div class="kpi-change">${k.change}</div>` : ''}
      </div>`
      )
      .join('');

    const headersHtml = params.tableHeaders.map((h) => `<th>${h}</th>`).join('');
    const rowsHtml = params.tableRows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('');

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>${params.title} - سوقناا</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap');
    body {
      font-family: 'Tajawal', sans-serif;
      margin: 0;
      padding: 30px;
      color: #1e293b;
      background: #f8fafc;
      direction: rtl;
    }
    .header {
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 16px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .title { font-size: 22px; font-weight: 700; color: #0f172a; margin: 0; }
    .subtitle { font-size: 13px; color: #64748b; margin-top: 4px; }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 28px;
    }
    .kpi-card {
      background: #ffffff;
      padding: 16px;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .kpi-label { font-size: 12px; color: #64748b; margin-bottom: 6px; }
    .kpi-value { font-size: 20px; font-weight: 700; color: #0284c7; }
    .kpi-change { font-size: 11px; color: #16a34a; margin-top: 4px; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #ffffff;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #e2e8f0;
    }
    th {
      background: #f1f5f9;
      color: #334155;
      text-align: right;
      padding: 12px;
      font-size: 12px;
      font-weight: 700;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #e2e8f0;
      font-size: 13px;
      color: #334155;
    }
    tr:last-child td { border-bottom: none; }
    .footer {
      margin-top: 30px;
      text-align: center;
      font-size: 11px;
      color: #94a3b8;
      border-top: 1px solid #e2e8f0;
      padding-top: 16px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1 class="title">${params.title}</h1>
      <div class="subtitle">سوقناا — المنظومة التحليلية المعتمدة | الفترة: ${params.periodLabel}</div>
    </div>
    <div style="text-align: left; font-size: 12px; color: #64748b;">
      تاريخ الإصدار: ${params.generatedAt}
    </div>
  </div>

  <div class="kpi-grid">
    ${kpiCardsHtml}
  </div>

  <table>
    <thead><tr>${headersHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>

  <div class="footer">
    تقرير تحليلي استرشادي صادر من محرك تحليلات سوقناا. لا يحل هذا التقرير محل القيود المحاسبية الدفترية الرسمية.
  </div>
</body>
</html>`;
  }
}
