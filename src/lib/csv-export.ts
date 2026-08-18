import { sanitizeSpreadsheetCell } from '@/lib/export';

export function exportToCSV(data: Record<string, unknown>[], filename: string): void {
  if (data.length === 0) return;
  const headers = Object.keys(data[0]);
  const csvRows = [
    headers.join(','),
    ...data.map(row =>
      headers.map(h => {
        const val = row[h];
        // CWE-1236: neutralize spreadsheet formula prefixes before quoting.
        const str = sanitizeSpreadsheetCell(typeof val === 'object' && val !== null ? JSON.stringify(val) : val ?? '');
        return `"${str.replace(/"/g, '""')}"`;
      }).join(',')
    ),
  ];
  const csvString = csvRows.join('\n');
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Export data as a downloadable JSON file.
 */
export function exportToJSON(data: Record<string, unknown>[], filename: string): void {
  if (data.length === 0) return;
  const jsonString = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Specialized CSV export for report data structures.
 * Handles nested JSON data from report generation endpoint.
 * Flattens summary + tabular sections into CSV rows.
 */
export function exportReportToCSV(reportData: Record<string, unknown>, filename: string): void {
  const rows = flattenReportDataForExport(reportData);
  if (rows.length > 0) {
    exportToCSV(rows, filename);
  }
}

function flattenReportDataForExport(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];

  // Collect summary fields
  const summary = parsed.summary as Record<string, unknown> | undefined;
  if (summary) {
    const summaryRow: Record<string, unknown> = { _section: 'Summary' };
    for (const [key, value] of Object.entries(summary)) {
      summaryRow[key] = value;
    }
    if (parsed.departmentName) summaryRow.departmentName = parsed.departmentName;
    if (parsed.manager) summaryRow.manager = parsed.manager;
    if (parsed.employeeName) summaryRow.employeeName = parsed.employeeName;
    if (parsed.department) summaryRow.department = parsed.department;
    if (parsed.employeeCount !== undefined) summaryRow.employeeCount = parsed.employeeCount;
    rows.push(summaryRow);
  }

  // Extract tabular arrays
  const tableKeys = ['departmentBreakdown', 'dailyTrend', 'employees', 'devices', 'categoryDistribution', 'topApplications', 'topWebsites'];
  for (const key of tableKeys) {
    const arr = parsed[key];
    if (Array.isArray(arr) && arr.length > 0) {
      for (const item of arr) {
        rows.push({ _section: key, ...(item as Record<string, unknown>) });
      }
      break;
    }
  }

  // Fallback: flatten entire object
  if (rows.length === 0) {
    const flatRow: Record<string, unknown> = {};
    flattenObj('', parsed, flatRow);
    rows.push(flatRow);
  }

  return rows;
}

function flattenObj(prefix: string, obj: unknown, result: Record<string, unknown>) {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== 'object') {
    result[prefix] = obj;
    return;
  }
  if (Array.isArray(obj)) {
    result[prefix] = JSON.stringify(obj);
    return;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    flattenObj(newKey, value, result);
  }
}
