'use client';

import React, { useCallback, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  Upload,
  FileSpreadsheet,
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileUp,
} from 'lucide-react';

import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuthStore } from '@/lib/store';

// ─── Types ──────────────────────────────────────────────────────────────────

interface BulkImportDialogProps {
  importType: 'employees' | 'projects' | 'time-entries';
  title?: string;
  trigger?: React.ReactNode;
  onImportComplete?: () => void;
}

interface ImportResponse {
  success: boolean;
  imported: number;
  errors: number;
  details: {
    rows: number;
    skipped: number;
    messages: Array<{ row: number; error: string }>;
  };
}

// ─── Template Config ────────────────────────────────────────────────────────

const TEMPLATE_CONFIG: Record<
  'employees' | 'projects' | 'time-entries',
  { headers: string[]; example: string[] }
> = {
  employees: {
    headers: ['firstName', 'lastName', 'email', 'phone', 'designation', 'department', 'employeeId'],
    example: ['John', 'Doe', 'john@example.com', '+1234567890', 'Software Engineer', 'Engineering', 'EMP-001'],
  },
  projects: {
    headers: ['name', 'description', 'priority', 'deadline', 'estimatedHours', 'budgetType'],
    example: ['Website Redesign', 'Redesign company website', 'high', '2025-12-31', '200', 'fixed'],
  },
  'time-entries': {
    headers: ['employeeEmail', 'projectName', 'date', 'hours', 'description', 'category', 'billable'],
    example: ['john@example.com', 'Website Redesign', '2025-01-15', '8', 'Frontend development', 'development', 'true'],
  },
};

const TYPE_LABELS: Record<string, string> = {
  employees: 'Employees',
  projects: 'Projects',
  'time-entries': 'Time Entries',
};

// ─── Component ──────────────────────────────────────────────────────────────

export function BulkImportDialog({
  importType,
  title,
  trigger,
  onImportComplete,
}: BulkImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [previewColumns, setPreviewColumns] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dialogTitle = title || `Import ${TYPE_LABELS[importType]}`;

  // ── Reset state when dialog opens/closes ──
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        setFile(null);
        setPreviewRows([]);
        setPreviewColumns([]);
        setImportResult(null);
        setIsDragging(false);
      }
    },
    []
  );

  // ── Parse file for preview ──
  const parseFile = useCallback(async (selectedFile: File) => {
    setFile(selectedFile);
    setImportResult(null);

    try {
      const buffer = await selectedFile.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        toast.error('No sheets found in the file');
        setPreviewRows([]);
        setPreviewColumns([]);
        return;
      }
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);

      if (rows.length > 0) {
        setPreviewColumns(Object.keys(rows[0]));
        setPreviewRows(rows.slice(0, 5));
      } else {
        setPreviewColumns([]);
        setPreviewRows([]);
      }
    } catch {
      toast.error('Failed to parse file');
      setPreviewRows([]);
      setPreviewColumns([]);
    }
  }, []);

  // ── File selection handler ──
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (selected) {
        parseFile(selected);
      }
    },
    [parseFile]
  );

  // ── Drag & drop handlers ──
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const dropped = e.dataTransfer.files?.[0];
      if (dropped) {
        const ext = dropped.name.split('.').pop()?.toLowerCase();
        if (ext === 'csv' || ext === 'xlsx' || ext === 'xls') {
          parseFile(dropped);
        } else {
          toast.error('Please drop a .csv, .xlsx, or .xls file');
        }
      }
    },
    [parseFile]
  );

  // ── Download template ──
  const handleDownloadTemplate = useCallback(() => {
    const config = TEMPLATE_CONFIG[importType];
    const csvContent = [config.headers.join(','), config.example.join(',')].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${importType}-import-template.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [importType]);

  // ── Upload & import ──
  const handleImport = useCallback(async () => {
    if (!file) return;

    const token = useAuthStore.getState().token;
    if (!token) {
      toast.error('You must be logged in to import');
      return;
    }

    setIsImporting(true);
    setImportResult(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`/api/import/${importType}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      const data = (await res.json()) as ImportResponse & { error?: string };

      if (!res.ok) {
        toast.error(data.error || 'Import failed');
        setIsImporting(false);
        return;
      }

      setImportResult(data);

      if (data.imported > 0) {
        toast.success(`Successfully imported ${data.imported} ${importType}`);
      }
      if (data.errors > 0) {
        toast.warning(`${data.errors} row(s) had errors`);
      }

      if (data.imported > 0 && onImportComplete) {
        onImportComplete();
      }
    } catch {
      toast.error('Network error during import');
    } finally {
      setIsImporting(false);
    }
  }, [file, importType, onImportComplete]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Upload className="size-4 mr-2" />
            Import
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileUp className="size-5 text-primary" />
              {dialogTitle}
            </DialogTitle>
          </DialogHeader>
        </motion.div>

        <div className="flex-1 overflow-y-auto -mx-6 px-6">
          <AnimatePresence mode="wait">
            {/* ── Upload Zone ── */}
            {!file && !importResult && (
              <motion.div
                key="upload"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
                className="space-y-4"
              >
                <div
                  role="button"
                  tabIndex={0}
                  className={
                    `relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors cursor-pointer ${
                      isDragging
                        ? 'border-primary bg-primary/5'
                        : 'border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30'
                    }`
                  }
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
                  }}
                >
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <FileSpreadsheet className="size-8" />
                  </div>
                  <p className="text-sm text-muted-foreground text-center">
                    Drop file here or{' '}
                    <span className="text-primary font-medium underline underline-offset-2">
                      click to browse
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground/60">
                    Supports .csv, .xlsx, .xls files
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                </div>

                <div className="flex items-center justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDownloadTemplate}
                    className="text-muted-foreground"
                  >
                    <Download className="size-4 mr-2" />
                    Download Template
                  </Button>
                </div>
              </motion.div>
            )}

            {/* ── Preview & Import ── */}
            {file && !importResult && (
              <motion.div
                key="preview"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.2 }}
                className="space-y-4"
              >
                {/* File info bar */}
                <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileSpreadsheet className="size-5 text-primary shrink-0" />
                    <span className="text-sm font-medium truncate">{file.name}</span>
                    <Badge variant="secondary" className="shrink-0">
                      {(file.size / 1024).toFixed(1)} KB
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFile(null);
                      setPreviewRows([]);
                      setPreviewColumns([]);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                  >
                    Change
                  </Button>
                </div>

                {/* Preview table */}
                {previewRows.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground font-medium">
                      Preview (first {previewRows.length} rows)
                    </p>
                    <ScrollArea className="max-h-64 rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {previewColumns.map((col) => (
                              <TableHead key={col} className="text-xs whitespace-nowrap">
                                {col}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {previewRows.map((row, idx) => (
                            <TableRow key={idx}>
                              {previewColumns.map((col) => (
                                <TableCell key={col} className="text-xs whitespace-nowrap max-w-[200px] truncate">
                                  {row[col] ?? ''}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  </div>
                )}
              </motion.div>
            )}

            {/* ── Results ── */}
            {importResult && (
              <motion.div
                key="results"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25 }}
                className="space-y-4"
              >
                {/* Summary cards */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/50 p-4">
                    <CheckCircle2 className="size-6 text-emerald-600 dark:text-emerald-400" />
                    <div>
                      <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                        {importResult.imported}
                      </p>
                      <p className="text-xs text-emerald-600/80 dark:text-emerald-400/80">Imported</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/50 p-4">
                    <XCircle className="size-6 text-red-600 dark:text-red-400" />
                    <div>
                      <p className="text-2xl font-bold text-red-700 dark:text-red-300">
                        {importResult.errors}
                      </p>
                      <p className="text-xs text-red-600/80 dark:text-red-400/80">Errors</p>
                    </div>
                  </div>
                </div>

                {/* Error details */}
                {importResult.details.messages.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="size-4 text-amber-500" />
                      <p className="text-sm font-medium text-foreground">
                        Error Details
                      </p>
                      <Badge variant="destructive" className="text-xs">
                        {importResult.details.messages.length}
                      </Badge>
                    </div>
                    <ScrollArea className="max-h-48 rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-20 text-xs">Row</TableHead>
                            <TableHead className="text-xs">Error</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {importResult.details.messages.map((msg, idx) => (
                            <TableRow key={idx}>
                              <TableCell className="text-xs font-mono">{msg.row}</TableCell>
                              <TableCell className="text-xs text-destructive">
                                {msg.error}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Footer ── */}
        <DialogFooter className="mt-4 pt-4 border-t">
          {!importResult && (
            <div className="flex items-center justify-between w-full gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDownloadTemplate}
              >
                <Download className="size-4 mr-2" />
                Template
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!file || isImporting}
                  onClick={handleImport}
                >
                  {isImporting ? (
                    <>
                      <Loader2 className="size-4 mr-2 animate-spin" />
                      Importing…
                    </>
                  ) : (
                    <>
                      <Upload className="size-4 mr-2" />
                      Import
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
          {importResult && (
            <Button
              size="sm"
              onClick={() => handleOpenChange(false)}
            >
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
