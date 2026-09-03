'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Camera,
  Clock,
  AlertTriangle,
  HardDrive,
  Search,
  RefreshCw,
  LayoutGrid,
  List,
  ChevronLeft,
  ChevronRight,
  Copy,
  Sparkles,
  Flag,
  Trash2,
  Monitor,
  BrainCircuit,
  Shield,
  Zap,
  Eye,
  CheckCircle2,
  Layers,
  FileSearch,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Maximize,
  Minimize,
  ExternalLink,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmployeeCombobox } from '@/components/employees/employee-combobox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { PresenceDot } from '@/components/ui/presence-dot';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/ui/empty-state';
import { DatePickerWithRange } from '@/components/ui/date-picker-with-range';
import { DateRange } from 'react-day-picker';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/lib/store';

type ViewMode = 'grid' | 'list';
type SearchMode = 'general' | 'ocr';

interface ScreenshotItem {
  id: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  width: number | null;
  height: number | null;
  appWindow: string | null;
  ocrText: string | null;
  aiAnalysis: string | null;
  flagged: boolean;
  flagReason: string | null;
  blurScore: number | null;
  capturedAt: string;
  // Phase 2: async thumbnail processing fields (additive — null on legacy
  // rows and on screenshots that have not been processed yet).
  processingStatus?: string | null;
  processingError?: string | null;
  thumbnailPath?: string | null;
  thumbnailSize?: number | null;
  employee: { id: string; firstName: string; lastName: string; employeeId: string; avatar: string | null };
  device: { id: string; name: string; hostname: string | null; status: string } | null;
}

interface ScreenshotStats {
  total: number;
  todayCount: number;
  flaggedCount: number;
  totalStorage: number;
  recentByEmployee: { employeeId: string; _count: { id: number } }[];
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getCategory(analysis: string | null): 'Productive' | 'Neutral' | 'Unproductive' {
  if (!analysis) return 'Neutral';
  try {
    const parsed = JSON.parse(analysis);
    return parsed.category || 'Neutral';
  } catch {
    return 'Neutral';
  }
}

function getCategoryColor(cat: string) {
  if (cat === 'Productive') return 'bg-success/10 text-success border-success/25';
  if (cat === 'Unproductive') return 'bg-danger/10 text-danger border-danger/25';
  return 'bg-muted text-muted-foreground border-transparent';
}

// Neutral fallback placeholder shown behind / in place of the real image.
function getGradientForApp(_appWindow: string | null) {
  return 'from-muted to-muted/60';
}

function getInitials(firstName: string, lastName: string) {
  return `${firstName[0]}${lastName[0]}`;
}

/**
 * Thumbnail-first screenshot preview (Phase 2). Grid/list cells load the
 * small generated thumbnail (≤320px) instead of the full-resolution original;
 * the original is fetched only when the user opens a screenshot. Fallback
 * chain, in order:
 *   1. thumbnail endpoint — when the row reports processingStatus
 *      'processed' + a thumbnailPath;
 *   2. original `/image` endpoint — when no thumbnail exists yet (uploaded /
 *      processing_failed / legacy rows) or the thumbnail 404s;
 *   3. the sibling "Unavailable" placeholder — only when BOTH fail (e.g.
 *      physical file missing), mirroring the pre-Phase-2 behavior.
 * Never triggers server-side thumbnail generation from the browser.
 */
type PreviewStage = 'thumb' | 'original' | 'unavailable';

function ScreenshotPreview({
  screenshot,
  className,
  alt,
  fallbackIconClass = 'w-6 h-6 mx-auto mb-1 text-muted-foreground/50',
}: {
  screenshot: ScreenshotItem;
  className: string;
  alt: string;
  fallbackIconClass?: string;
}) {
  const thumbReady = screenshot.processingStatus === 'processed' && Boolean(screenshot.thumbnailPath);
  const [stage, setStage] = useState<PreviewStage>(thumbReady ? 'thumb' : 'original');
  const [failed, setFailed] = useState(false);

  const src =
    stage === 'thumb'
      ? `/api/screenshots/${screenshot.id}/thumbnail`
      : `/api/screenshots/${screenshot.id}/image`;

  return (
    <>
      {!failed && (
        <img
          src={src}
          alt={alt}
          loading='lazy'
          className={className}
          draggable={false}
          onError={() => {
            if (stage === 'thumb') {
              // Thumbnail unavailable — fall back to the authorized original.
              setStage('original');
            } else {
              // Original also failed — show the placeholder, stop retrying.
              setFailed(true);
            }
          }}
        />
      )}
      {/* Unavailable placeholder — visible only when both stages failed */}
      <div
        className={`absolute inset-0 items-center justify-center bg-muted/80 ${failed ? 'flex' : 'hidden'}`}
        aria-label='Screenshot unavailable'
      >
        <div className='text-center px-3'>
          <Camera className={fallbackIconClass} />
          <p className='text-[10px] text-muted-foreground'>Unavailable</p>
        </div>
      </div>
    </>
  );
}

export function ScreenshotsPage() {
  const queryClient = useQueryClient();
  // Viewers are read-only: mutation controls (analyze/batch/flag/delete) are
  // hidden — the server enforces 403 regardless.
  const currentUser = useAuthStore((s) => s.user);
  const canMutate = currentUser?.role !== 'viewer';
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('general');
  const [employeeFilter, setEmployeeFilter] = useState('all');
  const [deviceFilter, setDeviceFilter] = useState('all');
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [flaggedFilter, setFlaggedFilter] = useState('all');
  const [page, setPage] = useState(1);
  const pageSize = 24;

  // Modal state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Viewer zoom/fullscreen state. zoom === 1 means "fit to container"
  // (object-contain); zoom > 1 renders at natural pixels × zoom with pan.
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const zoomIn = () => setZoom((z) => (z === 1 ? 1.25 : Math.min(Math.round(z * 1.25 * 100) / 100, 4)));
  const zoomOut = () => setZoom((z) => (z <= 1 ? 1 : Math.max(Math.round((z / 1.25) * 100) / 100, 1)));
  const resetZoom = () => setZoom(1);

  // Zoom/natural-size are reset at every selection change (open/prev/next) —
  // never inside an effect, so a new screenshot always opens at "Fit".
  const selectScreenshot = (id: string) => {
    setSelectedId(id);
    setZoom(1);
    setNaturalSize(null);
  };

  // Fullscreen change tracking (browser / Esc key).
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Exit fullscreen when the viewer closes.
  useEffect(() => {
    if (!viewerOpen && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
  }, [viewerOpen]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void previewRef.current?.requestFullscreen?.().catch(() => {});
    }
  };
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [flagDialogOpen, setFlagDialogOpen] = useState(false);
  const [flagReasonInput, setFlagReasonInput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  // Batch analyze state
  const [selectedForBatch, setSelectedForBatch] = useState<Set<string>>(new Set());
  const [batchAnalyzing, setBatchAnalyzing] = useState(false);

  // Fetch stats
  const { data: stats } = useQuery<ScreenshotStats>({
    queryKey: ['screenshot-stats'],
    queryFn: () => fetch('/api/screenshots/stats').then((r) => r.json()),
  });

  // Build query params
  const getQueryParams = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (employeeFilter !== 'all') params.set('employeeId', employeeFilter);
    if (deviceFilter !== 'all') params.set('deviceId', deviceFilter);
    if (flaggedFilter !== 'all') params.set('flagged', flaggedFilter);
    if (dateRange?.from) params.set('dateFrom', dateRange.from.toISOString());
    if (dateRange?.to) params.set('dateTo', dateRange.to.toISOString());
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    return params.toString();
  }, [search, employeeFilter, deviceFilter, flaggedFilter, dateRange, page]);

  // Fetch screenshots (supports general + OCR search mode)
  const {
    data: screenshotsData,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['screenshots', searchMode, getQueryParams()],
    queryFn: async () => {
      let res: Response;
      if (searchMode === 'ocr' && search.trim()) {
        const params = new URLSearchParams();
        params.set('query', search);
        params.set('page', String(page));
        params.set('pageSize', String(pageSize));
        res = await fetch(`/api/screenshots/ocr-search?${params}`);
      } else {
        res = await fetch(`/api/screenshots?${getQueryParams()}`);
      }
      if (!res.ok) throw new Error(`Failed to load screenshots (${res.status})`);
      return res.json();
    },
  });

  // Fetch devices for filter
  const { data: devicesList } = useQuery({
    queryKey: ['devices-minimal'],
    queryFn: () => fetch('/api/devices?pageSize=100').then((r) => r.json()),
  });

  // Fetch selected screenshot detail
  const { data: selectedScreenshot } = useQuery({
    queryKey: ['screenshot-detail', selectedId],
    queryFn: () => fetch(`/api/screenshots/${selectedId}`).then((r) => r.json()),
    enabled: !!selectedId && viewerOpen,
  });

  const screenshots: ScreenshotItem[] = screenshotsData?.data || [];
  const totalPages = screenshotsData?.totalPages || 1;
  const total = screenshotsData?.total || 0;

  // Find current index in list for prev/next navigation
  const currentIndex = screenshots.findIndex((s) => s.id === selectedId);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < screenshots.length - 1;

  function openViewer(id: string) {
    selectScreenshot(id);
    setViewerOpen(true);
    setAnalyzing(false);
  }

  function navigatePrev() {
    if (hasPrev) {
      selectScreenshot(screenshots[currentIndex - 1].id);
    }
  }

  function navigateNext() {
    if (hasNext) {
      selectScreenshot(screenshots[currentIndex + 1].id);
    }
  }

  const zoomPercent = zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`;

  const handleAnalyze = async () => {
    if (!selectedId) return;
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/screenshots/${selectedId}/analyze`, { method: 'POST' });
      if (!res.ok) throw new Error('Analysis failed');
      toast.success('Analysis complete');
      queryClient.invalidateQueries({ queryKey: ['screenshot-detail', selectedId] });
      queryClient.invalidateQueries({ queryKey: ['screenshots'] });
      queryClient.invalidateQueries({ queryKey: ['screenshot-stats'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleFlag = async () => {
    if (!selectedId || !flagReasonInput.trim()) return;
    try {
      const res = await fetch(`/api/screenshots/${selectedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flagged: true, flagReason: flagReasonInput }),
      });
      if (!res.ok) throw new Error('Failed to flag screenshot');
      toast.success('Screenshot flagged');
      setFlagDialogOpen(false);
      setFlagReasonInput('');
      queryClient.invalidateQueries({ queryKey: ['screenshot-detail', selectedId] });
      queryClient.invalidateQueries({ queryKey: ['screenshots'] });
      queryClient.invalidateQueries({ queryKey: ['screenshot-stats'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to flag screenshot');
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/screenshots/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
    },
    onSuccess: () => {
      toast.success('Screenshot deleted');
      setDeleteDialogOpen(false);
      setViewerOpen(false);
      setSelectedId(null);
      queryClient.invalidateQueries({ queryKey: ['screenshots'] });
      queryClient.invalidateQueries({ queryKey: ['screenshot-stats'] });
    },
    onError: () => {
      toast.error('Failed to delete screenshot');
    },
  });

  function handleFilterChange() {
    setPage(1);
  }

  // Batch analyze handler
  const handleBatchAnalyze = async () => {
    if (selectedForBatch.size === 0) return;
    setBatchAnalyzing(true);
    try {
      const res = await fetch('/api/screenshots/batch-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screenshotIds: Array.from(selectedForBatch) }),
      });
      if (!res.ok) throw new Error('Batch analysis failed');
      const data = await res.json();
      const analyzed = data.analyzed ?? 0;
      const failed = data.failed ?? 0;
      if (failed > 0) {
        toast.warning(`Analyzed ${analyzed} of ${analyzed + failed} screenshots (${failed} failed)`);
      } else {
        toast.success(`Analyzed ${analyzed} screenshot(s)`);
      }
      setSelectedForBatch(new Set());
      queryClient.invalidateQueries({ queryKey: ['screenshots'] });
      queryClient.invalidateQueries({ queryKey: ['screenshot-stats'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Batch analysis failed');
    } finally {
      setBatchAnalyzing(false);
    }
  };

  const toggleBatchSelect = (id: string) => {
    setSelectedForBatch((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Stats cards
  const statCards = [
    {
      label: 'Total Screenshots',
      value: stats?.total ?? 0,
      icon: Camera,
      color: 'text-primary bg-primary/10',
    },
    {
      label: "Today's Captures",
      value: stats?.todayCount ?? 0,
      icon: Clock,
      color: 'text-info bg-info/10',
    },
    {
      label: 'Flagged for Review',
      value: stats?.flaggedCount ?? 0,
      icon: AlertTriangle,
      color: 'text-danger bg-danger/10',
    },
    {
      label: 'Storage Used',
      value: formatBytes(stats?.totalStorage ?? 0),
      icon: HardDrive,
      color: 'text-warning bg-warning/10',
    },
  ];

  const selectedCategory = selectedScreenshot?.aiAnalysis
    ? getCategory(selectedScreenshot.aiAnalysis)
    : 'Neutral';

  return (
    <div className="space-y-6" role="region" aria-label="Screenshots">
      {/* Page title */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Screenshots</h1>
        <p className="text-sm text-muted-foreground">
          View and analyze employee screenshot captures
        </p>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <div key={stat.label} className="falcon-card p-4">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${stat.color}`}>
                <stat.icon className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground truncate">{stat.label}</p>
                <p className="text-lg font-bold truncate">{stat.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="falcon-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={searchMode === 'ocr' ? 'Search OCR text content...' : 'Search by employee or app window...'}
                value={search}
                onChange={(e) => { setSearch(e.target.value); handleFilterChange(); }}
                className="pl-9 h-9"
              />
              {/* Search mode toggle */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={searchMode === 'ocr' ? 'Switch to general search' : 'Switch to OCR text search'}
                    className={cn(
                      'absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors',
                      searchMode === 'ocr' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => { setSearchMode(searchMode === 'ocr' ? 'general' : 'ocr'); handleFilterChange(); }}
                  >
                    {searchMode === 'ocr' ? <BrainCircuit className="w-3.5 h-3.5" /> : <FileSearch className="w-3.5 h-3.5" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  <p className="text-xs">{searchMode === 'ocr' ? 'Switch to general search' : 'Switch to OCR text search'}</p>
                </TooltipContent>
              </Tooltip>
              {searchMode === 'ocr' && (
                <div className="absolute -bottom-6 left-0">
                  <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/25">
                    <BrainCircuit className="w-2.5 h-2.5 mr-1" /> OCR Mode
                  </Badge>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <EmployeeCombobox
                value={employeeFilter === 'all' ? null : employeeFilter}
                onValueChange={(v) => { setEmployeeFilter((v as string) ?? 'all'); handleFilterChange(); }}
                placeholder="All Employees"
                allowClear
                clearLabel="All Employees"
                size="sm"
                className="w-[160px] h-9"
                ariaLabel="Filter by employee"
              />
              <Select
                value={deviceFilter}
                onValueChange={(v) => { setDeviceFilter(v); handleFilterChange(); }}
              >
                <SelectTrigger className="w-[150px] h-9">
                  <SelectValue placeholder="All Devices" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Devices</SelectItem>
                  {devicesList?.data?.map((dev: { id: string; name: string }) => (
                    <SelectItem key={dev.id} value={dev.id}>
                      {dev.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={flaggedFilter}
                onValueChange={(v) => { setFlaggedFilter(v); handleFilterChange(); }}
              >
                <SelectTrigger className="w-[130px] h-9">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="true">Flagged</SelectItem>
                  <SelectItem value="false">Not Flagged</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <DatePickerWithRange
                date={dateRange}
                onDateChange={(range) => { setDateRange(range); handleFilterChange(); }}
              />
            </div>
            <div className="flex items-center gap-2">
              <ToggleGroup
                type="single"
                value={viewMode}
                onValueChange={(v) => { if (v) setViewMode(v as ViewMode); }}
              >
                <ToggleGroupItem value="grid" size="sm" className="h-8 px-3">
                  <LayoutGrid className="w-4 h-4" />
                </ToggleGroupItem>
                <ToggleGroupItem value="list" size="sm" className="h-8 px-3">
                  <List className="w-4 h-4" />
                </ToggleGroupItem>
              </ToggleGroup>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                className="h-8"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Refresh
              </Button>
              {canMutate && selectedForBatch.size > 0 && (
                <Button
                  size="sm"
                  onClick={handleBatchAnalyze}
                  disabled={batchAnalyzing || selectedForBatch.size > 10}
                  className="h-8 bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {batchAnalyzing ? (
                    <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Analyzing {selectedForBatch.size}...</>
                  ) : (
                    <><Layers className="w-3.5 h-3.5 mr-1.5" /> Batch Analyze ({selectedForBatch.size})</>
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <ScreenshotSkeleton viewMode={viewMode} />
      ) : screenshots.length === 0 ? (
        <EmptyState
          icon={Camera}
          title="No screenshots found"
          description={
            search || employeeFilter !== 'all' || deviceFilter !== 'all' || flaggedFilter !== 'all'
              ? 'Try adjusting your filters to find screenshots.'
              : 'Screenshots will appear here once the monitoring agent starts capturing them.'
          }
        />
      ) : viewMode === 'grid' ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {screenshots.map((screenshot) => (
              <ScreenshotGridCard
                key={screenshot.id}
                screenshot={screenshot}
                onClick={() => openViewer(screenshot.id)}
                selected={canMutate && selectedForBatch.has(screenshot.id)}
                onToggleSelect={canMutate ? () => toggleBatchSelect(screenshot.id) : undefined}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4">
              <p className="text-sm text-muted-foreground">
                Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-sm">Page {page} of {totalPages}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <ScreenshotListView
          screenshots={screenshots}
          onOpen={openViewer}
          page={page}
          pageSize={pageSize}
          total={total}
          totalPages={totalPages}
          onPrevPage={() => setPage(page - 1)}
          onNextPage={() => setPage(page + 1)}
        />
      )}

      {/* Viewer Modal */}
      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent className="max-w-[98vw] sm:max-w-[98vw] w-[98vw] max-h-[94vh] p-0 overflow-hidden gap-0">
          <div className="flex flex-col lg:flex-row h-full">
            {/* Preview Area — full-bleed, zoomable, pannable */}
            <div ref={previewRef} className="flex-1 relative min-h-[320px] lg:min-h-0 bg-muted overflow-hidden">
              {/* Navigation arrows (fixed — panning scrolls only the image) */}
              <button
                onClick={navigatePrev}
                disabled={!hasPrev}
                aria-label="Previous screenshot"
                className="absolute left-3 top-1/2 -translate-y-1/2 z-20 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                onClick={navigateNext}
                disabled={!hasNext}
                aria-label="Next screenshot"
                className="absolute right-3 top-1/2 -translate-y-1/2 z-20 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-5 h-5" />
              </button>

              {/* Zoom / fullscreen / open-original toolbar */}
              {selectedScreenshot && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 rounded-lg border bg-background/90 backdrop-blur px-1.5 py-1 shadow-sm">
                  <button
                    onClick={zoomOut}
                    disabled={zoom <= 1}
                    aria-label="Zoom out"
                    className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="min-w-[44px] text-center text-[11px] font-medium text-muted-foreground">{zoomPercent}</span>
                  <button
                    onClick={zoomIn}
                    disabled={zoom >= 4}
                    aria-label="Zoom in"
                    className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                  <button
                    onClick={resetZoom}
                    disabled={zoom === 1}
                    aria-label="Reset zoom"
                    className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                  <span className="w-px h-4 bg-border mx-0.5" />
                  <a
                    href={`/api/screenshots/${selectedScreenshot.id}/image`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open original in new tab"
                    title="Open original"
                    className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                  <button
                    onClick={toggleFullscreen}
                    aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                    className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition"
                  >
                    {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                  </button>
                </div>
              )}

              {/* Preview — real screenshot image with gradient fallback.
                  zoom === 1: object-contain, centered, letterboxed.
                  zoom > 1: exact natural pixels × zoom inside an overflow-auto
                  wrapper so the image pans via scrollbars. */}
              <div className="absolute inset-0">
                <div
                  className={`absolute inset-0 bg-gradient-to-br ${getGradientForApp(selectedScreenshot?.appWindow || null)} flex items-center justify-center`}
                >
                  <div className="text-center text-white/90 px-6">
                    {selectedScreenshot ? (
                      <>
                        <Monitor className="w-12 h-12 mx-auto mb-3 opacity-70" />
                        <p className="text-lg font-semibold mb-1">{selectedScreenshot.appWindow || 'Unknown Application'}</p>
                        {selectedScreenshot.width && selectedScreenshot.height ? (
                          <p className="text-sm opacity-70">Screenshot preview — {selectedScreenshot.width}×{selectedScreenshot.height}</p>
                        ) : null}
                      </>
                    ) : (
                      <Skeleton className="w-48 h-6 bg-white/20" />
                    )}
                  </div>
                </div>
                <div className="absolute inset-0 overflow-auto">
                  {selectedScreenshot && (
                    <div
                      className={zoom === 1 ? 'flex min-w-full min-h-full items-center justify-center' : 'block'}
                      style={zoom !== 1 && naturalSize ? { width: naturalSize.w * zoom, height: naturalSize.h * zoom } : undefined}
                    >                        <img
                          src={`/api/screenshots/${selectedScreenshot.id}/image`}
                          alt={`Screenshot — ${selectedScreenshot.appWindow || 'Unknown Application'}`}
                          className={zoom === 1 ? 'max-w-full max-h-full object-contain' : 'block'}
                          style={zoom !== 1 && naturalSize ? { width: '100%', height: '100%' } : undefined}
                          onLoad={(e) => {
                            const img = e.currentTarget;
                            if (img.naturalWidth > 0) setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
                          }}
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                          }}
                          draggable={false}
                        />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Sidebar */}
            <div className="w-full lg:w-[360px] border-l flex flex-col">
              {selectedScreenshot ? (
                <ScrollArea className="flex-1">
                  <div className="p-4 space-y-4">
                    {/* Employee Info */}
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10">
                        <AvatarFallback className="text-xs bg-primary/10 text-primary font-semibold">
                          {getInitials(selectedScreenshot.employee.firstName, selectedScreenshot.employee.lastName)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="font-semibold text-sm truncate">
                          {selectedScreenshot.employee.firstName} {selectedScreenshot.employee.lastName}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {selectedScreenshot.employee.employeeId}
                          {selectedScreenshot.employee.department && (
                            <> · {selectedScreenshot.employee.department.name}</>
                          )}
                        </p>
                      </div>
                    </div>

                    <Separator />

                    {/* Details */}
                    <div className="space-y-2.5">
                      <DetailRow label="Device" value={selectedScreenshot.device?.name || 'Unknown'} />
                      <DetailRow
                        label="Captured"
                        value={format(new Date(selectedScreenshot.capturedAt), 'MMM d, yyyy h:mm a')}
                      />
                      <DetailRow
                        label="Relative Time"
                        value={formatDistanceToNow(new Date(selectedScreenshot.capturedAt), { addSuffix: true })}
                      />
                      <DetailRow label="File Size" value={formatBytes(selectedScreenshot.fileSize)} />
                      <DetailRow
                        label="Resolution"
                        value={selectedScreenshot.width && selectedScreenshot.height ? `${selectedScreenshot.width}×${selectedScreenshot.height}` : 'N/A'}
                      />
                      <DetailRow label="Active Window" value={selectedScreenshot.appWindow || 'N/A'} />
                      <DetailRow
                        label="Blur Score"
                        value={selectedScreenshot.blurScore !== null ? `${(selectedScreenshot.blurScore * 100).toFixed(0)}%` : 'N/A'}
                      />
                    </div>

                    {/* Flags */}
                    {selectedScreenshot.flagged && (
                      <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800">
                        <Flag className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-xs font-semibold text-rose-700 dark:text-rose-400">Flagged</p>
                          <p className="text-xs text-rose-600/80 dark:text-rose-400/70">
                            {selectedScreenshot.flagReason || 'No reason provided'}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Category Badge */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Category:</span>
                      <Badge variant="secondary" className={getCategoryColor(selectedCategory)}>
                        {selectedCategory}
                      </Badge>
                    </div>

                    <Separator />

                    {/* OCR Text */}
                    {selectedScreenshot.ocrText && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">OCR Text</p>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => {
                              navigator.clipboard.writeText(selectedScreenshot.ocrText || '');
                              toast.success('Copied to clipboard');
                            }}
                          >
                            <Copy className="w-3 h-3 mr-1" />
                            Copy
                          </Button>
                        </div>
                        <div className="p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground whitespace-pre-wrap max-h-32 overflow-y-auto custom-scrollbar">
                          {selectedScreenshot.ocrText}
                        </div>
                      </div>
                    )}

                    {/* AI Analysis */}
                    {selectedScreenshot.aiAnalysis && (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <BrainCircuit className="w-3 h-3 text-muted-foreground" />
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">AI Analysis</p>
                        </div>
                        <div className="p-3 rounded-lg bg-muted/50">
                          <AnalysisVisualization analysis={selectedScreenshot.aiAnalysis} />
                        </div>
                      </div>
                    )}

                    <Separator />

                    {/* Actions (viewers are read-only — no mutation controls) */}
                    {canMutate && (
                      <div className="space-y-2">
                        {!selectedScreenshot.aiAnalysis && (
                          <Button
                            onClick={handleAnalyze}
                            disabled={analyzing}
                            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
                            size="sm"
                          >
                            {analyzing ? (
                              <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Analyzing...</>
                            ) : (
                              <><Sparkles className="w-3.5 h-3.5 mr-1.5" /> Analyze with AI</>
                            )}
                          </Button>
                        )}
                        {!selectedScreenshot.flagged && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            onClick={() => setFlagDialogOpen(true)}
                          >
                            <Flag className="w-3.5 h-3.5 mr-1.5 text-amber-500" />
                            Flag for Review
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setDeleteDialogOpen(true)}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                          Delete Screenshot
                        </Button>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              ) : (
                <div className="flex-1 flex items-center justify-center p-8">
                  <Skeleton className="w-full h-full" />
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Flag Dialog */}
      <AlertDialog open={flagDialogOpen} onOpenChange={setFlagDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Flag Screenshot for Review</AlertDialogTitle>
            <AlertDialogDescription>
              Provide a reason for flagging this screenshot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            placeholder="Reason for flagging..."
            value={flagReasonInput}
            onChange={(e) => setFlagReasonInput(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleFlag} disabled={!flagReasonInput.trim()}>
              Flag Screenshot
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Screenshot</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this screenshot? This action cannot be undone. The screenshot file and all associated data will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
              onClick={() => selectedId && deleteMutation.mutate(selectedId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ===== Sub-components =====

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="text-xs font-medium text-right truncate">{value}</span>
    </div>
  );
}

function AnalysisVisualization({ analysis }: { analysis: string }) {
  let parsed: {
    summary?: string;
    confidence?: number;
    category?: string;
    riskLevel?: string;
    detectedElements?: string[];
    recommendations?: string[];
    timeSpent?: string;
  } | null = null;
  try {
    parsed = JSON.parse(analysis);
  } catch {
    // use raw text
  }

  if (!parsed) {
    return <p className="text-xs">{analysis}</p>;
  }

  const confidencePct = Math.round((parsed.confidence || 0) * 100);
  const riskColors: Record<string, string> = {
    low: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200',
    medium: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200',
    high: 'text-rose-600 bg-rose-50 dark:bg-rose-900/20 dark:text-rose-400 border-rose-200',
  };

  return (
    <div className="space-y-3">
      {/* Category + Confidence Row */}
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className={getCategoryColor(parsed.category || 'Neutral')}>
          {parsed.category || 'Neutral'}
        </Badge>
        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground">{confidencePct}% confidence</span>
      </div>

      {/* Confidence Bar */}
      <div className="space-y-1">
        <Progress
          value={confidencePct}
          className="h-1.5"
        />
      </div>

      {/* Risk Level */}
      {parsed.riskLevel && (
        <div className="flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Risk:</span>
          <Badge variant="outline" className={`text-[10px] ${riskColors[parsed.riskLevel] || ''}`}>
            {parsed.riskLevel.charAt(0).toUpperCase() + parsed.riskLevel.slice(1)}
          </Badge>
        </div>
      )}

      {/* Summary */}
      {parsed.summary && (
        <div className="p-2.5 rounded-lg bg-muted/50">
          <p className="text-xs leading-relaxed">{parsed.summary}</p>
        </div>
      )}

      {/* Time Spent */}
      {parsed.timeSpent && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span>Est. time: {parsed.timeSpent}</span>
        </div>
      )}

      {/* Detected Elements */}
      {parsed.detectedElements && parsed.detectedElements.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Eye className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Detected</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {parsed.detectedElements.map((el, i) => (
              <Badge key={i} variant="outline" className="text-[10px] px-1.5 py-0">
                {el}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {parsed.recommendations && parsed.recommendations.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Recommendations</span>
          </div>
          <div className="space-y-1">
            {parsed.recommendations.map((rec, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <CheckCircle2 className="w-3 h-3 text-emerald-500 mt-0.5 shrink-0" />
                <span className="text-muted-foreground">{rec}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ScreenshotGridCard({
  screenshot,
  onClick,
  selected,
  onToggleSelect,
}: {
  screenshot: ScreenshotItem;
  onClick: () => void;
  selected: boolean;
  onToggleSelect?: () => void;
}) {
  const category = getCategory(screenshot.aiAnalysis);
  const gradient = getGradientForApp(screenshot.appWindow);

  return (
    <div
      className="falcon-card overflow-hidden cursor-pointer hover:shadow-md transition-shadow group"
      onClick={onClick}
    >
      {/* Thumbnail-first preview — small generated thumbnail when processed,
          authorized original as fallback, placeholder only when both fail */}
      <div className={`relative h-40 bg-gradient-to-br ${gradient} flex items-center justify-center`}>
        <ScreenshotPreview
          screenshot={screenshot}
          alt={`Screenshot — ${screenshot.appWindow || 'Unknown Application'}`}
          className="absolute inset-0 w-full h-full object-cover"
        />
        {/* Batch select checkbox (mutations only — hidden for read-only roles) */}
        {onToggleSelect && (
          <button
            className={cn(
              'absolute top-2 right-2 z-10 w-5 h-5 rounded border-2 flex items-center justify-center transition-all',
              selected
                ? 'bg-primary border-primary text-white'
                : 'bg-white/80 border-white/60 hover:border-primary opacity-0 group-hover:opacity-100'
            )}
            onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          >
            {selected && <CheckCircle2 className="w-3 h-3" />}
          </button>
        )}
        <div className="text-center text-white/90 px-4">
          <Monitor className="w-8 h-8 mx-auto mb-2 opacity-60 group-hover:opacity-80 transition" />
          <p className="text-xs font-medium truncate max-w-[200px] mx-auto">
            {screenshot.appWindow || 'Unknown Application'}
          </p>
        </div>
        {/* Flagged badge */}
        {screenshot.flagged && (
          <div className="absolute bottom-2 right-2">
            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
              <AlertTriangle className="w-3 h-3 mr-0.5" />
              Flagged
            </Badge>
          </div>
        )}
        {/* Category badge */}
        <div className="absolute top-2 left-2">
          <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${getCategoryColor(category)}`}>
            {category}
          </Badge>
        </div>
      </div>
      {/* Info */}
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Avatar className="h-6 w-6">
            <AvatarFallback className="text-[9px] bg-primary/10 text-primary font-semibold">
              {getInitials(screenshot.employee.firstName, screenshot.employee.lastName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-medium truncate">
              <PresenceDot employeeId={screenshot.employee.id} />
              <span className="truncate">{screenshot.employee.firstName} {screenshot.employee.lastName}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="truncate">{screenshot.device?.name || 'Unknown Device'}</span>
          <span className="shrink-0">{formatDistanceToNow(new Date(screenshot.capturedAt), { addSuffix: true })}</span>
        </div>
      </div>
    </div>
  );
}

function ScreenshotListView({
  screenshots,
  onOpen,
  page,
  pageSize,
  total,
  totalPages,
  onPrevPage,
  onNextPage,
}: {
  screenshots: ScreenshotItem[];
  onOpen: (id: string) => void;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPrevPage: () => void;
  onNextPage: () => void;
}) {
  return (
    <>
      <div className="falcon-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Preview</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Employee</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Device</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">App Window</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Captured</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Size</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {screenshots.map((s) => (
                <tr
                  key={s.id}
                  className="border-b last:border-0 hover:bg-muted/20 transition-colors cursor-pointer"
                  onClick={() => onOpen(s.id)}
                >
                  <td className="px-4 py-2.5">
                    <div className="relative w-16 h-10 rounded overflow-hidden bg-muted">
                      <ScreenshotPreview
                        screenshot={s}
                        alt=""
                        className="w-full h-full object-cover"
                        fallbackIconClass="w-4 h-4 text-muted-foreground/50"
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarFallback className="text-[9px] bg-primary/10 text-primary font-semibold">
                          {getInitials(s.employee.firstName, s.employee.lastName)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="text-xs font-medium">
                          {s.employee.firstName} {s.employee.lastName}
                        </p>
                        <p className="text-[10px] text-muted-foreground">{s.employee.employeeId}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 hidden md:table-cell">
                    <span className="text-xs text-muted-foreground">{s.device?.name || '—'}</span>
                  </td>
                  <td className="px-4 py-2.5 hidden lg:table-cell">
                    <span className="text-xs truncate max-w-[180px] block">{s.appWindow || '—'}</span>
                  </td>
                  <td className="px-4 py-2.5 hidden sm:table-cell">
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(s.capturedAt), { addSuffix: true })}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 hidden md:table-cell">
                    <span className="text-xs text-muted-foreground">{formatBytes(s.fileSize)}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      {s.flagged && (
                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                          <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />
                          Flagged
                        </Badge>
                      )}
                      <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${getCategoryColor(getCategory(s.aiAnalysis))}`}>
                        {getCategory(s.aiAnalysis)}
                      </Badge>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={(e) => { e.stopPropagation(); onOpen(s.id); }}
                    >
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-4">
          <p className="text-sm text-muted-foreground">
            Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={onPrevPage}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm">Page {page} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={onNextPage}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function ScreenshotSkeleton({ viewMode }: { viewMode: ViewMode }) {
  if (viewMode === 'grid') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="falcon-card overflow-hidden">
            <Skeleton className="h-40 w-full" />
            <div className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-6 w-6 rounded-full" />
                <Skeleton className="h-4 w-24" />
              </div>
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="falcon-card overflow-hidden">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3 border-b last:border-0">
          <Skeleton className="w-16 h-10 rounded" />
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-4 w-24" />
          <div className="flex-1" />
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}
