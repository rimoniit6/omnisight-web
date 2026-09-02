import PDFDocument from 'pdfkit';
import { format } from 'date-fns';
import { join } from 'node:path';

// ============================================================================
// Constants & Theme
// ============================================================================

const COLORS = {
  primary: '#059669',       // Emerald-600
  secondary: '#0d9488',     // Teal-600
  accent: '#14b8a6',        // Teal-500
  lightGreen: '#d1fae5',    // Emerald-100
  lightGray: '#f3f4f6',     // Gray-100
  mediumGray: '#e5e7eb',    // Gray-200
  darkGray: '#6b7280',      // Gray-500
  textDark: '#111827',       // Gray-900
  textMedium: '#374151',     // Gray-700
  textLight: '#9ca3af',      // Gray-400
  white: '#ffffff',
  black: '#000000',
  alertRed: '#ef4444',
  alertAmber: '#f59e0b',
  alertBlue: '#3b82f6',
};

const MARGINS = { top: 50, bottom: 60, left: 50, right: 50 };
const PAGE_WIDTH = 612; // Letter size
const PAGE_HEIGHT = 792;
const CONTENT_WIDTH = PAGE_WIDTH - MARGINS.left - MARGINS.right; // 512pt

// ============================================================================
// Type Definitions (inline)
// ============================================================================

interface StatItem {
  label: string;
  value: string;
  color?: string;
}

interface DataTableOptions {
  colWidths?: number[];
  pageSize?: number;
}

interface BulletListOptions {
  indent?: number;
}

interface ReportOptions {
  dateRange?: { start: Date; end: Date };
  organization?: string;
  generatedBy?: string;
  branding?: {
    brandName?: string;
    primaryColor?: string;
    tagline?: string;
  };
}

interface EmployeeData {
  id: string;
  name: string;
  email: string;
  designation: string;
  department: string;
  status: string;
  joinDate: Date | string;
}

interface ActivityData {
  id: string;
  timestamp: Date | string;
  employeeName: string;
  appOrWebsite: string;
  category: string;
  duration: number; // seconds
  type: string;
}

interface ProjectMember {
  name: string;
  role: string;
  hoursPerWeek: number;
  totalHours: number;
  joinDate: Date | string;
}

interface TimeEntry {
  date: Date | string;
  employee: string;
  hours: number;
  category: string;
  billable: boolean;
}

interface AlertData {
  id: string;
  title: string;
  severity: string;
  status: string;
  createdAt: Date | string;
  description?: string;
}

interface AuditLogData {
  id: string;
  timestamp: Date | string;
  action: string;
  resource: string;
  description: string;
  userName: string;
  ipAddress: string;
}

// ============================================================================
// Utility: Buffer Collector
// ============================================================================

/**
 * Turbopack bundling mangles pdfkit's `__dirname`, breaking its bundled
 * standard-font data (Helvetica.afm) resolution at runtime. Register bundled
 * TTF fonts under the standard names so every existing `doc.font('Helvetica')`
 * call resolves to an embedded font instead of the broken AFM path.
 */
function registerBundledFonts(doc: PDFKit.PDFDocument): void {
  const fontDir = join(process.cwd(), 'src', 'lib', 'pdf', 'fonts');
  doc.registerFont('Helvetica', join(fontDir, 'arial.ttf'));
  doc.registerFont('Helvetica-Bold', join(fontDir, 'arialbd.ttf'));
}

function createBufferCollector(branding?: { brandName?: string }): { doc: PDFKit.PDFDocument; getBuffer: () => Promise<Buffer> } {
  const buffers: Buffer[] = [];

  const doc = new PDFDocument({
    size: 'letter',
    margins: {
      top: MARGINS.top,
      bottom: MARGINS.bottom,
      left: MARGINS.left,
      right: MARGINS.right,
    },
    bufferPages: true,
    // Empty font defers the standard-font load until registerBundledFonts
    // runs; otherwise pdfkit loads Helvetica.afm inside the constructor, which
    // fails under turbopack because __dirname is mangled.
    font: '',
    info: {
      Creator: branding?.brandName || 'OmniSight',
      Producer: `${branding?.brandName || 'OmniSight'} PDF Generator`,
      Title: `${branding?.brandName || 'OmniSight'} Report`,
    },
  });

  registerBundledFonts(doc);

  doc.on('data', (chunk: Buffer) => buffers.push(chunk));

  const getBuffer = (): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);
    });

  return { doc, getBuffer };
}

// ============================================================================
// Utility: formatDuration
// ============================================================================

export function formatDuration(seconds: number): string {
  if (seconds < 0) return '0m';
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

// ============================================================================
// Core: createPdfDocument
// ============================================================================

export function createPdfDocument(branding?: { brandName?: string }): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: 'letter',
    margins: {
      top: MARGINS.top,
      bottom: MARGINS.bottom,
      left: MARGINS.left,
      right: MARGINS.right,
    },
    bufferPages: true,
    // See registerBundledFonts: defer the standard-font load until fonts are
    // registered, avoiding the turbopack-broken Helvetica.afm path.
    font: '',
    info: {
      Creator: branding?.brandName || 'OmniSight',
      Producer: `${branding?.brandName || 'OmniSight'} PDF Generator`,
      Title: `${branding?.brandName || 'OmniSight'} Report`,
    },
  });
  registerBundledFonts(doc);
  return doc;
}

// ============================================================================
// Core: ensureSpace
// ============================================================================

export function ensureSpace(doc: PDFKit.PDFDocument, minHeight: number): void {
  const bottomLimit = PAGE_HEIGHT - MARGINS.bottom;
  if (doc.y + minHeight > bottomLimit) {
    doc.addPage();
  }
}

// ============================================================================
// Layout: addHeader
// ============================================================================

export function addHeader(
  doc: PDFKit.PDFDocument,
  title: string,
  subtitle?: string,
  orgName?: string,
  branding?: { brandName?: string; primaryColor?: string; tagline?: string },
): void {
  const x = MARGINS.left;
  const y = MARGINS.top;

  // Green accent bar at top
  const primaryColor = branding?.primaryColor || COLORS.primary;
  doc.save();
  doc.rect(x, y - 10, CONTENT_WIDTH, 4).fill(primaryColor);
  doc.restore();

  // Brand text logo (left)
  const brandName = branding?.brandName || 'OmniSight';
  doc.font('Helvetica-Bold').fontSize(11).fillColor(primaryColor);
  doc.text(brandName, x, y, { continued: false });

  // Organization name (right-aligned)
  if (orgName) {
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.darkGray);
    doc.text(orgName, x, y, {
      width: CONTENT_WIDTH,
      align: 'right',
    });
  }

  // Add vertical spacing
  doc.moveDown(1.2);

  // Report title
  doc.font('Helvetica-Bold').fontSize(16).fillColor(COLORS.textDark);
  doc.text(title, x, doc.y, { width: CONTENT_WIDTH });

  // Subtitle / date range
  if (subtitle) {
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.darkGray);
    doc.text(subtitle, x, doc.y, { width: CONTENT_WIDTH });
  }

  // Separator line
  doc.moveDown(0.5);
  doc.save();
  doc.moveTo(x, doc.y).lineTo(x + CONTENT_WIDTH, doc.y).lineWidth(1).strokeColor(COLORS.mediumGray).stroke();
  doc.restore();
  doc.moveDown(0.8);
}

// ============================================================================
// Layout: addFooter
// ============================================================================

export function addFooter(
  doc: PDFKit.PDFDocument,
  _pageNumber?: number,
  totalPages?: number,
  branding?: { brandName?: string; tagline?: string },
): void {
  const x = MARGINS.left;
  const y = PAGE_HEIGHT - 30;

  // Bottom line separator
  doc.save();
  doc.moveTo(x, y - 8).lineTo(x + CONTENT_WIDTH, y - 8).lineWidth(0.5).strokeColor(COLORS.mediumGray).stroke();
  doc.restore();

  // Left side: branding
  const brandName = branding?.brandName || 'OmniSight';
  const tagline = branding?.tagline || 'AI-Powered Workforce Intelligence';
  doc.font('Helvetica').fontSize(7).fillColor(COLORS.textLight);
  doc.text(`${brandName} \u2014 ${tagline}`, x, y);

  // Right side: page number and generation date
  const genDate = format(new Date(), 'MMM d, yyyy HH:mm');
  let rightText = `Generated: ${genDate}`;
  if (totalPages !== undefined) {
    rightText = `Page ${_pageNumber ?? 1} of ${totalPages} | ${rightText}`;
  } else if (_pageNumber !== undefined) {
    rightText = `Page ${_pageNumber} | ${rightText}`;
  }
  doc.text(rightText, x, y, {
    width: CONTENT_WIDTH,
    align: 'right',
  });
}

// ============================================================================
// Layout: addSectionTitle
// ============================================================================

export function addSectionTitle(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 40);
  const x = MARGINS.left;
  const y = doc.y;

  // Emerald left border
  doc.save();
  doc.rect(x, y, 3, 16).fill(COLORS.primary);
  doc.restore();

  // Title text
  doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.textDark);
  doc.text(title, x + 10, y + 1, { width: CONTENT_WIDTH - 10 });

  // Bottom separator
  doc.moveDown(0.3);
  doc.save();
  doc.moveTo(x, doc.y).lineTo(x + CONTENT_WIDTH, doc.y).lineWidth(0.5).strokeColor(COLORS.lightGray).stroke();
  doc.restore();
  doc.moveDown(0.6);
}

// ============================================================================
// Layout: addDivider
// ============================================================================

export function addDivider(doc: PDFKit.PDFDocument): void {
  doc.moveDown(0.3);
  const x = MARGINS.left;
  doc.save();
  doc.moveTo(x + 20, doc.y).lineTo(x + CONTENT_WIDTH - 20, doc.y).lineWidth(0.5).strokeColor(COLORS.mediumGray).stroke();
  doc.restore();
  doc.moveDown(0.5);
}

// ============================================================================
// Content: addStatsGrid
// ============================================================================

export function addStatsGrid(doc: PDFKit.PDFDocument, stats: StatItem[]): void {
  ensureSpace(doc, 70);

  const columns = stats.length <= 2 ? 2 : stats.length <= 3 ? 3 : 3;
  const colWidth = CONTENT_WIDTH / columns;
  const boxHeight = 55;
  const padding = 8;
  const x = MARGINS.left;

  for (let i = 0; i < stats.length; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const bx = x + col * colWidth;
    const by = doc.y + row * (boxHeight + 8);

    // If this row would overflow, move to a new page
    if (by + boxHeight > PAGE_HEIGHT - MARGINS.bottom) {
      doc.addPage();
      const newX = MARGINS.left;
      const newBy = doc.y;
      for (let j = i; j < stats.length; j++) {
        const newCol = j % columns;
        const cx = newX + newCol * colWidth;
        const cy = newBy;
        drawStatBox(doc, cx, cy, colWidth - 8, boxHeight, stats[j], padding);
      }
      doc.y = newBy + boxHeight + 8;
      return;
    }

    drawStatBox(doc, bx, by, colWidth - 8, boxHeight, stats[i], padding);
  }

  const totalRows = Math.ceil(stats.length / columns);
  doc.y += totalRows * (boxHeight + 8);
  doc.moveDown(0.3);
}

function drawStatBox(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  height: number,
  stat: StatItem,
  padding: number,
): void {
  // Background box with rounded corners (simulated)
  doc.save();
  doc.roundedRect(x, y, width, height, 4).fill(COLORS.lightGray);
  // Left color accent
  const accentColor = stat.color || COLORS.primary;
  doc.roundedRect(x, y, 4, height, 2).fill(accentColor);
  doc.restore();

  // Label
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.darkGray);
  doc.text(stat.label, x + padding + 4, y + 10, { width: width - padding * 2 - 4 });

  // Value
  doc.font('Helvetica-Bold').fontSize(16).fillColor(stat.color || COLORS.textDark);
  doc.text(stat.value, x + padding + 4, y + 28, { width: width - padding * 2 - 4 });
}

// ============================================================================
// Content: addDataTable
// ============================================================================

export function addDataTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: string[][],
  options?: DataTableOptions,
): void {
  const colWidths = options?.colWidths || distributeColumnWidths(headers.length);
  const rowHeight = 22;
  const headerHeight = 26;
  const x = MARGINS.left;

  // Check if we need at least space for the header + a few rows
  ensureSpace(doc, headerHeight + rowHeight * 2);

  let currentY = doc.y;

  // Draw table header
  drawTableRow(doc, x, currentY, colWidths, headers, headerHeight, {
    background: COLORS.primary,
    textColor: COLORS.white,
    bold: true,
    fontSize: 8,
  });
  currentY += headerHeight;

  // Draw data rows
  for (let i = 0; i < rows.length; i++) {
    // Check if we need a new page
    if (currentY + rowHeight > PAGE_HEIGHT - MARGINS.bottom - 10) {
      doc.addPage();
      currentY = doc.y;
      // Redraw header on new page
      drawTableRow(doc, x, currentY, colWidths, headers, headerHeight, {
        background: COLORS.primary,
        textColor: COLORS.white,
        bold: true,
        fontSize: 8,
      });
      currentY += headerHeight;
    }

    const bg = i % 2 === 0 ? COLORS.white : COLORS.lightGray;
    drawTableRow(doc, x, currentY, colWidths, rows[i], rowHeight, {
      background: bg,
      textColor: COLORS.textDark,
      bold: false,
      fontSize: 8,
    });
    currentY += rowHeight;
  }

  // Bottom border
  doc.save();
  doc.moveTo(x, currentY).lineTo(x + colWidths.reduce((a, b) => a + b, 0), currentY)
    .lineWidth(0.5).strokeColor(COLORS.mediumGray).stroke();
  doc.restore();

  doc.y = currentY + 8;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  colWidths: number[],
  cells: string[],
  height: number,
  style: { background: string; textColor: string; bold: boolean; fontSize: number },
): void {
  // Row background
  doc.save();
  doc.rect(x, y, colWidths.reduce((a, b) => a + b, 0), height).fill(style.background);
  doc.restore();

  // Draw cell borders and text
  let cx = x;
  for (let i = 0; i < cells.length; i++) {
    // Vertical grid line
    if (i > 0) {
      doc.save();
      doc.moveTo(cx, y).lineTo(cx, y + height).lineWidth(0.3).strokeColor(COLORS.mediumGray).stroke();
      doc.restore();
    }

    // Cell text
    const font = style.bold ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(font).fontSize(style.fontSize).fillColor(style.textColor);
    doc.text(truncateText(cells[i], colWidths[i] - 10), cx + 5, y + (height - style.fontSize) / 2, {
      width: colWidths[i] - 10,
      height: height,
      lineBreak: false,
      ellipsis: true,
    });

    cx += colWidths[i];
  }

  // Horizontal bottom line
  doc.save();
  doc.moveTo(x, y + height).lineTo(x + colWidths.reduce((a, b) => a + b, 0), y + height)
    .lineWidth(0.3).strokeColor(COLORS.mediumGray).stroke();
  doc.restore();
}

function distributeColumnWidths(count: number): number[] {
  const total = CONTENT_WIDTH;
  return Array(count).fill(Math.floor(total / count));
}

function truncateText(text: string, maxWidth: number): string {
  // Rough estimate: 1 character ≈ 4.5pt at fontSize 8
  const maxChars = Math.floor(maxWidth / 4.5);
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars - 2) + '...';
}

// ============================================================================
// Content: addBulletList
// ============================================================================

export function addBulletList(doc: PDFKit.PDFDocument, items: string[], options?: BulletListOptions): void {
  const indent = options?.indent || 20;
  const x = MARGINS.left + indent;
  const bulletX = MARGINS.left + 5;

  for (const item of items) {
    ensureSpace(doc, 18);

    // Bullet point
    doc.save();
    doc.circle(bulletX + 3, doc.y + 5, 1.5).fill(COLORS.accent);
    doc.restore();

    // Text
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textMedium);
    doc.text(item, x, doc.y, { width: CONTENT_WIDTH - indent });
    doc.moveDown(0.3);
  }
}

// ============================================================================
// Report: Finalize with page footers
// ============================================================================

function finalizeWithFooters(getBuffer: () => Promise<Buffer>): Promise<Buffer> {
  // We'll handle footers differently - using the bufferedPages approach
  return getBuffer();
}

// ============================================================================
// Report Generation: generateEmployeeReport
// ============================================================================

export async function generateEmployeeReport(
  employee: Partial<EmployeeData>,
  activities: Partial<ActivityData>[],
  stats: {
    totalHours: number;
    productivityPercent: number;
    activeDays: number;
    avgDailyHours: number;
    appsUsed: number;
    websitesVisited: number;
  },
  options?: ReportOptions,
): Promise<Buffer> {
  const { doc, getBuffer } = createBufferCollector(options?.branding);

  // Header
  const dateRange = options?.dateRange
    ? `${format(options.dateRange.start, 'MMM d, yyyy')} - ${format(options.dateRange.end, 'MMM d, yyyy')}`
    : format(new Date(), 'MMMM yyyy');
  addHeader(doc, 'Employee Performance Report', dateRange, options?.organization, options?.branding);
  addDivider(doc);

  // Employee name subtitle
  if (employee.name || employee.designation) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.darkGray);
    const empLine = [employee.name, employee.designation, employee.department]
      .filter(Boolean).join(' \u2022 ');
    doc.text(empLine, MARGINS.left, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.6);
  }

  // Stats Grid
  addStatsGrid(doc, [
    { label: 'Total Hours', value: `${stats.totalHours.toFixed(1)}h`, color: COLORS.primary },
    { label: 'Productivity', value: `${stats.productivityPercent.toFixed(1)}%`, color: COLORS.secondary },
    { label: 'Active Days', value: String(stats.activeDays), color: COLORS.accent },
    { label: 'Avg Daily Hours', value: `${stats.avgDailyHours.toFixed(1)}h`, color: COLORS.textDark },
    { label: 'Apps Used', value: String(stats.appsUsed), color: COLORS.darkGray },
    { label: 'Websites Visited', value: String(stats.websitesVisited), color: COLORS.darkGray },
  ]);

  // Section: Activity Summary (top apps/websites)
  addSectionTitle(doc, 'Activity Summary');

  // Group activities by app/website
  const appMap = new Map<string, { duration: number; count: number; category: string }>();
  for (const act of activities) {
    const name = act.appOrWebsite || 'Unknown';
    const existing = appMap.get(name) || { duration: 0, count: 0, category: act.category || '' };
    existing.duration += act.duration || 0;
    existing.count += 1;
    existing.category = act.category || existing.category;
    appMap.set(name, existing);
  }

  const topApps = Array.from(appMap.entries())
    .sort((a, b) => b[1].duration - a[1].duration)
    .slice(0, 10);

  if (topApps.length > 0) {
    const maxDuration = topApps[0][1].duration;
    for (const [appName, data] of topApps) {
      ensureSpace(doc, 28);
      const y = doc.y;

      // App name and duration
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.textDark);
      doc.text(appName, MARGINS.left + 5, y, { width: CONTENT_WIDTH * 0.5, lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.darkGray);
      doc.text(`${formatDuration(data.duration)} (${data.count}x)`, MARGINS.left + CONTENT_WIDTH * 0.5, y, {
        width: CONTENT_WIDTH * 0.5,
        align: 'right',
        lineBreak: false,
      });

      // Duration bar (text block representation)
      doc.y = y + 14;
      const barWidth = maxDuration > 0 ? (data.duration / maxDuration) * (CONTENT_WIDTH - 10) : 0;
      doc.save();
      doc.roundedRect(MARGINS.left + 5, doc.y, Math.max(barWidth, 4), 5, 2).fill(COLORS.lightGreen);
      doc.roundedRect(MARGINS.left + 5, doc.y, Math.max(barWidth, 4), 5, 2).fill(COLORS.accent);
      doc.restore();
      doc.y += 10;
    }
    doc.moveDown(0.3);
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textLight);
    doc.text('No activity data available.', MARGINS.left + 5, doc.y);
    doc.moveDown(0.5);
  }

  // Section: Daily Productivity Trend
  addSectionTitle(doc, 'Daily Productivity Trend');

  // Build daily summary from activities
  const dailyMap = new Map<string, { productive: number; neutral: number; unproductive: number; total: number }>();
  for (const act of activities) {
    const ts = act.timestamp instanceof Date ? act.timestamp : new Date(act.timestamp || '');
    const dayKey = format(ts, 'yyyy-MM-dd');
    const existing = dailyMap.get(dayKey) || { productive: 0, neutral: 0, unproductive: 0, total: 0 };
    const dur = act.duration || 0;
    if (act.category === 'productive') existing.productive += dur;
    else if (act.category === 'neutral') existing.neutral += dur;
    else if (act.category === 'unproductive') existing.unproductive += dur;
    existing.total += dur;
    dailyMap.set(dayKey, existing);
  }

  const dailyData = Array.from(dailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  if (dailyData.length > 0) {
    const dailyRows = dailyData.map(([date, data]) => {
      const prodPct = data.total > 0 ? ((data.productive / data.total) * 100).toFixed(1) : '0.0';
      return [
        date,
        formatDuration(data.total),
        `${prodPct}%`,
        formatDuration(data.productive),
        formatDuration(data.neutral),
        formatDuration(data.unproductive),
      ];
    });
    addDataTable(
      doc,
      ['Date', 'Total Hours', 'Productivity', 'Productive', 'Neutral', 'Unproductive'],
      dailyRows,
      { colWidths: [90, 80, 80, 80, 80, 100] },
    );
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textLight);
    doc.text('No daily data available.', MARGINS.left + 5, doc.y);
    doc.moveDown(0.5);
  }

  // Section: Category Breakdown
  const categoryMap = new Map<string, number>();
  for (const act of activities) {
    const cat = act.category || 'uncategorized';
    categoryMap.set(cat, (categoryMap.get(cat) || 0) + (act.duration || 0));
  }
  const categories = Array.from(categoryMap.entries()).sort((a, b) => b[1] - a[1]);
  if (categories.length > 0) {
    addSectionTitle(doc, 'Category Breakdown');
    const catRows = categories.map(([cat, dur]) => [cat, formatDuration(dur), `${((dur / (categoryMap.values().reduce((a, b) => a + b, 0))) * 100).toFixed(1)}%`]);
    addDataTable(doc, ['Category', 'Duration', 'Percentage'], catRows, { colWidths: [200, 150, 160] });
  }

  // Finish
  doc.end();
  return finalizeWithFooters(getBuffer);
}

// ============================================================================
// Report Generation: generateDashboardReport
// ============================================================================

export async function generateDashboardReport(
  orgData: {
    name?: string;
  },
  dashboardStats: {
    totalEmployees: number;
    activeDevices: number;
    avgProductivity: number;
    totalHoursToday: number;
    alertsPending: number;
    projectsActive: number;
    departmentBreakdown?: Array<{ name: string; employees: number; avgProductivity: number; totalHours: number }>;
    topPerformers?: Array<{ name: string; department: string; hours: number; productivity: number }>;
    deviceStatus?: Array<{ device: string; status: string; lastHeartbeat: Date | string }>;
    recentAlerts?: Partial<AlertData>[];
    activeProjects?: Array<{ name: string; status: string; progress: number; members: number; deadline: Date | string }>;
  },
  options?: ReportOptions,
): Promise<Buffer> {
  const { doc, getBuffer } = createBufferCollector(options?.branding);

  const dateRange = options?.dateRange
    ? `${format(options.dateRange.start, 'MMM d, yyyy')} - ${format(options.dateRange.end, 'MMM d, yyyy')}`
    : format(new Date(), 'MMMM d, yyyy');
  addHeader(doc, 'Dashboard Summary Report', dateRange, orgData?.name || options?.organization, options?.branding);
  addDivider(doc);

  // Stats Grid
  addStatsGrid(doc, [
    { label: 'Total Employees', value: String(dashboardStats.totalEmployees), color: COLORS.primary },
    { label: 'Active Devices', value: String(dashboardStats.activeDevices), color: COLORS.secondary },
    { label: 'Avg Productivity', value: `${dashboardStats.avgProductivity.toFixed(1)}%`, color: COLORS.accent },
    { label: 'Hours Today', value: `${dashboardStats.totalHoursToday.toFixed(1)}h`, color: COLORS.textDark },
    { label: 'Alerts Pending', value: String(dashboardStats.alertsPending), color: COLORS.alertAmber },
    { label: 'Active Projects', value: String(dashboardStats.projectsActive), color: COLORS.primary },
  ]);

  // Section: Department Breakdown
  if (dashboardStats.departmentBreakdown && dashboardStats.departmentBreakdown.length > 0) {
    addSectionTitle(doc, 'Department Breakdown');
    const deptRows = dashboardStats.departmentBreakdown.map((d) => [
      d.name,
      String(d.employees),
      `${d.avgProductivity.toFixed(1)}%`,
      `${d.totalHours.toFixed(1)}h`,
    ]);
    addDataTable(doc, ['Department', 'Employees', 'Avg Productivity', 'Total Hours'], deptRows, {
      colWidths: [180, 80, 120, 130],
    });
  }

  // Section: Top Performers
  if (dashboardStats.topPerformers && dashboardStats.topPerformers.length > 0) {
    addSectionTitle(doc, 'Top Performers');
    const perfRows = dashboardStats.topPerformers.map((p) => [
      p.name,
      p.department,
      `${p.hours.toFixed(1)}h`,
      `${p.productivity.toFixed(1)}%`,
    ]);
    addDataTable(doc, ['Name', 'Department', 'Hours', 'Productivity'], perfRows, {
      colWidths: [140, 120, 100, 150],
    });
  }

  // Section: Device Status
  if (dashboardStats.deviceStatus && dashboardStats.deviceStatus.length > 0) {
    addSectionTitle(doc, 'Device Status Summary');
    const devRows = dashboardStats.deviceStatus.map((d) => {
      const hb = d.lastHeartbeat instanceof Date ? format(d.lastHeartbeat, 'MMM d, HH:mm') : String(d.lastHeartbeat);
      return [d.device, d.status, hb];
    });
    addDataTable(doc, ['Device', 'Status', 'Last Heartbeat'], devRows, {
      colWidths: [180, 140, 190],
    });
  }

  // Section: Recent Alerts
  if (dashboardStats.recentAlerts && dashboardStats.recentAlerts.length > 0) {
    addSectionTitle(doc, 'Recent Alerts');
    const alertRows = dashboardStats.recentAlerts.map((a) => {
      const date = a.createdAt instanceof Date ? format(a.createdAt, 'MMM d, HH:mm') : String(a.createdAt);
      return [a.title || 'Untitled', a.severity || 'info', a.status || 'active', date];
    });
    addDataTable(doc, ['Title', 'Severity', 'Status', 'Date'], alertRows, {
      colWidths: [180, 90, 90, 150],
    });
  }

  // Section: Active Projects
  if (dashboardStats.activeProjects && dashboardStats.activeProjects.length > 0) {
    addSectionTitle(doc, 'Active Projects');
    const projRows = dashboardStats.activeProjects.map((p) => {
      const dl = p.deadline instanceof Date ? format(p.deadline, 'MMM d, yyyy') : String(p.deadline);
      return [p.name, p.status, `${p.progress}%`, String(p.members), dl];
    });
    addDataTable(doc, ['Name', 'Status', 'Progress', 'Members', 'Deadline'], projRows, {
      colWidths: [130, 90, 70, 70, 150],
    });
  }

  doc.end();
  return finalizeWithFooters(getBuffer);
}

// ============================================================================
// Report Generation: generateProjectReport
// ============================================================================

export async function generateProjectReport(
  project: {
    name: string;
    description?: string;
    status?: string;
    priority?: string;
    startDate?: Date | string;
    deadline?: Date | string;
    tags?: string[];
    estimatedHours?: number;
    budgetType?: string;
  },
  members: Partial<ProjectMember>[],
  timeEntries: Partial<TimeEntry>[],
  options?: ReportOptions,
): Promise<Buffer> {
  const { doc, getBuffer } = createBufferCollector(options?.branding);

  addHeader(doc, 'Project Status Report', project.name, options?.organization, options?.branding);
  addDivider(doc);

  // Stats Grid
  const totalHours = timeEntries.reduce((sum, e) => sum + (e.hours || 0), 0);
  addStatsGrid(doc, [
    { label: 'Status', value: project.status || 'N/A', color: COLORS.primary },
    { label: 'Priority', value: project.priority || 'N/A', color: COLORS.alertAmber },
    { label: 'Team Members', value: String(members.length), color: COLORS.secondary },
    { label: 'Total Hours', value: `${totalHours.toFixed(1)}h`, color: COLORS.accent },
    { label: 'Estimated Hours', value: project.estimatedHours ? `${project.estimatedHours}h` : 'N/A', color: COLORS.textDark },
    { label: 'Budget Type', value: project.budgetType || 'N/A', color: COLORS.darkGray },
  ]);

  // Section: Project Details
  addSectionTitle(doc, 'Project Details');
  const detailItems: string[] = [];
  if (project.description) detailItems.push(project.description);
  if (project.startDate) {
    const sd = project.startDate instanceof Date ? format(project.startDate, 'MMM d, yyyy') : String(project.startDate);
    detailItems.push(`Start Date: ${sd}`);
  }
  if (project.deadline) {
    const dd = project.deadline instanceof Date ? format(project.deadline, 'MMM d, yyyy') : String(project.deadline);
    detailItems.push(`Deadline: ${dd}`);
  }
  if (project.tags && project.tags.length > 0) {
    detailItems.push(`Tags: ${project.tags.join(', ')}`);
  }
  if (detailItems.length > 0) {
    addBulletList(doc, detailItems);
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textLight);
    doc.text('No project details available.', MARGINS.left + 5, doc.y);
    doc.moveDown(0.5);
  }

  // Section: Team Members
  addSectionTitle(doc, 'Team Members');
  if (members.length > 0) {
    const memberRows = members.map((m) => {
      const jd = m.joinDate instanceof Date ? format(m.joinDate, 'MMM d, yyyy') : String(m.joinDate || 'N/A');
      return [
        m.name || 'Unknown',
        m.role || 'N/A',
        `${(m.hoursPerWeek || 0).toFixed(1)}h`,
        `${(m.totalHours || 0).toFixed(1)}h`,
        jd,
      ];
    });
    addDataTable(doc, ['Name', 'Role', 'Hours/Week', 'Total Hours', 'Join Date'], memberRows, {
      colWidths: [120, 100, 80, 80, 130],
    });
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textLight);
    doc.text('No team members assigned.', MARGINS.left + 5, doc.y);
    doc.moveDown(0.5);
  }

  // Section: Time Entries
  addSectionTitle(doc, 'Time Entries');
  if (timeEntries.length > 0) {
    const entryRows = timeEntries.map((e) => {
      const ed = e.date instanceof Date ? format(e.date, 'MMM d, yyyy') : String(e.date || 'N/A');
      return [
        ed,
        e.employee || 'Unknown',
        `${(e.hours || 0).toFixed(1)}h`,
        e.category || 'General',
        e.billable ? 'Yes' : 'No',
      ];
    });
    addDataTable(doc, ['Date', 'Employee', 'Hours', 'Category', 'Billable'], entryRows, {
      colWidths: [100, 120, 70, 120, 100],
    });
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textLight);
    doc.text('No time entries recorded.', MARGINS.left + 5, doc.y);
    doc.moveDown(0.5);
  }

  // Section: Time Summary by Category
  addSectionTitle(doc, 'Time Summary by Category');
  const categoryHours = new Map<string, number>();
  for (const entry of timeEntries) {
    const cat = entry.category || 'General';
    categoryHours.set(cat, (categoryHours.get(cat) || 0) + (entry.hours || 0));
  }
  const catStats = Array.from(categoryHours.entries()).map(([cat, hrs]) => ({
    label: cat,
    value: `${hrs.toFixed(1)}h`,
    color: COLORS.primary,
  }));
  if (catStats.length > 0) {
    addStatsGrid(doc, catStats);
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textLight);
    doc.text('No categorized time data.', MARGINS.left + 5, doc.y);
    doc.moveDown(0.5);
  }

  doc.end();
  return finalizeWithFooters(getBuffer);
}

// ============================================================================
// Report Generation: generateActivityReport
// ============================================================================

export async function generateActivityReport(
  activities: Partial<ActivityData>[],
  filters: {
    dateRange?: { start: Date | string; end: Date | string };
    department?: string;
    category?: string;
    employee?: string;
  },
  summary: {
    totalActivities: number;
    totalDuration: number;
    productivePercent: number;
    neutralPercent: number;
    unproductivePercent: number;
  },
  options?: ReportOptions,
): Promise<Buffer> {
  const { doc, getBuffer } = createBufferCollector(options?.branding);

  addHeader(doc, 'Activity Log Report', undefined, options?.organization, options?.branding);
  addDivider(doc);

  // Filter summary bar
  const filterParts: string[] = [];
  if (filters.dateRange) {
    const s = filters.dateRange.start instanceof Date ? format(filters.dateRange.start, 'MMM d') : String(filters.dateRange.start);
    const e = filters.dateRange.end instanceof Date ? format(filters.dateRange.end, 'MMM d, yyyy') : String(filters.dateRange.end);
    filterParts.push(`Date Range: ${s} - ${e}`);
  }
  if (filters.department) filterParts.push(`Department: ${filters.department}`);
  if (filters.category) filterParts.push(`Category: ${filters.category}`);
  if (filters.employee) filterParts.push(`Employee: ${filters.employee}`);

  if (filterParts.length > 0) {
    ensureSpace(doc, 30);
    doc.save();
    doc.roundedRect(MARGINS.left, doc.y, CONTENT_WIDTH, 22, 3).fill(COLORS.lightGreen);
    doc.restore();
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.primary);
    doc.text(filterParts.join('  |  '), MARGINS.left + 10, doc.y - 18, { width: CONTENT_WIDTH - 20 });
    doc.moveDown(0.8);
  }

  // Stats Grid
  addStatsGrid(doc, [
    { label: 'Total Activities', value: String(summary.totalActivities), color: COLORS.primary },
    { label: 'Total Duration', value: formatDuration(summary.totalDuration), color: COLORS.secondary },
    { label: 'Productive', value: `${summary.productivePercent.toFixed(1)}%`, color: '#10b981' },
    { label: 'Neutral', value: `${summary.neutralPercent.toFixed(1)}%`, color: COLORS.alertAmber },
    { label: 'Unproductive', value: `${summary.unproductivePercent.toFixed(1)}%`, color: COLORS.alertRed },
  ]);

  // Section: Activity Log
  addSectionTitle(doc, 'Activity Log');
  if (activities.length > 0) {
    const actRows = activities.slice(0, 200).map((a) => {
      const ts = a.timestamp instanceof Date ? format(a.timestamp, 'MMM d, HH:mm') : String(a.timestamp || 'N/A');
      return [
        ts,
        a.employeeName || 'Unknown',
        a.appOrWebsite || 'N/A',
        a.category || 'N/A',
        formatDuration(a.duration || 0),
      ];
    });
    addDataTable(doc, ['Date/Time', 'Employee', 'App/Website', 'Category', 'Duration'], actRows, {
      colWidths: [100, 100, 120, 80, 110],
    });
    if (activities.length > 200) {
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.textLight);
      doc.text(`Showing top 200 of ${activities.length} activities.`, MARGINS.left + 5, doc.y);
      doc.moveDown(0.3);
    }
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textLight);
    doc.text('No activity data available for the selected filters.', MARGINS.left + 5, doc.y);
    doc.moveDown(0.5);
  }

  // Section: Top Applications
  addSectionTitle(doc, 'Top Applications');
  const appMap = new Map<string, { duration: number; count: number }>();
  for (const act of activities) {
    const name = act.appOrWebsite || 'Unknown';
    const existing = appMap.get(name) || { duration: 0, count: 0 };
    existing.duration += act.duration || 0;
    existing.count += 1;
    appMap.set(name, existing);
  }
  const topApps = Array.from(appMap.entries()).sort((a, b) => b[1].duration - a[1].duration).slice(0, 20);
  if (topApps.length > 0) {
    const appRows = topApps.map(([name, data]) => [name, formatDuration(data.duration), String(data.count)]);
    addDataTable(doc, ['Application', 'Total Duration', 'Times Used'], appRows, {
      colWidths: [250, 140, 120],
    });
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textLight);
    doc.text('No application data available.', MARGINS.left + 5, doc.y);
    doc.moveDown(0.5);
  }

  doc.end();
  return finalizeWithFooters(getBuffer);
}

// ============================================================================
// Report Generation: generateAuditReport
// ============================================================================

export async function generateAuditReport(
  auditLogs: Partial<AuditLogData>[],
  filters: {
    dateRange?: { start: Date | string; end: Date | string };
    action?: string;
    resource?: string;
    user?: string;
  },
  summary: {
    totalActions: number;
    loginLogout: number;
    creates: number;
    updates: number;
    deletes: number;
  },
  options?: ReportOptions,
): Promise<Buffer> {
  const { doc, getBuffer } = createBufferCollector(options?.branding);

  addHeader(doc, 'Audit Log Report', undefined, options?.organization, options?.branding);
  addDivider(doc);

  // Filter summary bar
  const filterParts: string[] = [];
  if (filters.dateRange) {
    const s = filters.dateRange.start instanceof Date ? format(filters.dateRange.start, 'MMM d') : String(filters.dateRange.start);
    const e = filters.dateRange.end instanceof Date ? format(filters.dateRange.end, 'MMM d, yyyy') : String(filters.dateRange.end);
    filterParts.push(`Date Range: ${s} - ${e}`);
  }
  if (filters.action) filterParts.push(`Action: ${filters.action}`);
  if (filters.resource) filterParts.push(`Resource: ${filters.resource}`);
  if (filters.user) filterParts.push(`User: ${filters.user}`);

  if (filterParts.length > 0) {
    ensureSpace(doc, 30);
    doc.save();
    doc.roundedRect(MARGINS.left, doc.y, CONTENT_WIDTH, 22, 3).fill(COLORS.lightGreen);
    doc.restore();
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.primary);
    doc.text(filterParts.join('  |  '), MARGINS.left + 10, doc.y - 18, { width: CONTENT_WIDTH - 20 });
    doc.moveDown(0.8);
  }

  // Stats Grid
  addStatsGrid(doc, [
    { label: 'Total Actions', value: String(summary.totalActions), color: COLORS.primary },
    { label: 'Login / Logout', value: String(summary.loginLogout), color: COLORS.secondary },
    { label: 'Creates', value: String(summary.creates), color: '#10b981' },
    { label: 'Updates', value: String(summary.updates), color: COLORS.alertAmber },
    { label: 'Deletes', value: String(summary.deletes), color: COLORS.alertRed },
  ]);

  // Section: Audit Trail
  addSectionTitle(doc, 'Audit Trail');
  if (auditLogs.length > 0) {
    const auditRows = auditLogs.slice(0, 200).map((log) => {
      const ts = log.timestamp instanceof Date ? format(log.timestamp, 'MMM d, HH:mm:ss') : String(log.timestamp || 'N/A');
      return [
        ts,
        log.action || 'N/A',
        log.resource || 'N/A',
        log.description || '',
        log.userName || 'Unknown',
        log.ipAddress || 'N/A',
      ];
    });
    addDataTable(doc, ['Timestamp', 'Action', 'Resource', 'Description', 'User', 'IP'], auditRows, {
      colWidths: [95, 70, 70, 115, 80, 80],
    });
    if (auditLogs.length > 200) {
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.textLight);
      doc.text(`Showing top 200 of ${auditLogs.length} entries.`, MARGINS.left + 5, doc.y);
      doc.moveDown(0.3);
    }
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textLight);
    doc.text('No audit log entries available for the selected filters.', MARGINS.left + 5, doc.y);
    doc.moveDown(0.5);
  }

  doc.end();
  return finalizeWithFooters(getBuffer);
}
