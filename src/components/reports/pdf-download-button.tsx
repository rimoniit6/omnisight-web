'use client';

import { FileDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePdfDownload } from '@/hooks/use-pdf-download';
import { useCallback } from 'react';

interface PdfDownloadButtonProps {
  endpoint: string;
  body: Record<string, unknown>;
  filename: string;
  label?: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
}

export function PdfDownloadButton({
  endpoint,
  body,
  filename,
  label = 'Download PDF',
  variant = 'outline',
  size = 'sm',
  className = '',
}: PdfDownloadButtonProps) {
  const { downloadPdf, isDownloading } = usePdfDownload();

  const handleClick = useCallback(() => {
    downloadPdf({ endpoint, body, filename });
  }, [downloadPdf, endpoint, body, filename]);

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={isDownloading}
      className={className}
    >
      {isDownloading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <FileDown className="h-4 w-4" />
      )}
      <span>{label}</span>
    </Button>
  );
}
