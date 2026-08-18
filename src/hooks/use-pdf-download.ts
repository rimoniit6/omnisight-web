'use client';

import { useState, useCallback } from 'react';
import { useAuthStore } from '@/lib/store';

interface PdfDownloadOptions {
  endpoint: string;
  body: Record<string, unknown>;
  filename: string;
}

export function usePdfDownload() {
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useAuthStore((s) => s.token);

  const downloadPdf = useCallback(async (options: PdfDownloadOptions) => {
    setIsDownloading(true);
    setError(null);

    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(options.body),
      });

      if (!response.ok) {
        throw new Error('Failed to generate report');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = options.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setIsDownloading(false);
    }
  }, [token]);

  return { downloadPdf, isDownloading, error };
}
