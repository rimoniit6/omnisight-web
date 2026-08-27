'use client';

import { useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useAuthStore } from '@/lib/store';
import { useApiErrorHandler, parseAuthorizationError } from '@/lib/auth-error';
import { Mic, Upload, Search, Download, Trash2, RefreshCw, Eye, Loader2, AlertCircle } from 'lucide-react';

interface AudioRecording {
  id: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  duration: number | null;
  status: string;
  language: string | null;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  employee?: { id: string; firstName: string; lastName: string; employeeId: string } | null;
  device?: { id: string; name: string; hostname: string } | null;
  transcription?: { id: string; text: string; language: string; wordCount: number; duration: number } | null;
}

interface AudioListResponse {
  data: AudioRecording[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function statusBadge(status: string) {
  const variants: Record<string, { className: string; label: string }> = {
    uploaded: { className: 'bg-blue-100 text-blue-800', label: 'Uploaded' },
    queued: { className: 'bg-yellow-100 text-yellow-800', label: 'Queued' },
    transcribing: { className: 'bg-purple-100 text-purple-800', label: 'Transcribing' },
    completed: { className: 'bg-green-100 text-green-800', label: 'Completed' },
    failed: { className: 'bg-red-100 text-red-800', label: 'Failed' },
  };
  const v = variants[status] || { className: 'bg-gray-100 text-gray-800', label: status };
  return <Badge className={v.className}>{v.label}</Badge>;
}

export function AudioPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userRole = useAuthStore((s) => s.user?.role ?? '');
  const { handleApiError } = useApiErrorHandler();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedRecording, setSelectedRecording] = useState<AudioRecording | null>(null);
  const [showDetailDialog, setShowDetailDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AudioRecording | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(false);

  // Fetch recordings list
  const { data, isLoading, error } = useQuery<AudioListResponse>({
    queryKey: ['audio-recordings', page, search, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/audio?${params}`);
      if (!res.ok) throw new Error('Failed to fetch recordings');
      return res.json();
    },
  });

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/audio', { method: 'POST', body: formData });
      if (!res.ok) {
        const authError = await parseAuthorizationError(res);
        const err = await res.json();
        const error = new Error(err.error || 'Upload failed') as Error & { authError?: any };
        if (authError) error.authError = authError;
        throw error;
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['audio-recordings'] });
      toast({ title: 'Audio uploaded', description: 'Your audio file has been queued for transcription.' });
      setUploadProgress(false);
    },
    onError: (err: Error & { authError?: any }) => {
      if (err.authError) {
        handleApiError(err.authError, userRole);
      } else {
        toast({ title: 'Upload failed', description: err.message, variant: 'destructive' });
      }
      setUploadProgress(false);
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/audio/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const authError = await parseAuthorizationError(res);
        const err = await res.json();
        const error = new Error(err.error || 'Delete failed') as Error & { authError?: any };
        if (authError) error.authError = authError;
        throw error;
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['audio-recordings'] });
      toast({ title: 'Recording deleted' });
      setShowDeleteDialog(false);
      setDeleteTarget(null);
    },
    onError: (err: Error & { authError?: any }) => {
      if (err.authError) {
        handleApiError(err.authError, userRole);
      } else {
        toast({ title: 'Delete failed', description: err.message, variant: 'destructive' });
      }
    },
  });

  // Retry mutation
  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/audio/${id}/retry`, { method: 'POST' });
      if (!res.ok) {
        const authError = await parseAuthorizationError(res);
        const err = await res.json();
        const error = new Error(err.error || 'Retry failed') as Error & { authError?: any };
        if (authError) error.authError = authError;
        throw error;
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['audio-recordings'] });
      toast({ title: 'Retry queued', description: 'Transcription has been re-queued.' });
    },
    onError: (err: Error & { authError?: any }) => {
      if (err.authError) {
        handleApiError(err.authError, userRole);
      } else {
        toast({ title: 'Retry failed', description: err.message, variant: 'destructive' });
      }
    },
  });

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadProgress(true);
    uploadMutation.mutate(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [uploadMutation]);

  const recordings = data?.data || [];
  const totalPages = data?.totalPages || 1;

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <AlertCircle className="h-12 w-12 text-red-500 mb-4" />
            <h3 className="text-lg font-semibold mb-2">Failed to load recordings</h3>
            <p className="text-muted-foreground mb-4">{String(error)}</p>
            <Button onClick={() => queryClient.invalidateQueries({ queryKey: ['audio-recordings'] })}>
              <RefreshCw className="h-4 w-4 mr-2" /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Feature Status Banner */}
      <Card className="border-blue-200 bg-blue-50/50">
        <CardContent className="flex items-center gap-4 py-4 px-6">
          <div className="flex-shrink-0">
            <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
              <Mic className="h-5 w-5 text-blue-600" />
            </div>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-blue-900">Audio Transcription</h3>
              <Badge className="bg-green-100 text-green-800 text-xs">Available</Badge>
            </div>
            <p className="text-sm text-blue-700">
              Upload audio files for server-side transcription. Manual uploads are fully supported.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-amber-200 bg-amber-50/50">
        <CardContent className="flex items-center gap-4 py-4 px-6">
          <div className="flex-shrink-0">
            <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center">
              <Mic className="h-5 w-5 text-amber-600" />
            </div>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-amber-900">Agent Audio Capture</h3>
              <Badge className="bg-amber-100 text-amber-800 text-xs">Upcoming — Next Version</Badge>
            </div>
            <p className="text-sm text-amber-700">
              Automatic audio capture from managed agent devices and server-side transcription will be available in a future release.
            </p>
          </div>
          <Button variant="outline" disabled className="opacity-50 cursor-not-allowed">
            Coming Soon
          </Button>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Recordings</h1>
        </div>
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={handleFileUpload}
          />
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadProgress}
          >
            {uploadProgress ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-2" />
            )}
            Upload Audio
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by filename, transcription text, or employee..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter || 'all'} onValueChange={(v) => { setStatusFilter(v === 'all' ? '' : v); setPage(1); }}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="uploaded">Uploaded</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="transcribing">Transcribing</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : recordings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Mic className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No recordings found</h3>
              <p className="text-muted-foreground">
                {search || statusFilter ? 'Try adjusting your filters' : 'Upload an audio file to get started'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recordings.map((rec) => (
                  <TableRow key={rec.id}>
                    <TableCell className="font-medium max-w-[200px] truncate">{rec.fileName}</TableCell>
                    <TableCell>
                      {rec.employee ? `${rec.employee.firstName} ${rec.employee.lastName}` : '-'}
                    </TableCell>
                    <TableCell>{formatDuration(rec.duration)}</TableCell>
                    <TableCell>{rec.language?.toUpperCase() || '-'}</TableCell>
                    <TableCell>{new Date(rec.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>{statusBadge(rec.status)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setSelectedRecording(rec); setShowDetailDialog(true); }}
                          title="View"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {rec.status === 'completed' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => window.open(`/api/audio/${rec.id}/download`, '_blank')}
                            title="Download"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        )}
                        {rec.status === 'failed' && rec.retryCount < 3 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => retryMutation.mutate(rec.id)}
                            disabled={retryMutation.isPending}
                            title="Retry"
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setDeleteTarget(rec); setShowDeleteDialog(true); }}
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {((page - 1) * 20) + 1} to {Math.min(page * 20, data?.total || 0)} of {data?.total || 0}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <span className="text-sm">Page {page} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog open={showDetailDialog} onOpenChange={setShowDetailDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Recording Details</DialogTitle>
          </DialogHeader>
          {selectedRecording && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="font-medium">File:</span> {selectedRecording.fileName}</div>
                <div><span className="font-medium">Size:</span> {formatFileSize(selectedRecording.fileSize)}</div>
                <div><span className="font-medium">Status:</span> {statusBadge(selectedRecording.status)}</div>
                <div><span className="font-medium">Duration:</span> {formatDuration(selectedRecording.duration)}</div>
                <div><span className="font-medium">Language:</span> {selectedRecording.language?.toUpperCase() || '-'}</div>
                <div><span className="font-medium">Created:</span> {new Date(selectedRecording.createdAt).toLocaleString()}</div>
              </div>
              {selectedRecording.errorMessage && (
                <div className="p-3 bg-red-50 rounded text-sm text-red-800">
                  <span className="font-medium">Error:</span> {selectedRecording.errorMessage}
                </div>
              )}
              {selectedRecording.transcription && (
                <div>
                  <h4 className="font-medium mb-2">Transcription</h4>
                  <div className="p-3 bg-muted rounded text-sm max-h-60 overflow-y-auto whitespace-pre-wrap">
                    {selectedRecording.transcription.text}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {selectedRecording.transcription.wordCount} words · {selectedRecording.transcription.language?.toUpperCase()}
                  </p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Recording</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.fileName}&quot;? This action cannot be undone.
              The audio file and transcription will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setShowDeleteDialog(false); setDeleteTarget(null); }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
