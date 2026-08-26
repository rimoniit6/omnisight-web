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
