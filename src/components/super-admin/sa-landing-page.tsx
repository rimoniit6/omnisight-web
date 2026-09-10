'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Loader2, RotateCcw, Save, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, PageTransition, ErrorState } from './ui';
import { sanitizeLandingDoc, LANDING_FIELD_LABELS, type LandingContentDoc } from '@/lib/landing-content';

// ─── Field schema (mirrors the document model in src/lib/landing-content.ts) ─
const SECTIONS: { key: string; label: string; fields: string[]; multiline?: string[] }[] = [
  { key: 'hero', label: 'Hero', fields: ['eyebrow', 'title', 'subtitle', 'primaryCta', 'secondaryCta'], multiline: ['title', 'subtitle'] },
  { key: 'overview', label: 'Product Overview', fields: ['eyebrow', 'title', 'subtitle'], multiline: ['title', 'subtitle'] },
  { key: 'live', label: 'Live Workforce Visibility', fields: ['eyebrow', 'title', 'subtitle'], multiline: ['title', 'subtitle'] },
  { key: 'features', label: 'Monitoring Capabilities', fields: ['eyebrow', 'title', 'subtitle'], multiline: ['title', 'subtitle'] },
  { key: 'screenshot', label: 'Screenshot Monitoring', fields: ['eyebrow', 'title', 'subtitle'], multiline: ['title', 'subtitle'] },
  { key: 'ai', label: 'AI Workforce Intelligence', fields: ['eyebrow', 'title', 'subtitle'], multiline: ['title', 'subtitle'] },
  { key: 'architecture', label: 'How OmniSight Works', fields: ['eyebrow', 'title', 'subtitle'], multiline: ['title', 'subtitle'] },
  { key: 'security', label: 'Security & Privacy', fields: ['eyebrow', 'title', 'subtitle'], multiline: ['title', 'subtitle'] },
  { key: 'deployment', label: 'Deployment Modes', fields: ['eyebrow', 'title', 'subtitle'], multiline: ['title', 'subtitle'] },
  { key: 'pricing', label: 'Pricing', fields: ['eyebrow', 'title', 'subtitle'], multiline: ['title', 'subtitle'] },
  { key: 'final', label: 'Final Call-to-Action', fields: ['eyebrow', 'title', 'subtitle', 'primaryCta', 'secondaryCta'], multiline: ['title', 'subtitle'] },
  { key: 'footer', label: 'Footer', fields: ['tagline', 'copyright'], multiline: [] },
];

type FormValue = Record<string, Record<string, string>>;

function docToForm(doc: LandingContentDoc | undefined): FormValue {
  const form: FormValue = {};
  for (const s of SECTIONS) {
    const section = (doc ?? {})[s.key as keyof LandingContentDoc] as Record<string, string | string[]> | undefined;
    form[s.key] = {};
    for (const f of s.fields) {
      const raw = section?.[f];
      form[s.key][f] = Array.isArray(raw) ? raw.join('\n') : raw ?? '';
    }
  }
  return form;
}

function formToDoc(form: FormValue): LandingContentDoc {
  const doc: Record<string, Record<string, string | string[]>> = {};
  for (const s of SECTIONS) {
    const out: Record<string, string | string[]> = {};
    for (const f of s.fields) {
      const v = form[s.key]?.[f]?.trim();
      if (!v) continue;
      out[f] = f === 'title' && s.key === 'hero' ? v.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6) : v;
    }
    if (Object.keys(out).length > 0) doc[s.key] = out;
  }
  return doc as LandingContentDoc;
}

const inputCls =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30';

export function SuperAdminLandingPage() {
  const queryClient = useQueryClient();
  const { data: content, isLoading, isError, refetch } = useQuery<LandingContentDoc>({
    queryKey: ['sa-landing-content'],
    queryFn: async () => {
      const res = await fetch('/api/landing', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`landing ${res.status}`);
      const json = await res.json();
      return (json?.content ?? {}) as LandingContentDoc;
    },
  });
  const [form, setForm] = useState<FormValue | null>(null);
  const [saving, setSaving] = useState(false);

  const formValue = form ?? docToForm(content);
  const dirty = useMemo(() => form !== null, [form]);
  const customized = useMemo(() => (content ? JSON.stringify(content) !== '{}' : false), [content]);

  const setField = (section: string, field: string, value: string) => {
    setForm((prev) => {
      const base = prev ?? docToForm(content);
      return { ...base, [section]: { ...base[section], [field]: value } };
    });
  };

  const save = async (payload: LandingContentDoc) => {
    setSaving(true);
    try {
      const res = await fetch('/api/landing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content: payload }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Keep the real status/error for debugging; the user sees a clean message.
        console.error('Landing page save failed', { status: res.status, statusText: res.statusText, error: json.error });
        toast.error(json.error ?? 'Unable to save landing page content. Please try again.');
        return;
      }
      toast.success('Landing page saved successfully.');
      setForm(null);
      queryClient.invalidateQueries({ queryKey: ['sa-landing-content'] });
      queryClient.invalidateQueries({ queryKey: ['landing-content'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (!formValue) return;
    const doc = formToDoc(formValue);
    const checked = sanitizeLandingDoc(doc);
    if (!checked.ok) {
      toast.error(checked.error);
      return;
    }
    void save(checked.value);
  };

  const handleReset = () => {
    setForm(null);
    if (!customized) return;
    void save({});
  };

  return (
    <PageTransition>
      <PageHeader
        eyebrow="Content"
        title="Landing Page"
        description="Manage the copy shown on the public OmniSight landing page. Fields left empty use the built-in default copy; saving restores immediately for visitors."
      />

      {isError && !form ? (
        <ErrorState title="Unable to load landing page content" onRetry={() => refetch()} />
      ) : (
        <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {/* View the REAL public landing page — no fake duplicated preview.
            The public route renders the actual output (defaults + saved
            overrides) in a new tab. */}
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          className="tech-font inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-foreground/80 transition-colors hover:bg-muted"
        >
          <ExternalLink size={13} aria-hidden />
          View Landing Page
        </a>
        <button
          onClick={handleSave}
          disabled={saving || !formValue}
          className="tech-font inline-flex items-center gap-2 rounded-full bg-white px-5 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-black transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {saving ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Save size={13} aria-hidden />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          onClick={handleReset}
          disabled={saving || !customized}
          className="tech-font inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-foreground/60 transition-colors hover:bg-muted disabled:opacity-40"
        >
          <RotateCcw size={13} aria-hidden /> Restore defaults
        </button>
        {!dirty && !customized && (
          <span className="text-[12px] text-foreground/45">No customizations yet — the page is showing its built-in copy.</span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-24 text-foreground/50">
          <Loader2 size={20} className="animate-spin" aria-hidden />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {SECTIONS.map((s) => (
            <section
              key={s.key}
              className="rounded-2xl border border-border bg-background/40 p-5 transition-colors hover:border-white/15"
            >
              <h2 className="mb-4 flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.14em] text-foreground/75">
                <Globe size={14} className="text-cyan-400" aria-hidden />
                {s.label}
              </h2>
              <div className="space-y-3.5">
                {s.fields.map((f) => {
                  const label = LANDING_FIELD_LABELS[f] ?? f;
                  const multiline = s.multiline?.includes(f);
                  const value = formValue?.[s.key]?.[f] ?? '';
                  return (
                    <label key={f} className="block">
                      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.1em] text-foreground/45">
                        {label}
                        {s.key === 'hero' && f === 'title' ? ' (one line per row)' : ''}
                      </span>
                      {multiline ? (
                        <textarea
                          rows={f === 'title' && s.key === 'hero' ? 4 : 3}
                          value={value}
                          onChange={(e) => setField(s.key, f, e.target.value)}
                          className={`${inputCls} resize-y`}
                        />
                      ) : (
                        <input value={value} onChange={(e) => setField(s.key, f, e.target.value)} className={inputCls} />
                      )}
                    </label>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
        </>
      )}
    </PageTransition>
  );
}
