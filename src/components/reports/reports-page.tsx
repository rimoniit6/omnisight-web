'use client';

import { useState, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmployeeCombobox } from '@/components/employees/employee-combobox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  FileText, Download, Plus, FileSpreadsheet, File, CalendarIcon, FileDown,
  BarChart3, CheckCircle2, Loader2, CalendarDays, Eye, RefreshCw,
  TrendingUp, Clock, Activity, Building2, Monitor, User, FileJson,
} from 'lucide-react';
import { formatDistanceToNow, format, isThisMonth } from 'date-fns';
import { toast } from 'sonner';
import { exportToJSON } from '@/lib/csv-export';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { PdfDownloadButton } from '@/components/reports/pdf-download-button';

// ==================== Type Configurations ====================

const typeConfig: Record<string, {
  color: string;
  border: string;
  iconBg: string;
  iconColor: string;
  Icon: React.ElementType;
  label: string;
  description: string;
}> = {
  productivity: {
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    border: 'border-l-emerald-500',
    iconBg: 'bg-emerald-50 dark:bg-emerald-900/30',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    Icon: TrendingUp,
    label: 'Productivity',
    description: 'Overall productivity metrics, department breakdowns, and trends',
  },
  attendance: {
    color: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
    border: 'border-l-teal-500',
    iconBg: 'bg-teal-50 dark:bg-teal-900/30',
    iconColor: 'text-teal-600 dark:text-teal-400',
    Icon: Clock,
    label: 'Attendance',
    description: 'Employee attendance patterns, active days, and average daily hours',
  },
  activity: {
    color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
    border: 'border-l-cyan-500',
    iconBg: 'bg-cyan-50 dark:bg-cyan-900/30',
    iconColor: 'text-cyan-600 dark:text-cyan-400',
    Icon: Activity,
    label: 'Activity',
    description: 'Application and website usage breakdown with category distribution',
  },
  department: {
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    border: 'border-l-emerald-500',
    iconBg: 'bg-emerald-50 dark:bg-emerald-900/30',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    Icon: Building2,
    label: 'Department',
    description: 'Department-specific analytics and employee performance rankings',
  },
  device: {
    color: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
    border: 'border-l-teal-500',
    iconBg: 'bg-teal-50 dark:bg-teal-900/30',
    iconColor: 'text-teal-600 dark:text-teal-400',
    Icon: Monitor,
    label: 'Device',
    description: 'Device usage patterns, online/offline ratios, and activity stats',
  },
  employee: {
    color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
    border: 'border-l-cyan-500',
    iconBg: 'bg-cyan-50 dark:bg-cyan-900/30',
    iconColor: 'text-cyan-600 dark:text-cyan-400',
    Icon: User,
    label: 'Employee',
    description: 'Individual employee performance, top apps, and category breakdown',
  },
  organization: {
    color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
    border: 'border-l-purple-500',
    iconBg: 'bg-purple-50 dark:bg-purple-900/30',
    iconColor: 'text-purple-600 dark:text-purple-400',
    Icon: Building2,
    label: 'Organization',
    description: 'Organization-wide report',
  },
  ai_insight: {
    color: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
    border: 'border-l-rose-500',
    iconBg: 'bg-rose-50 dark:bg-rose-900/30',
    iconColor: 'text-rose-600 dark:text-rose-400',
    Icon: FileText,
    label: 'AI Insight',
    description: 'AI-generated insights report',
  },
};

const formatIcons: Record<string, React.ElementType> = {
  pdf: FileText,
  excel: FileSpreadsheet,
  csv: File,
};

const statusColors: Record<string, string> = {
  completed: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300',
  generated: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300',
  processing: 'bg-amber-100 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300',
  requested: 'bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/40 dark:text-blue-300',
  expired: 'bg-gray-100 text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-400',
};

const filterTypes = [
  { value: 'all', label: 'All' },
  { value: 'productivity', label: 'Productivity' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'activity', label: 'Activity' },
  { value: 'device', label: 'Device' },
  { value: 'department', label: 'Department' },
  { value: 'employee', label: 'Employee' },
];

// ==================== Report Type Card Grid ====================

const reportTypeCards = [
  { value: 'productivity' as const, Icon: TrendingUp, label: 'Productivity', description: 'Metrics, trends & department breakdowns', accentBg: 'bg-emerald-50 dark:bg-emerald-900/20', accentBorder: 'border-emerald-200 dark:border-emerald-800', iconColor: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-100 dark:bg-emerald-900/40' },
  { value: 'attendance' as const, Icon: Clock, label: 'Attendance', description: 'Patterns, active days & avg hours', accentBg: 'bg-teal-50 dark:bg-teal-900/20', accentBorder: 'border-teal-200 dark:border-teal-800', iconColor: 'text-teal-600 dark:text-teal-400', iconBg: 'bg-teal-100 dark:bg-teal-900/40' },
  { value: 'activity' as const, Icon: Activity, label: 'Activity', description: 'App & website usage distribution', accentBg: 'bg-cyan-50 dark:bg-cyan-900/20', accentBorder: 'border-cyan-200 dark:border-cyan-800', iconColor: 'text-cyan-600 dark:text-cyan-400', iconBg: 'bg-cyan-100 dark:bg-cyan-900/40' },
  { value: 'department' as const, Icon: Building2, label: 'Department', description: 'Department-specific analytics', accentBg: 'bg-emerald-50 dark:bg-emerald-900/20', accentBorder: 'border-emerald-200 dark:border-emerald-800', iconColor: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-100 dark:bg-emerald-900/40' },
  { value: 'device' as const, Icon: Monitor, label: 'Device', description: 'Device usage & online/offline stats', accentBg: 'bg-teal-50 dark:bg-teal-900/20', accentBorder: 'border-teal-200 dark:border-teal-800', iconColor: 'text-teal-600 dark:text-teal-400', iconBg: 'bg-teal-100 dark:bg-teal-900/40' },
  { value: 'employee' as const, Icon: User, label: 'Employee', description: 'Individual performance profile', accentBg: 'bg-cyan-50 dark:bg-cyan-900/20', accentBorder: 'border-cyan-200 dark:border-cyan-800', iconColor: 'text-cyan-600 dark:text-cyan-400', iconBg: 'bg-cyan-100 dark:bg-cyan-900/40' },
];

// ==================== Helpers ====================

function getDataSource(report: { type: string; periodStart: string | null; periodEnd: string | null }): string {
  if (report.periodStart && report.periodEnd) {
    return `${format(new Date(report.periodStart), 'MMM d')} - ${format(new Date(report.periodEnd), 'MMM d, yyyy')}`;
  }
  if (report.periodStart) {
    return `From ${format(new Date(report.periodStart), 'MMM d, yyyy')}`;
  }
  return 'All time';
}

// ==================== Main Component ====================

export function ReportsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<string>('productivity');
  const [selectedEmployee, setSelectedEmployee] = useState<string>('');
  const [selectedDepartment, setSelectedDepartment] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [dateFromOpen, setDateFromOpen] = useState(false);
  const [dateToOpen, setDateToOpen] = useState(false);

  // Custom PDF form state — intentionally separate from the Generate Report
  // dialog state so opening/closing the dialog never resets this form.

  const [generating, setGenerating] = useState(false);
  const [typeFilter, setTypeFilter] = useState('all');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Preview dialog state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);

  const queryClient = useQueryClient();

  // Fetch reports
  const { data: reports = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['reports'],
    queryFn: async () => {
      const res = await fetch('/api/reports');
      const json = await res.json();
      return json.data || [];
    },
  });

  // Fetch departments for selector
  const { data: departments = [] } = useQuery({
    queryKey: ['departments-select'],
    queryFn: async () => {
      const res = await fetch('/api/departments');
      const json = await res.json();
      return json.data || [];
    },
  });

  const stats = useMemo(() => {
    const total = reports.length;
    const completed = reports.filter((r: { status: string }) => r.status === 'completed' || r.status === 'generated').length;
    const processing = reports.filter((r: { status: string }) => r.status === 'processing').length;
    const thisMonth = reports.filter((r: { createdAt: string }) => isThisMonth(new Date(r.createdAt))).length;
    return { total, completed, processing, thisMonth };
  }, [reports]);

  const filteredReports = useMemo(() => {
    if (typeFilter === 'all') return reports;
    return reports.filter((r: { type: string }) => r.type === typeFilter);
  }, [reports, typeFilter]);

  // Show employee/department selectors based on type
  const showEmployeeSelect = selectedType === 'employee';
  const showDepartmentSelect = selectedType === 'department';

  const resetDialog = () => {
    setSelectedType('productivity');
    setSelectedEmployee('');
    setSelectedDepartment('');
    setDateFrom(undefined);
    setDateTo(undefined);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const body: Record<string, string> = { type: selectedType };
      if (selectedEmployee) body.employeeId = selectedEmployee;
      if (selectedDepartment) body.departmentId = selectedDepartment;
      if (dateFrom) body.periodStart = dateFrom.toISOString().split('T')[0];
      if (dateTo) body.periodEnd = dateTo.toISOString().split('T')[0];

      const res = await fetch('/api/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Generation failed');
      }

      toast.success('Report generated successfully');
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      setDialogOpen(false);
      resetDialog();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate report');
    } finally {
      setGenerating(false);
    }
  };

  const handleDownloadCSV = async (reportId: string, reportTitle: string) => {
    setDownloadingId(reportId);
    try {
      const res = await fetch(`/api/reports/${reportId}/csv`);
      if (!res.ok) {
        toast.error('Failed to download CSV');
        return;
      }
      const blob = await res.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = reportTitle.replace(/[^a-zA-Z0-9\-_ ]/g, '').replace(/\s+/g, '_').toLowerCase() + '.csv';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
      toast.success('CSV downloaded');
    } catch {
      toast.error('Failed to download CSV');
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDownloadJSON = async (reportId: string) => {
    setDownloadingId(reportId);
    try {
      const res = await fetch(`/api/reports/${reportId}/export`);
      const json = await res.json();
      if (json.data && json.data.length > 0) {
        exportToJSON(json.data, `report-${reportId}`);
        toast.success('JSON downloaded');
      } else {
        toast.error('No data to export');
      }
    } catch {
      toast.error('Failed to download JSON');
    } finally {
      setDownloadingId(null);
    }
  };

  const handlePreview = async (reportId: string, reportTitle: string) => {
    setPreviewTitle(reportTitle);
    setPreviewLoading(true);
    setPreviewHtml(null);
    setPreviewOpen(true);

    try {
      const res = await fetch(`/api/reports/${reportId}/pdf`);
      const json = await res.json();

      if (!res.ok) {
        toast.error(json.error || 'Failed to generate preview');
        setPreviewOpen(false);
        return;
      }

      setPreviewHtml(json.data.htmlContent);
    } catch {
      toast.error('Failed to load report preview');
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDownloadHtml = () => {
    if (!previewHtml) return;
    const blob = new Blob([previewHtml], { type: 'text/html;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${previewTitle.replace(/\s+/g, '_').toLowerCase()}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    toast.success('Report downloaded');
  };

  const statCards = [
    { label: 'Total Reports', value: stats.total, icon: BarChart3, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/30' },
    { label: 'Completed', value: stats.completed, icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/30' },
    { label: 'Processing', value: stats.processing, icon: Loader2, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/30' },
    { label: 'This Month', value: stats.thisMonth, icon: CalendarDays, color: 'text-teal-600 dark:text-teal-400', bg: 'bg-teal-50 dark:bg-teal-900/30' },
  ];

  return (
    <div className='space-y-4'>
      {/* Statistics Header */}
      <div className='grid grid-cols-2 lg:grid-cols-4 gap-3 relative z-10'>
        {statCards.map((s) => {
          const Icon = s.icon;
          return (
            <Card key={s.label} className='falcon-card falcon-card-hover'>
              <CardContent className='p-4'>
                <div className='flex items-center gap-3'>
                  <div className={cn('h-9 w-9 rounded-lg flex items-center justify-center shrink-0', s.bg)}>
                    <Icon className={cn('w-4.5 h-4.5', s.color)} />
                  </div>
                  <div className='min-w-0'>
                    <p className='text-xs text-muted-foreground'>{s.label}</p>
                    {isLoading ? (
                      <div className='h-6 w-10 mt-0.5 bg-muted/50 rounded animate-pulse' />
                    ) : (
                      <p className='text-xl font-bold'>{isError ? '—' : s.value}</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Filter Chips */}
      <div className='flex flex-wrap gap-2'>
        {filterTypes.map((ft) => (
          <button
            key={ft.value}
            type='button'
            aria-pressed={typeFilter === ft.value}
            onClick={() => setTypeFilter(ft.value)}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-full border transition-all',
              typeFilter === ft.value
                ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground'
            )}
          >
            {ft.label}
          </button>
        ))}
      </div>

      {/* Generate Button */}
      <div className='flex justify-end'>
        <Button onClick={() => { resetDialog(); setDialogOpen(true); }} className='bg-emerald-600 hover:bg-emerald-700'>
          <Plus className='w-4 h-4 mr-2' /> Generate Report
        </Button>
      </div>

      {/* ==================== PDF Report Downloads ==================== */}
      <Card className='falcon-card'>
        <CardContent className='p-4'>
          <div className='flex items-center gap-2 mb-3'>
            <div className='h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center'>
              <FileDown className='w-4 h-4 text-emerald-600 dark:text-emerald-400' />
            </div>
            <div>
              <h3 className='text-sm font-semibold'>PDF Report Downloads</h3>
              <p className='text-[11px] text-muted-foreground'>Download pre-configured PDF reports instantly</p>
            </div>
          </div>

          {/* Quick Download Buttons */}
          <div className='flex flex-wrap gap-2 mb-4'>
            <PdfDownloadButton
              endpoint='/api/reports/pdf/dashboard'
              body={{}}
              filename={`dashboard-summary-${format(new Date(), 'yyyy-MM-dd')}.pdf`}
              label='Dashboard Summary'
              variant='outline'
              size='sm'
            />
            <PdfDownloadButton
              endpoint='/api/reports/pdf/activity'
              body={{}}
              filename={`activity-log-${format(new Date(), 'yyyy-MM-dd')}.pdf`}
              label='Activity Log'
              variant='outline'
              size='sm'
            />
            <PdfDownloadButton
              endpoint='/api/reports/pdf/audit'
              body={{}}
              filename={`audit-log-${format(new Date(), 'yyyy-MM-dd')}.pdf`}
              label='Audit Log'
              variant='outline'
              size='sm'
            />
          </div>

        </CardContent>
      </Card>

      {/* Report List */}
      {isError && (
        <div className='flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3'>
          <p className='text-sm text-destructive'>Failed to load reports. Please try again.</p>
          <Button variant='outline' size='sm' onClick={() => refetch()}>
            <RefreshCw className='w-3.5 h-3.5 mr-1.5' /> Retry
          </Button>
        </div>
      )}
      {isLoading ? (
        <div className='space-y-3'>{Array.from({ length: 3 }).map((_, i) => <div key={i} className='h-20 bg-muted/30 rounded animate-pulse' />)}</div>
      ) : filteredReports.length === 0 ? (
        <EmptyState
          icon={FileText}
          title='No reports found'
          description={typeFilter !== 'all' ? `No ${typeFilter} reports have been generated yet.` : 'Generate your first report to get started.'}
          action={typeFilter !== 'all' ? { label: 'Clear Filter', onClick: () => setTypeFilter('all') } : { label: 'Generate Report', onClick: () => { resetDialog(); setDialogOpen(true); } }}
        />
      ) : (
        <div className='space-y-2'>
          {filteredReports.map((report: {
            id: string; title: string; type: string; status: string; format: string;
            createdAt: string; periodStart: string | null; periodEnd: string | null; hasData: boolean;
          }) => {
            const config = typeConfig[report.type] || typeConfig.organization;
            const TypeIcon = config?.Icon || FileText;
            const FormatIcon = formatIcons[report.format] || FileText;
            const progressPercent = report.status === 'completed' || report.status === 'generated' ? 100 : report.status === 'processing' ? 60 : 0;
            // S-4: the list exposes hasData (never the raw payload/filePath).
            const dataAvailability = report.hasData ? 'Data available' : 'No data';
            const dataSource = getDataSource(report);

            return (
              <Card
                key={report.id}
                className={cn(
                  'falcon-card falcon-card-hover border-l-4 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5',
                  config?.border || 'border-l-gray-300'
                )}
              >
                <CardContent className='p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4'>
                  {/* Type Icon Badge */}
                  <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center shrink-0', config?.iconBg || 'bg-muted')}>
                    <TypeIcon className={cn('w-5 h-5', config?.iconColor || 'text-muted-foreground')} />
                  </div>

                  {/* Main Content */}
                  <div className='flex-1 min-w-0'>
                    <div className='flex items-center gap-2 flex-wrap'>
                      <h3 className='text-sm font-semibold min-w-0 break-words'>{report.title}</h3>
                      <Badge className={cn('text-[10px] h-4 px-1.5 border-0', config?.color || 'bg-gray-100 text-gray-600')} variant='secondary'>
                        {report.type}
                      </Badge>
                      <Badge className={cn('text-[10px] h-4 px-1.5 border-0', statusColors[report.status] || '')} variant='secondary'>
                        {report.status}
                      </Badge>
                    </div>
                    <div className='flex items-center gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap'>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className='flex items-center gap-1'>
                            <FormatIcon className='w-3 h-3' />
                            {report.format.toUpperCase()}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>File format</TooltipContent>
                      </Tooltip>
                      <span>·</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{formatDistanceToNow(new Date(report.createdAt), { addSuffix: true })}</span>
                        </TooltipTrigger>
                        <TooltipContent>{format(new Date(report.createdAt), 'PPP p')}</TooltipContent>
                      </Tooltip>
                      <span>·</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{dataAvailability}</span>
                        </TooltipTrigger>
                        <TooltipContent>Whether this report contains generated data</TooltipContent>
                      </Tooltip>
                      <span>·</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className='flex items-center gap-1'>
                            <CalendarDays className='w-3 h-3' />
                            {dataSource}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>Data source period</TooltipContent>
                      </Tooltip>
                    </div>

                    {/* Progress bar */}
                    {(report.status === 'processing' || report.status === 'completed' || report.status === 'generated') && (
                      <div className='mt-2 h-1.5 w-full max-w-xs bg-muted rounded-full overflow-hidden'>
                        <div
                          className={cn(
                            'h-full rounded-full transition-all duration-500',
                            report.status === 'completed' || report.status === 'generated' ? 'bg-emerald-500' : 'bg-amber-400'
                          )}
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className='flex items-center gap-2 shrink-0 flex-wrap'>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='outline'
                          size='sm'
                          className='h-8 border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                          onClick={() => handlePreview(report.id, report.title)}
                        >
                          <Eye className='w-3.5 h-3.5 mr-1.5' /> Preview
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Preview report</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='outline'
                          size='sm'
                          className='h-8'
                          disabled={downloadingId === report.id}
                          onClick={() => handleDownloadCSV(report.id, report.title)}
                        >
                          {downloadingId === report.id ? (
                            <Loader2 className='w-3.5 h-3.5 mr-1.5 animate-spin' />
                          ) : (
                            <FileDown className='w-3.5 h-3.5 mr-1.5' />
                          )}
                          CSV
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Download as CSV</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='outline'
                          size='sm'
                          className='h-8'
                          disabled={downloadingId === report.id}
                          onClick={() => handleDownloadJSON(report.id)}
                        >
                          <FileJson className='w-3.5 h-3.5 mr-1.5' />
                          JSON
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Download as JSON</TooltipContent>
                    </Tooltip>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ==================== Generate Report Dialog ==================== */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetDialog(); }}>
        <DialogContent className='sm:max-w-2xl max-h-[90vh] overflow-y-auto'>
          <DialogHeader>
            <div className='flex items-center gap-3'>
              <div className='h-10 w-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center'>
                <BarChart3 className='w-5 h-5 text-emerald-600 dark:text-emerald-400' />
              </div>
              <div>
                <DialogTitle className='text-lg'>Generate Report</DialogTitle>
                <p className='text-sm text-muted-foreground'>Select a report type and configure filters</p>
              </div>
            </div>
          </DialogHeader>

          <div className='grid gap-6 py-2'>
            {/* Report Type Grid */}
            <div className='grid gap-2'>
              <label className='text-sm font-medium'>Report Type</label>
              <div className='grid grid-cols-2 sm:grid-cols-3 gap-2'>
                {reportTypeCards.map((card) => {
                  const isSelected = selectedType === card.value;
                  return (
                    <button
                      key={card.value}
                      type='button'
                      aria-pressed={isSelected}
                      onClick={() => setSelectedType(card.value)}
                      className={cn(
                        'relative flex flex-col items-start gap-1.5 p-3 rounded-lg border-2 text-left transition-all duration-200',
                        isSelected
                          ? cn(card.accentBg, card.accentBorder, 'shadow-sm')
                          : 'border-border bg-background hover:border-muted-foreground/30 hover:bg-muted/50'
                      )}
                    >
                      {isSelected && (
                        <div className='absolute top-1.5 right-1.5'>
                          <CheckCircle2 className={cn('w-4 h-4', card.iconColor)} />
                        </div>
                      )}
                      <div className={cn('h-8 w-8 rounded-md flex items-center justify-center', card.iconBg)}>
                        <card.Icon className={cn('w-4 h-4', card.iconColor)} />
                      </div>
                      <span className='text-xs font-semibold'>{card.label}</span>
                      <span className='text-[10px] text-muted-foreground leading-tight line-clamp-2'>{card.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Conditional Filters */}
            {(showEmployeeSelect || showDepartmentSelect) && (
              <div className='grid gap-3 sm:grid-cols-2'>
                {showDepartmentSelect && (
                  <div className='grid gap-1.5'>
                    <label className='text-sm font-medium'>Department *</label>
                    <Select value={selectedDepartment} onValueChange={setSelectedDepartment}>
                      <SelectTrigger>
                        <SelectValue placeholder='Select department...' />
                      </SelectTrigger>
                      <SelectContent>
                        {departments.map((d: { id: string; name: string }) => (
                          <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {showEmployeeSelect && (
                  <div className='grid gap-1.5'>
                    <label className='text-sm font-medium'>Employee *</label>
                    <EmployeeCombobox
                      value={selectedEmployee || null}
                      onValueChange={(v) => setSelectedEmployee((v as string) ?? '')}
                      placeholder='Select employee...'
                      labelFormat='name-id'
                      className='w-full'
                      ariaLabel='Report employee'
                    />
                  </div>
                )}
              </div>
            )}

            {/* Date Range Pickers */}
            <div className='grid gap-3 sm:grid-cols-2'>
              <div className='grid gap-1.5'>
                <label className='text-sm font-medium'>Start Date</label>
                <Popover open={dateFromOpen} onOpenChange={setDateFromOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant='outline'
                      className={cn('h-9 w-full justify-start text-left font-normal', !dateFrom && 'text-muted-foreground')}
                    >
                      <CalendarIcon className='mr-2 h-4 w-4' />
                      {dateFrom ? format(dateFrom, 'MMM d, yyyy') : 'Select start date...'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className='w-auto p-0' align='start'>
                    <Calendar
                      mode='single'
                      selected={dateFrom}
                      onSelect={(d) => { setDateFrom(d); setDateFromOpen(false); }}
                      className='rounded-md border'
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className='grid gap-1.5'>
                <label className='text-sm font-medium'>End Date</label>
                <Popover open={dateToOpen} onOpenChange={setDateToOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant='outline'
                      className={cn('h-9 w-full justify-start text-left font-normal', !dateTo && 'text-muted-foreground')}
                    >
                      <CalendarIcon className='mr-2 h-4 w-4' />
                      {dateTo ? format(dateTo, 'MMM d, yyyy') : 'Select end date...'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className='w-auto p-0' align='start'>
                    <Calendar
                      mode='single'
                      selected={dateTo}
                      onSelect={(d) => { setDateTo(d); setDateToOpen(false); }}
                      className='rounded-md border'
                      disabled={dateFrom ? { before: dateFrom } : undefined}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant='outline' onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleGenerate}
              disabled={generating || (showEmployeeSelect && !selectedEmployee) || (showDepartmentSelect && !selectedDepartment)}
              className='bg-emerald-600 hover:bg-emerald-700'
            >
              {generating ? <><Loader2 className='w-4 h-4 mr-2 animate-spin' /> Generating...</> : <><BarChart3 className='w-4 h-4 mr-2' /> Generate Report</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ==================== Preview Dialog ==================== */}
      <Dialog open={previewOpen} onOpenChange={(open) => {
        setPreviewOpen(open);
        if (!open) { setPreviewHtml(null); setPreviewTitle(''); }
      }}>
        <DialogContent className='sm:max-w-4xl h-[85vh] flex flex-col p-0'>
          <DialogHeader className='flex flex-row items-center justify-between p-4 pb-0'>
            <div className='flex items-center gap-3'>
              <div className='h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center'>
                <FileText className='w-4 h-4 text-emerald-600 dark:text-emerald-400' />
              </div>
              <div>
                <DialogTitle className='text-sm font-semibold'>{previewTitle || 'Report Preview'}</DialogTitle>
                <p className='text-[11px] text-muted-foreground'>HTML Report Preview</p>
              </div>
            </div>
          </DialogHeader>

          <div className='flex-1 min-h-0 p-4 pt-2'>
            {previewLoading ? (
              <div className='flex items-center justify-center h-full'>
                <div className='text-center space-y-3'>
                  <Loader2 className='w-8 h-8 text-emerald-600 animate-spin mx-auto' />
                  <p className='text-sm text-muted-foreground'>Generating report preview...</p>
                </div>
              </div>
            ) : previewHtml ? (
              <div className='h-full rounded-lg border border-border overflow-hidden bg-white'>
                <iframe
                  ref={previewIframeRef}
                  srcDoc={previewHtml}
                  className='w-full h-full min-h-[400px]'
                  title='Report Preview'
                  style={{ border: 'none' }}
                />
              </div>
            ) : null}
          </div>

          <div className='flex items-center justify-end gap-2 p-4 pt-2 border-t border-border'>
            <Button variant='outline' onClick={() => setPreviewOpen(false)}>Close</Button>
            <Button onClick={handleDownloadHtml} disabled={!previewHtml} className='bg-emerald-600 hover:bg-emerald-700'>
              <Download className='w-4 h-4 mr-2' /> Download HTML
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
