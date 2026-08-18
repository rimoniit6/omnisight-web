'use client';

import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { useAuthStore } from '@/lib/store';
import { toast } from 'sonner';
import { Camera, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ─────────────────────────────────────────────────────────────────

interface AvatarUploadProps {
  currentAvatar: string | null;
  entityId: string;
  entityType: 'employee' | 'user';
  name: string;
  size?: 'sm' | 'md' | 'lg';
  editable?: boolean;
  onUpdated?: (avatarUrl: string) => void;
}

// ─── Size Config ────────────────────────────────────────────────────────────

const SIZE_CLASSES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-12 w-12 text-sm',
  lg: 'h-16 w-16 text-base',
} as const;

const ICON_SIZES = {
  sm: 12,
  md: 16,
  lg: 20,
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AvatarUpload({
  currentAvatar,
  entityId,
  entityType,
  name,
  size = 'md',
  editable = true,
  onUpdated,
}: AvatarUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [avatarSrc, setAvatarSrc] = useState<string | null>(currentAvatar);
  const inputRef = useRef<HTMLInputElement>(null);
  const token = useAuthStore((s) => s.token);

  const initials = getInitials(name);
  const iconSize = ICON_SIZES[size];

  const handleUpload = useCallback(
    async (file: File) => {
      if (!token) {
        toast.error('Authentication required');
        return;
      }

      setUploading(true);

      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch(
          `/api/upload/avatar?type=${entityType}&id=${entityId}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            body: formData,
          },
        );

        const data = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(data.error ?? 'Upload failed');
        }

        const newUrl: string = data.avatar;

        // Bust cache by appending timestamp
        const cacheBustedUrl = `${newUrl}?t=${Date.now()}`;
        setAvatarSrc(cacheBustedUrl);
        onUpdated?.(newUrl);
        toast.success('Avatar updated');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        toast.error(message);
      } finally {
        setUploading(false);
      }
    },
    [token, entityType, entityId, onUpdated],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleUpload(file);
        // Reset so the same file can be re-selected
        e.target.value = '';
      }
    },
    [handleUpload],
  );

  const handleClick = useCallback((e?: React.MouseEvent) => {
    if (editable && !uploading) {
      e?.stopPropagation();
      inputRef.current?.click();
    }
  }, [editable, uploading]);

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Avatar
        className={cn(
          SIZE_CLASSES[size],
          editable && 'cursor-pointer',
        )}
        onClick={handleClick}
      >
        {avatarSrc && <AvatarImage src={avatarSrc} alt={name} />}
        <AvatarFallback className={SIZE_CLASSES[size]}>
          {initials}
        </AvatarFallback>
      </Avatar>

      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
        aria-label={`Upload avatar for ${name}`}
      />

      {/* Overlay */}
      <AnimatePresence>
        {editable && hovered && !uploading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={cn(
              'absolute inset-0 flex items-center justify-center rounded-full',
              'bg-black/50 text-white',
              SIZE_CLASSES[size],
              'cursor-pointer',
            )}
            onClick={handleClick}
          >
            <Camera size={iconSize} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Loading spinner */}
      <AnimatePresence>
        {uploading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={cn(
              'absolute inset-0 flex items-center justify-center rounded-full',
              'bg-black/50 text-white',
              SIZE_CLASSES[size],
            )}
          >
            <Loader2 size={iconSize} className="animate-spin" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
