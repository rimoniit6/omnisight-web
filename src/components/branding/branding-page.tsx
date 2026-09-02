'use client';

import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuthStore } from '@/lib/store';
import { useEffectiveBranding } from '@/hooks/use-effective-branding';
import {
  Save, Upload, Trash2, RotateCcw, Loader2, Palette, Image as ImageIcon,
  Globe, Type, Tag, Eye, Check, AlertTriangle, Code, Maximize2,
} from 'lucide-react';
import Image from 'next/image';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PlatformBrandingData {
  id: string;
  brandName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  browserTitle: string | null;
  tagline: string | null;
  logoType: string | null;
  logoSvg: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
  updatedAt: string;
  updatedBy: string | null;
}

interface OrgBrandingData {
  id: string;
  organizationId: string;
  brandName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  browserTitle: string | null;
  tagline: string | null;
  logoType: string | null;
  logoSvg: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
  updatedAt: string;
  updatedBy: string | null;
}

type LogoSizePreset = 'original' | 'small' | 'medium' | 'large' | 'custom';

const LOGO_SIZE_OPTIONS: { value: LogoSizePreset; label: string; width: number }[] = [
  { value: 'original', label: 'Original / Default', width: 0 },
  { value: 'small', label: 'Small (24px)', width: 24 },
  { value: 'medium', label: 'Medium (32px)', width: 32 },
  { value: 'large', label: 'Large (48px)', width: 48 },
  { value: 'custom', label: 'Custom', width: 64 },
];

// ─── Platform Branding Section ──────────────────────────────────────────────

function PlatformBrandingSection() {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingFavicon, setUploadingFavicon] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);

  const { data: branding, isLoading } = useQuery<PlatformBrandingData>({
    queryKey: ['platform-branding'],
    queryFn: async () => {
      const res = await fetch('/api/branding/platform', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load');
      const json = await res.json();
      return json.data;
    },
  });

  const [form, setForm] = useState({
    brandName: '',
    browserTitle: '',
    primaryColor: '',
    tagline: '',
    svgCode: '',
    logoSizePreset: 'original' as LogoSizePreset,
    logoWidth: null as number | null,
    logoHeight: null as number | null,
  });

  // Sync form when data loads
  const [initialized, setInitialized] = useState(false);
  if (branding && !initialized) {
    setForm({
      brandName: branding.brandName || '',
      browserTitle: branding.browserTitle || '',
      primaryColor: branding.primaryColor || '',
      tagline: branding.tagline || '',
      svgCode: '',
      logoSizePreset: !branding.logoWidth ? 'original' :
        branding.logoWidth <= 24 ? 'small' :
        branding.logoWidth <= 32 ? 'medium' :
        branding.logoWidth <= 48 ? 'large' : 'custom',
      logoWidth: branding.logoWidth ?? null,
      logoHeight: branding.logoHeight ?? null,
    });
    setInitialized(true);
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        brandName: form.brandName || null,
        browserTitle: form.browserTitle || null,
        primaryColor: form.primaryColor || null,
        tagline: form.tagline || null,
      };

      // Include logo size settings
      if (form.logoSizePreset === 'original' || !form.logoSizePreset) {
        body.logoWidth = null;
        body.logoHeight = null;
      } else if (form.logoSizePreset === 'custom') {
        body.logoWidth = form.logoWidth || null;
        body.logoHeight = form.logoHeight || null;
      } else {
        const preset = LOGO_SIZE_OPTIONS.find((o) => o.value === form.logoSizePreset);
        body.logoWidth = preset?.width || null;
        body.logoHeight = null;
      }

      const res = await fetch('/api/branding/platform', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to update');
      }
      toast.success('Platform branding updated');
      queryClient.invalidateQueries({ queryKey: ['platform-branding'] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleSvgCodeSave = async () => {
    if (!form.svgCode.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/branding/platform', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          logoType: 'svg',
          logoSvg: form.svgCode.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save SVG');
      }
      toast.success('SVG code saved');
      queryClient.invalidateQueries({ queryKey: ['platform-branding'] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save SVG');
    } finally {
      setSaving(false);
    }
  };

  const handleSvgCodeRemove = async () => {
    try {
      const res = await fetch('/api/branding/platform', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ logoType: null, logoSvg: null }),
      });
      if (!res.ok) throw new Error('Failed to remove SVG');
      setForm((p) => ({ ...p, svgCode: '' }));
      toast.success('SVG code removed');
      queryClient.invalidateQueries({ queryKey: ['platform-branding'] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove SVG');
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/branding/platform/logo', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to upload');
      }
      toast.success('Platform logo uploaded');
      queryClient.invalidateQueries({ queryKey: ['platform-branding'] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to upload');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleLogoRemove = async () => {
    try {
      const res = await fetch('/api/branding/platform/logo', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Failed to remove');
      toast.success('Platform logo removed');
      queryClient.invalidateQueries({ queryKey: ['platform-branding'] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove');
    }
  };

  const handleFaviconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFavicon(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/branding/platform/favicon', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to upload');
      }
      toast.success('Platform favicon uploaded');
      queryClient.invalidateQueries({ queryKey: ['platform-branding'] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to upload');
    } finally {
      setUploadingFavicon(false);
      if (faviconInputRef.current) faviconInputRef.current.value = '';
    }
  };

  const handleFaviconRemove = async () => {
    try {
      const res = await fetch('/api/branding/platform/favicon', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Failed to remove');
      toast.success('Platform favicon removed');
      queryClient.invalidateQueries({ queryKey: ['platform-branding'] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove');
    }
  };

  if (isLoading) {
    return (
      <Card className="falcon-card">
        <CardContent className="p-6">
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-12 bg-muted/30 rounded animate-pulse" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="falcon-card falcon-card-hover">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="w-1 h-8 rounded-full bg-primary" />
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Palette className="w-4 h-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold">Platform Branding</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Default branding for all organizations. Super Admin only.
              </p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Logo Upload */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <ImageIcon className="w-3.5 h-3.5" /> Logo
          </Label>
          <div className="flex items-center gap-4">
            <div className="h-20 w-20 rounded-lg border border-border bg-muted/30 flex items-center justify-center overflow-hidden">
              {branding?.logoUrl ? (
                <Image
                  src={branding.logoUrl}
                  alt="Platform logo"
                  width={80}
                  height={80}
                  className="object-contain"
                  unoptimized
                />
              ) : (
                <ImageIcon className="w-8 h-8 text-muted-foreground/30" />
              )}
            </div>
            <div className="flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.svg"
                onChange={handleLogoUpload}
                className="hidden"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="gap-2"
              >
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Upload Logo
              </Button>
              {branding?.logoUrl && (
                <Button variant="ghost" size="sm" onClick={handleLogoRemove} className="gap-2 text-destructive">
                  <Trash2 className="w-3.5 h-3.5" /> Remove
                </Button>
              )}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">PNG, JPEG, WebP, or SVG. Max 5MB.</p>
        </div>

        {/* SVG Code Input */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Code className="w-3.5 h-3.5" /> SVG Code
            {branding?.logoType === 'svg' && <Badge variant="outline" className="text-[10px] h-4 px-1.5">Active</Badge>}
          </Label>
          <textarea
            value={form.svgCode}
            onChange={(e) => setForm((p) => ({ ...p, svgCode: e.target.value }))}
            placeholder="<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; viewBox=&quot;0 0 200 60&quot;>...</svg>"
            className="w-full h-32 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="SVG code editor"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSvgCodeSave}
              disabled={saving || !form.svgCode.trim()}
              className="gap-2"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save SVG Code
            </Button>
            {branding?.logoType === 'svg' && (
              <Button variant="ghost" size="sm" onClick={handleSvgCodeRemove} className="gap-2 text-destructive">
                <Trash2 className="w-3.5 h-3.5" /> Remove SVG
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">Paste SVG code directly. Server-side sanitized for security.</p>
        </div>

        {/* Logo Size Control */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Maximize2 className="w-3.5 h-3.5" /> Logo Size
          </Label>
          <div className="space-y-2">
            {LOGO_SIZE_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="platform-logo-size"
                  value={opt.value}
                  checked={(form.logoSizePreset || 'original') === opt.value}
                  onChange={() => {
                    setForm((p) => ({
                      ...p,
                      logoSizePreset: opt.value,
                      logoWidth: opt.value === 'custom' ? (p.logoWidth || 64) : opt.width || null,
                    }));
                  }}
                  className="accent-primary"
                />
                <span className="text-sm">{opt.label}</span>
              </label>
            ))}
            {form.logoSizePreset === 'custom' && (
              <div className="flex items-center gap-3 pl-6">
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Width:</Label>
                  <Input
                    type="number"
                    value={form.logoWidth || ''}
                    onChange={(e) => setForm((p) => ({ ...p, logoWidth: parseInt(e.target.value) || null }))}
                    className="w-20 h-8 text-xs"
                    min={1}
                    max={1000}
                    aria-label="Custom logo width in pixels"
                  />
                  <span className="text-xs text-muted-foreground">px</span>
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Height:</Label>
                  <Input
                    type="number"
                    value={form.logoHeight || ''}
                    onChange={(e) => setForm((p) => ({ ...p, logoHeight: parseInt(e.target.value) || null }))}
                    className="w-20 h-8 text-xs"
                    min={1}
                    max={1000}
                    placeholder="Auto"
                    aria-label="Custom logo height in pixels (optional, auto from aspect ratio)"
                  />
                  <span className="text-xs text-muted-foreground">px</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Favicon Upload */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Globe className="w-3.5 h-3.5" /> Favicon
          </Label>
          <div className="flex items-center gap-4">
            <div className="h-10 w-10 rounded border border-border bg-muted/30 flex items-center justify-center overflow-hidden">
              {branding?.faviconUrl ? (
                <Image
                  src={branding.faviconUrl}
                  alt="Platform favicon"
                  width={40}
                  height={40}
                  className="object-contain"
                  unoptimized
                />
              ) : (
                <Globe className="w-5 h-5 text-muted-foreground/30" />
              )}
            </div>
            <div className="flex flex-col gap-2">
              <input
                ref={faviconInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.svg,.ico"
                onChange={handleFaviconUpload}
                className="hidden"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => faviconInputRef.current?.click()}
                disabled={uploadingFavicon}
                className="gap-2"
              >
                {uploadingFavicon ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Upload Favicon
              </Button>
              {branding?.faviconUrl && (
                <Button variant="ghost" size="sm" onClick={handleFaviconRemove} className="gap-2 text-destructive">
                  <Trash2 className="w-3.5 h-3.5" /> Remove
                </Button>
              )}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">PNG, JPEG, WebP, SVG, or ICO. Max 2MB.</p>
        </div>

        {/* Brand Name */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Type className="w-3.5 h-3.5" /> Brand Name
          </Label>
          <Input
            value={form.brandName}
            onChange={(e) => setForm((p) => ({ ...p, brandName: e.target.value }))}
            placeholder="OmniSight"
            className="max-w-md"
          />
        </div>

        {/* Browser Title */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Globe className="w-3.5 h-3.5" /> Browser Title
          </Label>
          <Input
            value={form.browserTitle}
            onChange={(e) => setForm((p) => ({ ...p, browserTitle: e.target.value }))}
            placeholder="OmniSight - AI-Powered Workforce Intelligence"
            className="max-w-md"
          />
        </div>

        {/* Tagline */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Tag className="w-3.5 h-3.5" /> Tagline
          </Label>
          <Input
            value={form.tagline}
            onChange={(e) => setForm((p) => ({ ...p, tagline: e.target.value }))}
            placeholder="REMOTE INSIGHTS"
            className="max-w-md"
          />
        </div>

        {/* Primary Color */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Palette className="w-3.5 h-3.5" /> Primary Color
          </Label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={form.primaryColor || '#059669'}
              onChange={(e) => setForm((p) => ({ ...p, primaryColor: e.target.value }))}
              className="h-10 w-10 rounded border border-border cursor-pointer"
            />
            <Input
              value={form.primaryColor}
              onChange={(e) => setForm((p) => ({ ...p, primaryColor: e.target.value }))}
              placeholder="#059669"
              className="max-w-[140px]"
            />
          </div>
        </div>

        {/* Save */}
        <div className="flex items-center gap-2 pt-2">
          <Button onClick={handleSave} disabled={saving} className="gap-2">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save Platform Branding
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Organization Branding Section ──────────────────────────────────────────

function OrgBrandingSection() {
  const queryClient = useQueryClient();
  const organization = useAuthStore((s) => s.organization);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingFavicon, setUploadingFavicon] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);

  const { data: branding, isLoading } = useQuery<OrgBrandingData | null>({
    queryKey: ['org-branding', organization?.id],
    queryFn: async () => {
      if (!organization?.id) return null;
      const res = await fetch('/api/branding/organization', { credentials: 'same-origin' });
      if (!res.ok) return null;
      const json = await res.json();
      return json.data;
    },
    enabled: !!organization?.id,
  });

  const [form, setForm] = useState({
    brandName: '',
    browserTitle: '',
    primaryColor: '',
    tagline: '',
    svgCode: '',
    logoSizePreset: 'original' as LogoSizePreset,
    logoWidth: null as number | null,
    logoHeight: null as number | null,
  });

  const [initialized, setInitialized] = useState(false);
  if (branding && !initialized) {
    setForm({
      brandName: branding.brandName || '',
      browserTitle: branding.browserTitle || '',
      primaryColor: branding.primaryColor || '',
      tagline: branding.tagline || '',
      svgCode: '',
      logoSizePreset: !branding.logoWidth ? 'original' :
        branding.logoWidth <= 24 ? 'small' :
        branding.logoWidth <= 32 ? 'medium' :
        branding.logoWidth <= 48 ? 'large' : 'custom',
      logoWidth: branding.logoWidth ?? null,
      logoHeight: branding.logoHeight ?? null,
    });
    setInitialized(true);
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        brandName: form.brandName || null,
        browserTitle: form.browserTitle || null,
        primaryColor: form.primaryColor || null,
        tagline: form.tagline || null,
      };

      // Include logo size settings
      if (form.logoSizePreset === 'original' || !form.logoSizePreset) {
        body.logoWidth = null;
        body.logoHeight = null;
      } else if (form.logoSizePreset === 'custom') {
        body.logoWidth = form.logoWidth || null;
        body.logoHeight = form.logoHeight || null;
      } else {
        const preset = LOGO_SIZE_OPTIONS.find((o) => o.value === form.logoSizePreset);
        body.logoWidth = preset?.width || null;
        body.logoHeight = null;
      }

      const res = await fetch('/api/branding/organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to update');
      }
      toast.success('Organization branding updated');
      queryClient.invalidateQueries({ queryKey: ['org-branding', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding', organization?.id] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleSvgCodeSave = async () => {
    if (!form.svgCode.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/branding/organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          logoType: 'svg',
          logoSvg: form.svgCode.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save SVG');
      }
      toast.success('SVG code saved');
      queryClient.invalidateQueries({ queryKey: ['org-branding', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding', organization?.id] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save SVG');
    } finally {
      setSaving(false);
    }
  };

  const handleSvgCodeRemove = async () => {
    try {
      const res = await fetch('/api/branding/organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ logoType: null, logoSvg: null }),
      });
      if (!res.ok) throw new Error('Failed to remove SVG');
      setForm((p) => ({ ...p, svgCode: '' }));
      toast.success('SVG code removed');
      queryClient.invalidateQueries({ queryKey: ['org-branding', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding', organization?.id] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove SVG');
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/branding/organization/logo', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to upload');
      }
      toast.success('Organization logo uploaded');
      queryClient.invalidateQueries({ queryKey: ['org-branding', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding', organization?.id] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to upload');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleLogoRemove = async () => {
    try {
      const res = await fetch('/api/branding/organization/logo', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Failed to remove');
      toast.success('Organization logo removed');
      queryClient.invalidateQueries({ queryKey: ['org-branding', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding', organization?.id] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove');
    }
  };

  const handleFaviconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFavicon(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/branding/organization/favicon', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to upload');
      }
      toast.success('Organization favicon uploaded');
      queryClient.invalidateQueries({ queryKey: ['org-branding', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding', organization?.id] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to upload');
    } finally {
      setUploadingFavicon(false);
      if (faviconInputRef.current) faviconInputRef.current.value = '';
    }
  };

  const handleFaviconRemove = async () => {
    try {
      const res = await fetch('/api/branding/organization/favicon', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Failed to remove');
      toast.success('Organization favicon removed');
      queryClient.invalidateQueries({ queryKey: ['org-branding', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['effective-branding', organization?.id] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove');
    }
  };

  if (!organization) {
    return (
      <Card className="falcon-card">
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground text-center py-8">
            No organization selected. Switch to an organization to manage its branding.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card className="falcon-card">
        <CardContent className="p-6">
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-12 bg-muted/30 rounded animate-pulse" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="falcon-card falcon-card-hover">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="w-1 h-8 rounded-full bg-emerald-500" />
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-900/40 flex items-center justify-center">
              <Palette className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold">
                Organization Branding — {organization.name}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Override platform defaults. Leave fields empty to inherit from platform.
              </p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Inheritance indicator */}
        <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border border-border">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Fields left empty will inherit the platform default. Use &quot;Reset to Platform Default&quot; to clear a custom value.
          </p>
        </div>

        {/* Logo Upload */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <ImageIcon className="w-3.5 h-3.5" /> Logo
            {branding?.logoUrl && <Badge variant="outline" className="text-[10px] h-4 px-1.5">Custom</Badge>}
            {!branding?.logoUrl && <Badge variant="secondary" className="text-[10px] h-4 px-1.5">Inherited</Badge>}
          </Label>
          <div className="flex items-center gap-4">
            <div className="h-20 w-20 rounded-lg border border-border bg-muted/30 flex items-center justify-center overflow-hidden">
              {branding?.logoUrl ? (
                <Image
                  src={branding.logoUrl}
                  alt="Organization logo"
                  width={80}
                  height={80}
                  className="object-contain"
                  unoptimized
                />
              ) : (
                <div className="text-center">
                  <ImageIcon className="w-6 h-6 text-muted-foreground/30 mx-auto" />
                  <p className="text-[9px] text-muted-foreground mt-1">Using platform</p>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.svg"
                onChange={handleLogoUpload}
                className="hidden"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="gap-2"
              >
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Upload Logo
              </Button>
              {branding?.logoUrl && (
                <Button variant="ghost" size="sm" onClick={handleLogoRemove} className="gap-2 text-destructive">
                  <Trash2 className="w-3.5 h-3.5" /> Reset to Platform Default
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* SVG Code Input */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Code className="w-3.5 h-3.5" /> SVG Code
            {branding?.logoType === 'svg' && <Badge variant="outline" className="text-[10px] h-4 px-1.5">Active</Badge>}
            {branding?.logoType !== 'svg' && <Badge variant="secondary" className="text-[10px] h-4 px-1.5">Inherited</Badge>}
          </Label>
          <textarea
            value={form.svgCode}
            onChange={(e) => setForm((p) => ({ ...p, svgCode: e.target.value }))}
            placeholder="<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; viewBox=&quot;0 0 200 60&quot;>...</svg>"
            className="w-full h-32 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="SVG code editor"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSvgCodeSave}
              disabled={saving || !form.svgCode.trim()}
              className="gap-2"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save SVG Code
            </Button>
            {branding?.logoType === 'svg' && (
              <Button variant="ghost" size="sm" onClick={handleSvgCodeRemove} className="gap-2 text-destructive">
                <Trash2 className="w-3.5 h-3.5" /> Reset to Platform Default
              </Button>
            )}
          </div>
        </div>

        {/* Logo Size Control */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Maximize2 className="w-3.5 h-3.5" /> Logo Size
            {(form.logoSizePreset !== 'original' || branding?.logoWidth) && <Badge variant="outline" className="text-[10px] h-4 px-1.5">Custom</Badge>}
            {(form.logoSizePreset === 'original' && !branding?.logoWidth) && <Badge variant="secondary" className="text-[10px] h-4 px-1.5">Inherited</Badge>}
          </Label>
          <div className="space-y-2">
            {LOGO_SIZE_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="org-logo-size"
                  value={opt.value}
                  checked={(form.logoSizePreset || 'original') === opt.value}
                  onChange={() => {
                    setForm((p) => ({
                      ...p,
                      logoSizePreset: opt.value,
                      logoWidth: opt.value === 'custom' ? (p.logoWidth || 64) : opt.width || null,
                    }));
                  }}
                  className="accent-primary"
                />
                <span className="text-sm">{opt.label}</span>
              </label>
            ))}
            {form.logoSizePreset === 'custom' && (
              <div className="flex items-center gap-3 pl-6">
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Width:</Label>
                  <Input
                    type="number"
                    value={form.logoWidth || ''}
                    onChange={(e) => setForm((p) => ({ ...p, logoWidth: parseInt(e.target.value) || null }))}
                    className="w-20 h-8 text-xs"
                    min={1}
                    max={1000}
                    aria-label="Custom logo width in pixels"
                  />
                  <span className="text-xs text-muted-foreground">px</span>
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Height:</Label>
                  <Input
                    type="number"
                    value={form.logoHeight || ''}
                    onChange={(e) => setForm((p) => ({ ...p, logoHeight: parseInt(e.target.value) || null }))}
                    className="w-20 h-8 text-xs"
                    min={1}
                    max={1000}
                    placeholder="Auto"
                    aria-label="Custom logo height in pixels (optional, auto from aspect ratio)"
                  />
                  <span className="text-xs text-muted-foreground">px</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Favicon Upload */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Globe className="w-3.5 h-3.5" /> Favicon
            {branding?.faviconUrl ? <Badge variant="outline" className="text-[10px] h-4 px-1.5">Custom</Badge> : <Badge variant="secondary" className="text-[10px] h-4 px-1.5">Inherited</Badge>}
          </Label>
          <div className="flex items-center gap-4">
            <div className="h-10 w-10 rounded border border-border bg-muted/30 flex items-center justify-center overflow-hidden">
              {branding?.faviconUrl ? (
                <Image
                  src={branding.faviconUrl}
                  alt="Organization favicon"
                  width={40}
                  height={40}
                  className="object-contain"
                  unoptimized
                />
              ) : (
                <div className="text-center">
                  <Globe className="w-4 h-4 text-muted-foreground/30 mx-auto" />
                  <p className="text-[8px] text-muted-foreground mt-0.5">Inherited</p>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <input
                ref={faviconInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.svg,.ico"
                onChange={handleFaviconUpload}
                className="hidden"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => faviconInputRef.current?.click()}
                disabled={uploadingFavicon}
                className="gap-2"
              >
                {uploadingFavicon ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Upload Favicon
              </Button>
              {branding?.faviconUrl && (
                <Button variant="ghost" size="sm" onClick={handleFaviconRemove} className="gap-2 text-destructive">
                  <Trash2 className="w-3.5 h-3.5" /> Reset to Platform Default
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Brand Name */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Type className="w-3.5 h-3.5" /> Brand Name
            {form.brandName ? <Badge variant="outline" className="text-[10px] h-4 px-1.5">Custom</Badge> : <Badge variant="secondary" className="text-[10px] h-4 px-1.5">Inherited</Badge>}
          </Label>
          <Input
            value={form.brandName}
            onChange={(e) => setForm((p) => ({ ...p, brandName: e.target.value }))}
            placeholder="Leave empty to inherit from platform"
            className="max-w-md"
          />
        </div>

        {/* Browser Title */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Globe className="w-3.5 h-3.5" /> Browser Title
            {form.browserTitle ? <Badge variant="outline" className="text-[10px] h-4 px-1.5">Custom</Badge> : <Badge variant="secondary" className="text-[10px] h-4 px-1.5">Inherited</Badge>}
          </Label>
          <Input
            value={form.browserTitle}
            onChange={(e) => setForm((p) => ({ ...p, browserTitle: e.target.value }))}
            placeholder="Platform default"
            className="max-w-md"
          />
        </div>

        {/* Tagline */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Tag className="w-3.5 h-3.5" /> Tagline
            {form.tagline ? <Badge variant="outline" className="text-[10px] h-4 px-1.5">Custom</Badge> : <Badge variant="secondary" className="text-[10px] h-4 px-1.5">Inherited</Badge>}
          </Label>
          <Input
            value={form.tagline}
            onChange={(e) => setForm((p) => ({ ...p, tagline: e.target.value }))}
            placeholder="Platform default"
            className="max-w-md"
          />
        </div>

        {/* Primary Color */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Palette className="w-3.5 h-3.5" /> Primary Color
            {form.primaryColor ? <Badge variant="outline" className="text-[10px] h-4 px-1.5">Custom</Badge> : <Badge variant="secondary" className="text-[10px] h-4 px-1.5">Inherited</Badge>}
          </Label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={form.primaryColor || '#059669'}
              onChange={(e) => setForm((p) => ({ ...p, primaryColor: e.target.value }))}
              className="h-10 w-10 rounded border border-border cursor-pointer"
            />
            <Input
              value={form.primaryColor}
              onChange={(e) => setForm((p) => ({ ...p, primaryColor: e.target.value }))}
              placeholder="Platform default"
              className="max-w-[140px]"
            />
            {form.primaryColor && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setForm((p) => ({ ...p, primaryColor: '' }))}
                className="gap-1 text-xs"
              >
                <RotateCcw className="w-3 h-3" /> Reset
              </Button>
            )}
          </div>
        </div>

        {/* Save */}
        <div className="flex items-center gap-2 pt-2">
          <Button onClick={handleSave} disabled={saving} className="gap-2">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save Organization Branding
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Live Preview ───────────────────────────────────────────────────────────

function BrandingPreview() {
  const branding = useEffectiveBranding();
  const displayWidth = branding.logoWidth && branding.logoWidth > 0 ? branding.logoWidth : 48;
  const displayHeight = branding.logoHeight && branding.logoHeight > 0 ? branding.logoHeight : displayWidth;

  return (
    <Card className="falcon-card falcon-card-hover">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="w-1 h-8 rounded-full bg-blue-500" />
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-blue-50 dark:bg-blue-900/40 flex items-center justify-center">
              <Eye className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold">Live Preview</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                How the current effective branding appears
              </p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-border bg-muted/30 p-6 space-y-4">
          {/* Mock sidebar */}
          <div className="flex items-center gap-3">
            <div
              className="rounded-lg bg-white dark:bg-background border border-border flex items-center justify-center overflow-hidden"
              style={{ width: Math.max(displayWidth + 16, 48), height: Math.max(displayHeight + 16, 48) }}
            >
              {branding.logoType === 'svg' && branding.logoSvg ? (
                <div
                  style={{ width: displayWidth, height: displayHeight }}
                  dangerouslySetInnerHTML={{ __html: branding.logoSvg }}
                  className="flex items-center justify-center"
                />
              ) : (
                <Image
                  src={branding.logoUrl}
                  alt="Logo preview"
                  width={displayWidth}
                  height={displayHeight}
                  className="object-contain"
                  unoptimized
                />
              )}
            </div>
            <div>
              <p className="font-semibold text-sm" style={{ color: branding.primaryColor }}>
                {branding.brandName}
              </p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                {branding.tagline}
              </p>
            </div>
          </div>

          {/* Color swatch */}
          <div className="flex items-center gap-3">
            <div
              className="h-8 w-8 rounded-full border border-border"
              style={{ backgroundColor: branding.primaryColor }}
            />
            <div>
              <p className="text-xs font-medium">Primary Color</p>
              <p className="text-[11px] text-muted-foreground font-mono">{branding.primaryColor}</p>
            </div>
          </div>

          {/* Browser title */}
          <div>
            <p className="text-xs font-medium">Browser Title</p>
            <p className="text-[11px] text-muted-foreground">{branding.browserTitle}</p>
          </div>

          {/* Override indicator */}
          {branding.isOrganizationOverride && (
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-600">
              <Check className="w-3 h-3" /> Organization overrides active
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Export ────────────────────────────────────────────────────────────

export function BrandingPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';

  return (
    <div className="space-y-6" role="region" aria-label="Branding Settings">
      <div>
        <h2 className="text-lg font-semibold">Branding</h2>
        <p className="text-sm text-muted-foreground">
          Customize the platform and organization branding. Platform changes apply to all organizations unless overridden.
        </p>
      </div>

      {/* Live Preview */}
      <BrandingPreview />

      {/* Platform Branding (Super Admin only) */}
      {isSuperAdmin && <PlatformBrandingSection />}

      {/* Organization Branding (Admin+) */}
      <OrgBrandingSection />
    </div>
  );
}
