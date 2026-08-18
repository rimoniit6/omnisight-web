import * as XLSX from 'xlsx';

// ─── Shared export-window defaults ───────────────────────────────────────────

/** Default window (days) applied to exports without an explicit date range.
 *  Mirrors the analytics 90-day cap — a direct API call must never default to
 *  scanning the entire table. */
export const DEFAULT_EXPORT_WINDOW_DAYS = 90;

/**
 * Maximum accepted report/export window (days). A manager-supplied range wider
 * than this is rejected with 400 — report generation must never scan the whole
 * table (WM-02). Mirrors the analytics 90-day cap.
 */
export const MAX_EXPORT_WINDOW_DAYS = 90;

/**
 * Validate + bound a report/export date range at the API boundary.
 *
 * - missing range → `{ fromDate: null, toDate: null }` (callers apply the
 *   default window);
 * - malformed or inverted ranges → `error` (400);
 * - a range wider than MAX_EXPORT_WINDOW_DAYS → `error` (400).
 */
export function parseBoundedRange(
  from: string,
  to: string,
  maxDays = MAX_EXPORT_WINDOW_DAYS
): { fromDate: Date | null; toDate: Date | null; error?: { status: number; message: string } } {
  const base = parseExportRange(from, to);
  if (base.error) return base;
  if (base.fromDate && base.toDate) {
    const spanDays = (base.toDate.getTime() - base.fromDate.getTime()) / 86_400_000;
    if (spanDays > maxDays) {
      return {
        fromDate: null,
        toDate: null,
        error: {
          status: 400,
          message: `Date range must not exceed ${maxDays} days`,
        },
      };
    }
  }
  return base;
}

/**
 * Validate an export date range at the API boundary (shared by every export
 * route). Missing range → null dates (callers decide the default window);
 * malformed or inverted ranges → `error` with a 400 status.
 */
export function parseExportRange(
  from: string,
  to: string
): { fromDate: Date | null; toDate: Date | null; error?: { status: number; message: string } } {
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if (fromDate && isNaN(fromDate.getTime())) {
    return { fromDate: null, toDate: null, error: { status: 400, message: `Invalid 'from' date: ${from}` } };
  }
  if (toDate && isNaN(toDate.getTime())) {
    return { fromDate: null, toDate: null, error: { status: 400, message: `Invalid 'to' date: ${to}` } };
  }
  if (fromDate && toDate && fromDate > toDate) {
    return { fromDate: null, toDate: null, error: { status: 400, message: "'from' must not be after 'to'" } };
  }
  return { fromDate, toDate };
}

// ─── Column Definition ──────────────────────────────────────────────────────

export interface ExportColumn {
  key: string;        // property name in data object
  label: string;      // header label in export
  format?: 'string' | 'number' | 'date' | 'datetime' | 'currency' | 'percent' | 'duration';
  width?: number;     // column width in Excel (characters)
}

// ─── Export Options ──────────────────────────────────────────────────────────

export interface ExportOptions {
  filename: string;       // without extension
  format: 'csv' | 'xlsx';
  sheetName?: string;     // Excel sheet name (default: 'Data')
  columns: ExportColumn[];
  data: Record<string, unknown>[];
}

// ─── Format Cell Values ──────────────────────────────────────────────────────

function formatCellValue(value: unknown, format?: ExportColumn['format']): string | number {
  if (value === null || value === undefined) return '';

  // Duration format: convert seconds to "Xh Ym"
  if (format === 'duration') {
    const totalSeconds = typeof value === 'number' ? value : parseFloat(String(value)) || 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours === 0 && minutes === 0) return '0m';
    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  // Currency format: "$1,234.56"
  if (format === 'currency') {
    const num = typeof value === 'number' ? value : parseFloat(String(value));
    if (isNaN(num)) return String(value);
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // Percent format: "45.2%"
  if (format === 'percent') {
    const num = typeof value === 'number' ? value : parseFloat(String(value));
    if (isNaN(num)) return String(value);
    return `${num.toFixed(1)}%`;
  }

  // Number format: locale-aware with commas
  if (format === 'number') {
    const num = typeof value === 'number' ? value : parseFloat(String(value));
    if (isNaN(num)) return String(value);
    return num.toLocaleString('en-US');
  }

  // Date format: "MMM dd, yyyy"
  if (format === 'date') {
    const date = value instanceof Date ? value : new Date(String(value));
    if (isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
  }

  // Datetime format: "MMM dd, yyyy HH:mm"
  if (format === 'datetime') {
    const date = value instanceof Date ? value : new Date(String(value));
    if (isNaN(date.getTime())) return String(value);
    const datePart = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
    const timePart = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${datePart} ${timePart}`;
  }

  // Default: string or passthrough
  if (typeof value === 'number') return value;
  return String(value);
}

// ─── CSV Generation ──────────────────────────────────────────────────────────

/**
 * Spreadsheet formula-injection guard (CWE-1236).
 *
 * Cells beginning with `=`, `+`, `-`, `@` (or a control character 0x00–0x1F)
 * are interpreted as formulas by Excel/Sheets. Prefixing them with a single
 * quote forces literal text. This is the OWASP-recommended neutralization and
 * must be applied on every CSV and XLSX export path — telemetry-derived
 * strings (app names, URLs, employee names) are the injection vector.
 */
export function sanitizeSpreadsheetCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.length === 0) return str;
  const first = str.charCodeAt(0);
  const dangerous =
    first === 0x3d /* = */ ||
    first === 0x2b /* + */ ||
    first === 0x2d /* - */ ||
    first === 0x40 /* @ */ ||
    first <= 0x1f; // control chars
  return dangerous ? `'${str}` : str;
}

/**
 * Escape a single CSV field value.
 * Wraps in quotes if the value contains commas, quotes, or newlines.
 * Formula-prefix neutralization is applied BEFORE quoting (a quoted
 * `="..."` cell is still evaluated as a formula by Excel).
 */
function escapeCSVField(value: unknown): string {
  const str = sanitizeSpreadsheetCell(value);
  // If the field contains a comma, double-quote, or newline, wrap in quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generate a CSV string from column definitions and data.
 */
export function generateCSV(columns: ExportColumn[], data: Record<string, unknown>[]): string {
  const headerRow = columns.map((col) => escapeCSVField(col.label)).join(',');

  const dataRows = data.map((row) => {
    return columns
      .map((col) => {
        const rawValue = row[col.key];
        const formattedValue = formatCellValue(rawValue, col.format);
        return escapeCSVField(formattedValue);
      })
      .join(',');
  });

  return [headerRow, ...dataRows].join('\n');
}

// ─── Excel Generation ────────────────────────────────────────────────────────

/**
 * Generate an Excel (.xlsx) buffer from export options.
 * Includes auto-filter, frozen header row, and styled header (bold, emerald background).
 */
export function generateExcel(options: ExportOptions): Buffer {
  const { columns, data, sheetName = 'Data' } = options;

  // Build the 2D array of cell values
  const headerRow = columns.map((col) => col.label);
  const dataRows = data.map((row) => {
    return columns.map((col) => {
      const rawValue = row[col.key];
      return formatCellValue(rawValue, col.format);
    });
  });

  // Formula-injection guard: cell values that could be interpreted as
  // spreadsheet formulas are neutralized before hitting the sheet.
  const safeHeader = headerRow.map((h) => sanitizeSpreadsheetCell(h));
  const safeData = dataRows.map((row) => row.map((v) => (typeof v === 'string' ? sanitizeSpreadsheetCell(v) : v)));

  const aoa: (string | number)[][] = [safeHeader, ...safeData];

  // Create workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Set column widths
  ws['!cols'] = columns.map((col) => ({
    wch: col.width || Math.max(col.label.length + 2, 12),
  }));

  // Auto-filter on the entire header row
  const colLetterEnd = XLSX.utils.encode_col(columns.length - 1);
  ws['!autofilter'] = { ref: `A1:${colLetterEnd}1` };

  // Freeze the header row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  // Apply header styling via cell metadata
  // XLSX community edition has limited style support; we use the approach of
  // setting the cell objects directly for bold + fill
  applyHeaderStyles(wb, ws, columns);

  // Re-generate the buffer after styling
  return XLSX.write(wb, {
    type: 'buffer',
    bookType: 'xlsx',
  });
}

/**
 * Apply bold text and emerald background to the header row.
 * Works with XLSX's cell object model.
 */
function applyHeaderStyles(
  _wb: XLSX.WorkBook,
  ws: XLSX.WorkSheet,
  columns: ExportColumn[]
): void {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    const cellAddress = XLSX.utils.encode_cell({ r: range.s.r, c: colIdx });
    const cell = ws[cellAddress];
    if (cell) {
      // Set cell style properties
      cell.s = {
        font: {
          bold: true,
          color: { rgb: 'FFFFFF' },
        },
        fill: {
          fgColor: { rgb: '059669' }, // emerald-600
        },
        alignment: {
          horizontal: 'center',
          vertical: 'center',
        },
      };
    }
  }
}

// ─── Main Export Function ────────────────────────────────────────────────────

/**
 * Generate an export file (CSV or XLSX) and return as a Buffer.
 */
export function generateExport(options: ExportOptions): Buffer {
  if (options.format === 'csv') {
    return Buffer.from(generateCSV(options.columns, options.data), 'utf-8');
  }

  return generateExcel(options);
}

/**
 * Get the MIME content type for an export format.
 */
export function getExportContentType(format: 'csv' | 'xlsx'): string {
  return format === 'csv'
    ? 'text/csv; charset=utf-8'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

/**
 * Get the file extension for an export format.
 */
export function getExportExtension(format: 'csv' | 'xlsx'): string {
  return format === 'csv' ? 'csv' : 'xlsx';
}
