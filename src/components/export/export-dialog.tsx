'use client';

import { useState, useCallback, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuthStore } from '@/lib/store';
import { toast } from 'sonner';
import { motion, type Variants } from 'framer-motion';
import {
  FileDown,
  FileText,
  FileSpreadsheet,
  Download,
  Loader2,
  Calendar,
  Check,
} from 'lucide-react';

interface ExportColumn {
  key: string;
  label: string;
  defaultEnabled?: boolean;
}

interface ExportDialogProps {
  trigger?: React.ReactNode;
  exportType: 'employees' | 'activities' | 'time-entries' | 'projects';
  title?: string;
  availableColumns: ExportColumn[];
  filters?: Record<string, string>;
}

type ExportFormat = 'csv' | 'xlsx';

const FORMAT_CONFIG: Record<ExportFormat, { label: string; icon: typeof FileText; ext: string; mime: string }> = {
  csv: { label: 'CSV', icon: FileText, ext: 'csv', mime: 'text/csv;charset=utf-8;' },
  xlsx: { label: 'Excel', icon: FileSpreadsheet, ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};

const EXPORT_TYPE_LABELS: Record<ExportDialogProps['exportType'], string> = {
  employees: 'Employees',
  activities: 'Activities',
  'time-entries': 'Time Entries',
  projects: 'Projects',
};

import { localDayKey } from '@/lib/timezone';

function getDefaultDateRange(): { from: string; to: string } {
  const tz = useAuthStore.getState().organization?.timezone || 'UTC';
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);
  const toISO = localDayKey(now, tz);
  const fromISO = localDayKey(thirtyDaysAgo, tz);
  return { from: fromISO, to: toISO };
}

const motionVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] as const },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    transition: { duration: 0.15, ease: 'easeIn' },
  },
};

export function ExportDialog({
  trigger,
  exportType,
  title,
  availableColumns,
  filters = {},
}: ExportDialogProps) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [dateRange, setDateRange] = useState(getDefaultDateRange);
  const [exporting, setExporting] = useState(false);

  // Initialize enabled columns: defaultEnabled or true
  const [enabledColumns, setEnabledColumns] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const col of availableColumns) {
      map[col.key] = col.defaultEnabled !== undefined ? col.defaultEnabled : true;
    }
    return map;
  });

  const dialogTitle = title ?? `Export ${EXPORT_TYPE_LABELS[exportType]}`;

  const selectedCount = useMemo(
    () => Object.values(enabledColumns).filter(Boolean).length,
    [enabledColumns],
  );

  const handleToggleColumn = useCallback((key: string) => {
    setEnabledColumns((prev) => {
      const nextValue = !prev[key];
      // Ensure at least 1 column remains selected
      const currentSelected = Object.values(prev).filter(Boolean).length;
      if (!nextValue && currentSelected <= 1) {
        toast.error('At least one column must be selected');
        return prev;
      }
      return { ...prev, [key]: nextValue };
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setEnabledColumns(() => {
      const map: Record<string, boolean> = {};
      for (const col of availableColumns) {
        map[col.key] = true;
      }
      return map;
    });
  }, [availableColumns]);

  const handleDeselectAllExceptFirst = useCallback(() => {
    setEnabledColumns(() => {
      const map: Record<string, boolean> = {};
      for (let i = 0; i < availableColumns.length; i++) {
        map[availableColumns[i].key] = i === 0;
      }
      return map;
    });
  }, [availableColumns]);

  const handleExport = useCallback(async () => {
    if (exporting) return; // M-15: double-click protection
    setExporting(true);
    try {
      const selectedKeys = Object.entries(enabledColumns)
        .filter(([, v]) => v)
        .map(([k]) => k);

      const params = new URLSearchParams();
      params.set('format', format);
      params.set('columns', selectedKeys.join(','));
      params.set('from', dateRange.from);
      params.set('to', dateRange.to);

      // Append any preset filters
      for (const [key, value] of Object.entries(filters)) {
        params.set(key, value);
      }

      const url = `/api/export/${exportType}?${params.toString()}`;
      const token = useAuthStore.getState().token;

      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => 'Unknown error');
        throw new Error(errBody || `Export failed (${res.status})`);
      }

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const config = FORMAT_CONFIG[format];
      const filename = `${EXPORT_TYPE_LABELS[exportType].toLowerCase().replace(/\s+/g, '-')}-export.${config.ext}`;

      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);

      toast.success(`${dialogTitle} complete`, {
        description: `${selectedCount} columns exported as ${config.label}`,
      });

      setOpen(false);
    } catch (err) {
      toast.error('Export failed', {
        description: err instanceof Error ? err.message : 'An unexpected error occurred',
      });
    } finally {
      setExporting(false);
    }
  }, [enabledColumns, format, dateRange, filters, exportType, dialogTitle, selectedCount]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" className="gap-2">
            <Download className="h-4 w-4" />
            <span>Export</span>
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg p-0 overflow-hidden">
        <motion.div
          variants={motionVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="falcon-card rounded-lg overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-6 pt-6 pb-4">
            <div className="flex items-center justify-center size-10 rounded-lg bg-primary/10 text-primary">
              <FileDown className="size-5" />
            </div>
            <div>
              <DialogHeader className="space-y-0 gap-1">
                <DialogTitle className="text-lg">{dialogTitle}</DialogTitle>
                <DialogDescription className="text-sm">
                  Configure your export settings below
                </DialogDescription>
              </DialogHeader>
            </div>
          </div>

          {/* Body */}
          <div className="px-6 pb-2 space-y-5">
            {/* Date Range */}
            <div className="space-y-2">
              <Label className="falcon-label flex items-center gap-1.5">
                <Calendar className="size-3.5" />
                Date Range
              </Label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="export-from" className="text-xs text-muted-foreground">
                    From
                  </Label>
                  <Input
                    id="export-from"
                    type="date"
                    value={dateRange.from}
                    onChange={(e) =>
                      setDateRange((prev) => ({ ...prev, from: e.target.value }))
                    }
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="export-to" className="text-xs text-muted-foreground">
                    To
                  </Label>
                  <Input
                    id="export-to"
                    type="date"
                    value={dateRange.to}
                    onChange={(e) =>
                      setDateRange((prev) => ({ ...prev, to: e.target.value }))
                    }
                    className="h-9 text-sm"
                  />
                </div>
              </div>
            </div>

            {/* Format Selector */}
            <div className="space-y-2">
              <Label className="falcon-label">Format</Label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(FORMAT_CONFIG) as ExportFormat[]).map((fmt) => {
                  const config = FORMAT_CONFIG[fmt];
                  const isSelected = format === fmt;
                  const Icon = config.icon;
                  return (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setFormat(fmt)}
                      className={`
                        relative flex items-center justify-center gap-2 rounded-lg border-2 px-4 py-2.5
                        text-sm font-medium transition-all duration-150 cursor-pointer
                        ${
                          isSelected
                            ? 'border-primary bg-primary/5 text-primary shadow-sm'
                            : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:bg-primary/[0.02]'
                        }
                      `}
                    >
                      <Icon className="size-4" />
                      <span>{config.label}</span>
                      {isSelected && (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          className="absolute -top-1 -right-1 flex items-center justify-center size-5 rounded-full bg-primary text-primary-foreground"
                        >
                          <Check className="size-3" />
                        </motion.div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Columns */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="falcon-label">Columns</Label>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs font-normal px-2 py-0">
                    {selectedCount} of {availableColumns.length} selected
                  </Badge>
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    className="text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer"
                  >
                    All
                  </button>
                  <span className="text-xs text-muted-foreground">|</span>
                  <button
                    type="button"
                    onClick={handleDeselectAllExceptFirst}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    Min
                  </button>
                </div>
              </div>
              <ScrollArea className="max-h-48">
                <div className="space-y-1 pr-2">
                  {availableColumns.map((col) => {
                    const isChecked = enabledColumns[col.key] !== false;
                    return (
                      <label
                        key={col.key}
                        className={`
                          flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer
                          transition-colors duration-100
                          ${
                            isChecked
                              ? 'bg-primary/[0.04]'
                              : 'bg-transparent hover:bg-muted/50'
                          }
                        `}
                      >
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={() => handleToggleColumn(col.key)}
                          className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                        />
                        <span
                          className={`text-sm transition-colors ${
                            isChecked ? 'text-foreground' : 'text-muted-foreground'
                          }`}
                        >
                          {col.label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-muted/30 border-t">
            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={exporting}
                className="flex-1 sm:flex-initial"
              >
                Cancel
              </Button>
              <Button
                onClick={handleExport}
                disabled={exporting}
                className="flex-1 sm:flex-initial bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {exporting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    <span>Exporting...</span>
                  </>
                ) : (
                  <>
                    <Download className="size-4" />
                    <span>Export</span>
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}
