'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { AiProviderUsageTab, type AiUsage } from '@/components/ai-provider/ai-provider-usage-tab';
import {
  Bot, Eye, EyeOff, Check, X, Loader2, Settings2, Brain,
  Sparkles, BarChart3, SlidersHorizontal, ChevronDown, ChevronUp,
  Zap, Shield, Activity, RefreshCw, Key, Globe, Thermometer,
  Save, AlertCircle, CheckCircle2, Info, Cpu
} from 'lucide-react';

// ── Types ───────────────────────────────────────────────────────────────

type TabId = 'provider' | 'models' | 'parameters' | 'usage' | 'advanced';

interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  letter: string;
  color: string;
  colorBg: string;
  colorBorder: string;
  models: ModelConfig[];
}

interface ModelConfig {
  id: string;
  name: string;
  contextWindow: string;
  pricingTier: string;
  tierColor: string;
}

// ── Static Data ─────────────────────────────────────────────────────────

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: 'provider', label: 'Provider', icon: Bot },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'parameters', label: 'Parameters', icon: SlidersHorizontal },
  { id: 'usage', label: 'Usage', icon: BarChart3 },
  { id: 'advanced', label: 'Advanced', icon: Settings2 },
];

const PROVIDERS: ProviderConfig[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT-4o, GPT-4 Turbo, and other OpenAI models for powerful text generation and analysis.',
    letter: 'O',
    color: 'text-green-500',
    colorBg: 'bg-green-500/10 dark:bg-green-500/15',
    colorBorder: 'border-green-500/30',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: '128K', pricingTier: 'Premium', tierColor: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: '128K', pricingTier: 'Budget', tierColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', contextWindow: '128K', pricingTier: 'Premium', tierColor: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', contextWindow: '16K', pricingTier: 'Standard', tierColor: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude 3.5 Sonnet, Claude 3 Opus — thoughtful, nuanced AI with strong safety alignment.',
    letter: 'A',
    color: 'text-orange-500',
    colorBg: 'bg-orange-500/10 dark:bg-orange-500/15',
    colorBorder: 'border-orange-500/30',
    models: [
      { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: '200K', pricingTier: 'Premium', tierColor: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
      { id: 'claude-3-opus', name: 'Claude 3 Opus', contextWindow: '200K', pricingTier: 'Premium', tierColor: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
      { id: 'claude-3-haiku', name: 'Claude 3 Haiku', contextWindow: '200K', pricingTier: 'Budget', tierColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
      { id: 'claude-3-sonnet', name: 'Claude 3 Sonnet', contextWindow: '200K', pricingTier: 'Standard', tierColor: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Gemini Pro and Ultra models from Google DeepMind with multimodal capabilities.',
    letter: 'G',
    color: 'text-blue-500',
    colorBg: 'bg-blue-500/10 dark:bg-blue-500/15',
    colorBorder: 'border-blue-500/30',
    models: [
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: '1M', pricingTier: 'Standard', tierColor: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextWindow: '1M', pricingTier: 'Budget', tierColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
      { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', contextWindow: '1M', pricingTier: 'Budget', tierColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: '1M', pricingTier: 'Premium', tierColor: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'Mistral Large, Medium, and Small — efficient European open-weight models.',
    letter: 'M',
    color: 'text-purple-500',
    colorBg: 'bg-purple-500/10 dark:bg-purple-500/15',
    colorBorder: 'border-purple-500/30',
    models: [
      { id: 'mistral-large', name: 'Mistral Large', contextWindow: '32K', pricingTier: 'Premium', tierColor: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
      { id: 'mistral-medium', name: 'Mistral Medium', contextWindow: '32K', pricingTier: 'Standard', tierColor: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
      { id: 'mistral-small', name: 'Mistral Small', contextWindow: '32K', pricingTier: 'Budget', tierColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
      { id: 'codestral', name: 'Codestral', contextWindow: '32K', pricingTier: 'Standard', tierColor: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama / Local',
    description: 'Run models locally on your own hardware. Full privacy, no API costs, full control.',
    letter: 'O',
    color: 'text-slate-500',
    colorBg: 'bg-slate-500/10 dark:bg-slate-500/15',
    colorBorder: 'border-slate-500/30',
    models: [
      { id: 'llama3', name: 'Llama 3 (70B)', contextWindow: '8K', pricingTier: 'Free', tierColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
      { id: 'mistral-7b', name: 'Mistral 7B', contextWindow: '8K', pricingTier: 'Free', tierColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
      { id: 'codellama', name: 'CodeLlama', contextWindow: '16K', pricingTier: 'Free', tierColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
      { id: 'phi3', name: 'Phi-3', contextWindow: '8K', pricingTier: 'Free', tierColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
    ],
  },
  {
    id: 'custom',
    name: 'Custom / Other',
    description: 'Use any OpenAI-compatible API endpoint — Groq, DeepSeek, Together AI, Fireworks, or your own self-hosted LLM server.',
    letter: 'C',
    color: 'text-amber-500',
    colorBg: 'bg-amber-500/10 dark:bg-amber-500/15',
    colorBorder: 'border-amber-500/30',
    models: [
      { id: 'custom-model', name: 'Your Custom Model', contextWindow: 'Varies', pricingTier: 'Custom', tierColor: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
    ],
  },
];

// ── Helper ──────────────────────────────────────────────────────────────

function getProviderStatus(
  providerId: string,
  activeProvider: string,
  apiKey: string,
  liveTested: boolean,
): 'connected' | 'configured' | 'not_configured' | 'error' {
  // DS-P3-1: "Connected" is only truthful after a live test succeeded in this
  // session. A stored key alone means "Configured" — the audit proved a
  // key-presence badge can claim connectivity for a config that 404s.
  if (providerId === activeProvider && liveTested) return 'connected';
  if (providerId === activeProvider && apiKey) return 'configured';
  return 'not_configured';
}

// ── Component ───────────────────────────────────────────────────────────

export function AiProviderPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabId>('provider');
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testLoading, setTestLoading] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, 'success' | 'error' | null>>({});

  // Local form state
  const [localApiKey, setLocalApiKey] = useState('');
  const [localBaseUrl, setLocalBaseUrl] = useState('');

  // Fetch settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings');
      const json = await res.json();
      const map: Record<string, string> = {};
      (json.data || []).forEach((s: { key: string; value: string }) => {
        map[s.key] = s.value;
      });
      return map;
    },
  });

  // Fetch real usage statistics from the database
  const { data: usage, refetch: refetchUsage } = useQuery<AiUsage>({
    queryKey: ['ai-usage'],
    queryFn: async () => {
      const res = await fetch('/api/ai-provider/usage');
      const json = (await res.json()) as AiUsage;
      return json;
    },
  });

  // Derived settings
  const activeProvider = settings?.ai_provider || 'openai';
  const apiKey = settings?.ai_api_key || '';
  const baseUrl = settings?.ai_base_url || '';
  const activeModel = settings?.ai_model || '';
  const temperature = parseFloat(settings?.ai_temperature || '0.7');
  const maxTokens = parseInt(settings?.ai_max_tokens || '4096', 10);
  const topP = parseFloat(settings?.ai_top_p || '1');
  const freqPenalty = parseFloat(settings?.ai_frequency_penalty || '0');
  const presPenalty = parseFloat(settings?.ai_presence_penalty || '0');
  const insightsEnabled = settings?.ai_insights_enabled === 'true';
  const autoReports = settings?.ai_auto_reports === 'true';
  const anomalyDetection = settings?.ai_anomaly_detection === 'true';
  const realtimeAnalysis = settings?.ai_realtime_analysis === 'true';
  const responseCaching = settings?.ai_response_caching === 'true';
  const systemPrompt = settings?.ai_system_prompt || '';

  // Save handler — global AI configuration is super_admin-only (P1-7); org
  // admins can view it but receive a clear 403 on write, never a silent fail.
  const handleSave = async (key: string, value: string) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(json.error || 'Failed to update setting');
        return;
      }
      toast.success('Setting updated');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    } catch {
      toast.error('Failed to update setting');
    }
  };

  const handleTestConnection = async (providerId: string) => {
    setTestLoading(providerId);
    setTestResult((prev) => ({ ...prev, [providerId]: null }));
    try {
      const res = await fetch('/api/ai-provider/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: providerId,
          apiKey: localApiKey || undefined,
          baseUrl: localBaseUrl || undefined,
        }),
      });
      const json = (await res.json()) as { status?: string; message?: string };
      const ok = res.ok && json.status === 'connected';
      setTestResult((prev) => ({ ...prev, [providerId]: ok ? 'success' : 'error' }));
      if (ok) toast.success(json.message || 'Connection successful');
      else toast.error(json.message || 'Connection failed');
    } catch {
      setTestResult((prev) => ({ ...prev, [providerId]: 'error' }));
      toast.error('Connection failed');
    } finally {
      setTestLoading(null);
    }
  };

  const handleSetProvider = async (providerId: string) => {
    const cfg = PROVIDERS.find((p) => p.id === providerId);
    // Order matters: the server now validates provider/model/baseUrl
    // compatibility. Save a compatible default model first so switching never
    // leaves an invalid combination (e.g. google + stale gpt-4o).
    if (cfg && cfg.models.length > 0) {
      await handleSave('ai_model', cfg.models[0].id);
    }
    // Provider-native providers (google/anthropic/ollama) have a fixed API
    // path; a leftover OpenAI-compatible gateway base URL would 404. Reset it
    // so the provider default endpoint is used. OpenAI-style providers
    // (openai/mistral/custom) keep their custom base URL — gateways are valid
    // there.
    if (providerId === 'google' || providerId === 'anthropic' || providerId === 'ollama') {
      await handleSave('ai_base_url', '');
    }
    await handleSave('ai_provider', providerId);
  };

  const handleSelectModel = async (modelId: string) => {
    await handleSave('ai_model', modelId);
  };

  const handleSaveApiKey = async () => {
    if (!localApiKey && expandedProvider !== 'ollama') {
      toast.error('API key is required');
      return;
    }
    await handleSave('ai_api_key', localApiKey);
    await handleSave('ai_base_url', localBaseUrl);
    toast.success('Configuration saved');
  };

  const currentProviderConfig = PROVIDERS.find((p) => p.id === activeProvider);

  // ── Provider Tab ─────────────────────────────────────────────────────

  const renderProviderTab = () => (
    <div className="space-y-4">
      <div className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight">AI Providers</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Select and configure the AI provider for OmniSight features.
        </p>
      </div>

      <div className="grid gap-4">
        {PROVIDERS.map((provider, i) => {
          const isActive = activeProvider === provider.id;
          const isExpanded = expandedProvider === provider.id;
          const status = getProviderStatus(provider.id, activeProvider, apiKey, testResult[provider.id] === 'success');

          return (
            <motion.div
              key={provider.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
            >
              <Card
                className={cn(
                  'group relative overflow-hidden transition-all duration-200 hover:shadow-md',
                  isActive && `ring-2 ring-[oklch(0.555_0.163_163.5)]/40 ${provider.colorBorder}`,
                  isExpanded && 'shadow-md',
                )}
              >
                {/* Active indicator bar */}
                {isActive && (
                  <motion.div
                    layoutId="active-provider-bar"
                    className="absolute left-0 top-0 bottom-0 w-1 rounded-r-full"
                    style={{ backgroundColor: provider.id === 'openai' ? '#22c55e' : provider.id === 'anthropic' ? '#f97316' : provider.id === 'google' ? '#3b82f6' : provider.id === 'mistral' ? '#a855f7' : '#64748b' }}
                    transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  />
                )}

                <CardContent className="py-5 px-6">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4 min-w-0">
                      <div
                        className={cn(
                          'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-lg font-bold transition-transform group-hover:scale-105',
                          provider.colorBg,
                          provider.color,
                        )}
                      >
                        {provider.letter}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5">
                          <h3 className="font-semibold text-base truncate">{provider.name}</h3>
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px] px-1.5 py-0 h-5 font-medium shrink-0',
                              status === 'connected' && 'border-emerald-500/40 text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 dark:text-emerald-400',
                              status === 'configured' && 'border-blue-500/40 text-blue-600 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-400',
                              status === 'error' && 'border-rose-500/40 text-rose-600 bg-rose-50 dark:bg-rose-900/20 dark:text-rose-400',
                              status === 'not_configured' && 'border-slate-300 text-slate-500 bg-slate-50 dark:bg-slate-800/50 dark:text-slate-400',
                            )}
                          >
                            {status === 'connected' ? (
                              <><CheckCircle2 className="size-3 mr-0.5" /> Connected</>
                            ) : status === 'configured' ? (
                              <><Settings2 className="size-3 mr-0.5" /> Configured</>
                            ) : status === 'error' ? (
                              <><AlertCircle className="size-3 mr-0.5" /> Error</>
                            ) : (
                              'Not Configured'
                            )}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5 line-clamp-1">
                          {provider.description}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {!isActive && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleSetProvider(provider.id)}
                          className="text-xs h-8"
                        >
                          Set Active
                        </Button>
                      )}
                      <Button
                        variant={isActive ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => {
                          setExpandedProvider(isExpanded ? null : provider.id);
                          setTestResult((prev) => ({ ...prev, [provider.id]: null }));
                          if (!isExpanded) {
                            setLocalApiKey(provider.id === activeProvider ? apiKey : '');
                            setLocalBaseUrl(provider.id === activeProvider ? baseUrl : '');
                          }
                        }}
                        className={cn(
                          'text-xs h-8 gap-1.5',
                          isActive && 'bg-[oklch(0.555_0.163_163.5)] hover:bg-[oklch(0.485_0.163_163.5)] text-white',
                        )}
                      >
                        {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                        Configure
                      </Button>
                    </div>
                  </div>

                  {/* Inline expansion */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25, ease: 'easeInOut' }}
                        className="overflow-hidden"
                      >
                        <div className="pt-5 mt-5 border-t border-border/60">
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label htmlFor={`api-key-${provider.id}`} className="text-sm font-medium">
                                <Key className="size-3.5 inline mr-1.5 -mt-0.5" />
                                API Key
                                {provider.id === 'ollama' && (
                                  <span className="text-muted-foreground font-normal"> (optional)</span>
                                )}
                              </Label>
                              <div className="relative">
                                <Input
                                  id={`api-key-${provider.id}`}
                                  type={showApiKey ? 'text' : 'password'}
                                  placeholder={provider.id === 'ollama' ? 'Enter API key (if required)' : 'sk-...'}
                                  value={localApiKey}
                                  onChange={(e) => setLocalApiKey(e.target.value)}
                                  className="pr-10 font-mono text-sm"
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="absolute right-0.5 top-0.5 h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                  onClick={() => setShowApiKey(!showApiKey)}
                                >
                                  {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                </Button>
                              </div>
                            </div>

                            <div className="space-y-2">
                              <Label htmlFor={`base-url-${provider.id}`} className="text-sm font-medium">
                                <Globe className="size-3.5 inline mr-1.5 -mt-0.5" />
                                Base URL
                                <span className="text-muted-foreground font-normal"> (optional)</span>
                              </Label>
                              <Input
                                id={`base-url-${provider.id}`}
                                type="text"
                                placeholder={
                                  provider.id === 'ollama'
                                    ? 'http://localhost:11434'
                                    : provider.id === 'openai'
                                      ? 'https://api.openai.com/v1'
                                      : 'https://api.example.com/v1'
                                }
                                value={localBaseUrl}
                                onChange={(e) => setLocalBaseUrl(e.target.value)}
                                className="text-sm"
                              />
                            </div>
                          </div>

                          <div className="flex items-center gap-3 mt-5">
                            <Button
                              size="sm"
                              onClick={handleSaveApiKey}
                              className="bg-[oklch(0.555_0.163_163.5)] hover:bg-[oklch(0.485_0.163_163.5)] text-white gap-1.5"
                            >
                              <Save className="size-3.5" />
                              Save Configuration
                            </Button>

                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleTestConnection(provider.id)}
                              disabled={testLoading === provider.id}
                              className="gap-1.5"
                            >
                              {testLoading === provider.id ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : testResult[provider.id] === 'success' ? (
                                <CheckCircle2 className="size-3.5 text-emerald-500" />
                              ) : testResult[provider.id] === 'error' ? (
                                <X className="size-3.5 text-rose-500" />
                              ) : (
                                <Zap className="size-3.5" />
                              )}
                              {testLoading === provider.id ? 'Testing…' : 'Test Connection'}
                            </Button>

                            {testResult[provider.id] === 'success' && (
                              <motion.span
                                initial={{ opacity: 0, x: -8 }}
                                animate={{ opacity: 1, x: 0 }}
                                className="text-xs text-emerald-600 dark:text-emerald-400 font-medium"
                              >
                                Connection successful!
                              </motion.span>
                            )}
                            {testResult[provider.id] === 'error' && (
                              <motion.span
                                initial={{ opacity: 0, x: -8 }}
                                animate={{ opacity: 1, x: 0 }}
                                className="text-xs text-rose-600 dark:text-rose-400 font-medium"
                              >
                                Connection failed. Check your credentials.
                              </motion.span>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>
    </div>
  );

  // ── Models Tab ───────────────────────────────────────────────────────

  const renderModelsTab = () => {
    const provider = PROVIDERS.find((p) => p.id === activeProvider);
    if (!provider) return null;

    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Available Models</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Select a model from <span className={cn('font-medium', provider.color)}>{provider.name}</span> to use for AI features.
          </p>
        </div>

        <div className="grid gap-3">
          {provider.models.map((model, i) => {
            const isSelected = activeModel === model.id;
            return (
              <motion.div
                key={model.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06, duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
              >
                <Card
                  className={cn(
                    'cursor-pointer transition-all duration-200 hover:shadow-md hover:border-[oklch(0.555_0.163_163.5)]/30',
                    isSelected && 'ring-2 ring-[oklch(0.555_0.163_163.5)]/40 border-[oklch(0.555_0.163_163.5)]/30 bg-[oklch(0.555_0.163_163.5)]/5',
                  )}
                  onClick={() => handleSelectModel(model.id)}
                >
                  <CardContent className="py-4 px-5 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div
                        className={cn(
                          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors',
                          isSelected
                            ? 'bg-[oklch(0.555_0.163_163.5)] text-white'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        <Cpu className="size-4.5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2.5">
                          <span className="font-medium text-sm">{model.name}</span>
                          <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 h-5 font-medium', model.tierColor)}>
                            {model.pricingTier}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Context window: {model.contextWindow} tokens
                        </p>
                      </div>
                    </div>

                    {isSelected && (
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                      >
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[oklch(0.555_0.163_163.5)] text-white">
                          <Check className="size-3.5" strokeWidth={3} />
                        </div>
                      </motion.div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>

        {!activeModel && (
          <div className="text-center py-8 text-muted-foreground">
            <Cpu className="size-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No model selected. Click a model above to set it as active.</p>
          </div>
        )}
      </div>
    );
  };

  // ── Parameters Tab ───────────────────────────────────────────────────

  const renderParameterSlider = (
    label: string,
    icon: React.ElementType,
    value: number,
    min: number,
    max: number,
    step: number,
    settingKey: string,
    description: string,
    unit = '',
  ) => {
    const Icon = icon;
    return (
      <div className="space-y-3 p-5 rounded-xl border bg-card/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="size-4 text-[oklch(0.555_0.163_163.5)]" />
            <Label className="text-sm font-medium">{label}</Label>
          </div>
          <div className="flex items-center gap-1.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="size-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-[220px]">
                  <p className="text-xs">{description}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                value={value}
                min={min}
                max={max}
                step={step}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!isNaN(v) && v >= min && v <= max) {
                    handleSave(settingKey, String(v));
                  }
                }}
                className="w-24 h-8 text-xs text-right font-mono"
              />
              {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
            </div>
          </div>
        </div>
        <div className="relative">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => handleSave(settingKey, e.target.value)}
            className="w-full h-2 rounded-full appearance-none cursor-pointer bg-muted accent-[oklch(0.555_0.163_163.5)] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[oklch(0.555_0.163_163.5)] [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[oklch(0.555_0.163_163.5)] [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer"
          />
          <div className="flex justify-between mt-1">
            <span className="text-[10px] text-muted-foreground">{min}</span>
            <span className="text-[10px] text-muted-foreground">{max}</span>
          </div>
        </div>
      </div>
    );
  };

  const renderParametersTab = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Generation Parameters</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Fine-tune AI behavior for your {currentProviderConfig?.name || 'provider'} model.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-28 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4">
          {renderParameterSlider(
            'Temperature', Thermometer, temperature, 0, 2, 0.1, 'ai_temperature',
            'Controls randomness. Lower = more focused, higher = more creative.',
          )}
          {renderParameterSlider(
            'Max Tokens', Sparkles, maxTokens, 256, 128000, 256, 'ai_max_tokens',
            'Maximum number of tokens to generate in a single response.', 'tokens',
          )}
          {renderParameterSlider(
            'Top P', Brain, topP, 0, 1, 0.05, 'ai_top_p',
            'Nucleus sampling. Limits tokens to the top P probability mass.',
          )}
          {renderParameterSlider(
            'Frequency Penalty', RefreshCw, freqPenalty, -2, 2, 0.1, 'ai_frequency_penalty',
            'Reduces model tendency to repeat the same words frequently.',
          )}
          {renderParameterSlider(
            'Presence Penalty', Zap, presPenalty, -2, 2, 0.1, 'ai_presence_penalty',
            'Increases model tendency to talk about new topics.',
          )}
        </div>
      )}

      <div className="rounded-xl border bg-amber-50 dark:bg-amber-900/10 p-4 flex gap-3">
        <AlertCircle className="size-4 text-amber-500 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Changes apply immediately</p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
            Parameter changes take effect on the next AI request. Extreme values may produce unexpected results.
          </p>
        </div>
      </div>
    </div>
  );

  // ── Usage Tab ─────────────────────────────────────────────────────────
  // Rendered by AiProviderUsageTab (extracted module) — see
  // ai-provider-usage-tab.tsx.

  const renderUsageTab = () => (
    <AiProviderUsageTab usage={usage} onRefresh={() => refetchUsage()} />
  );

  // ── Advanced Tab ─────────────────────────────────────────────────────

  const renderAdvancedTab = () => {
    const toggleItems = [
      { key: 'ai_insights_enabled', label: 'Enable AI Insights', description: 'Automatically generate insights from your workforce data using AI analysis.', icon: Brain, value: insightsEnabled },
      { key: 'ai_auto_reports', label: 'Auto-generate reports', description: 'Create and distribute AI-powered reports on a scheduled basis.', icon: Sparkles, value: autoReports },
      { key: 'ai_anomaly_detection', label: 'Smart anomaly detection', description: 'Detect unusual patterns in employee activity and flag them proactively.', icon: Shield, value: anomalyDetection },
      { key: 'ai_realtime_analysis', label: 'Real-time analysis', description: 'Process and analyze data streams in real-time for instant AI feedback.', icon: Activity, value: realtimeAnalysis },
      { key: 'ai_response_caching', label: 'Response caching', description: 'Cache AI responses to reduce API calls and improve response times.', icon: Zap, value: responseCaching },
    ];

    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Advanced Settings</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure AI behavior, feature toggles, and custom system prompts.
          </p>
        </div>

        {/* Feature Toggles */}
        <div className="grid gap-3">
          {toggleItems.map((item, i) => (
            <motion.div
              key={item.key}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
            >
              <Card className="transition-all duration-200 hover:shadow-md">
                <CardContent className="py-4 px-5">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div
                        className={cn(
                          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                          item.value
                            ? 'bg-[oklch(0.555_0.163_163.5)]/15 text-[oklch(0.555_0.163_163.5)]'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        <item.icon className="size-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{item.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{item.description}</p>
                      </div>
                    </div>
                    <Switch
                      checked={item.value}
                      onCheckedChange={(checked) => handleSave(item.key, String(checked))}
                    />
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        <Separator />

        {/* System Prompt */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Settings2 className="size-4 text-[oklch(0.555_0.163_163.5)]" />
                System Prompt
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                Define a custom system prompt that shapes how the AI responds. This is prepended to all AI requests.
              </p>
              <textarea
                value={systemPrompt}
                onChange={(e) => handleSave('ai_system_prompt', e.target.value)}
                placeholder="You are a helpful AI assistant for OmniSight, a workforce analytics platform. Your role is to..."
                rows={6}
                className={cn(
                  'w-full rounded-lg border border-input bg-transparent px-3 py-2.5 text-sm',
                  'shadow-xs placeholder:text-muted-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[oklch(0.555_0.163_163.5)]/40 focus-visible:ring-offset-1',
                  'resize-y font-mono leading-relaxed',
                )}
              />
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-muted-foreground">
                  {systemPrompt.length} characters
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSave('ai_system_prompt', systemPrompt)}
                  className="text-xs h-7 gap-1.5"
                >
                  <Save className="size-3" />
                  Save Prompt
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  };

  // ── Main Render ──────────────────────────────────────────────────────

  const tabContentMap: Record<TabId, () => React.ReactNode> = {
    provider: renderProviderTab,
    models: renderModelsTab,
    parameters: renderParametersTab,
    usage: renderUsageTab,
    advanced: renderAdvancedTab,
  };

  return (
    <TooltipProvider>
      <div className="flex min-h-[calc(100vh-4rem)] gap-0">
        {/* ── Left Sidebar ── */}
        <aside className="w-56 shrink-0 sticky top-0 h-[calc(100vh-4rem)] overflow-y-auto border-r bg-muted/30">
          <div className="p-4">
            <div className="flex items-center gap-2.5 mb-6 px-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[oklch(0.555_0.163_163.5)] text-white">
                <Bot className="size-4.5" />
              </div>
              <div>
                <h1 className="font-semibold text-sm tracking-tight">AI Configuration</h1>
                <p className="text-[10px] text-muted-foreground">Manage providers & models</p>
              </div>
            </div>

            <nav className="space-y-1">
              {TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      'relative w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150',
                      isActive
                        ? 'text-white'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                    )}
                  >
                    {isActive && (
                      <motion.div
                        layoutId="sidebar-active"
                        className="absolute inset-0 rounded-lg bg-primary shadow-sm"
                        transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                      />
                    )}
                    <Icon className="size-4 relative z-10" />
                    <span className="relative z-10">{tab.label}</span>
                  </button>
                );
              })}
            </nav>

            <Separator className="my-5" />

            {/* Active provider summary */}
            <div className="px-2 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Active Provider</p>
              <div className="flex items-center gap-2.5">
                <div
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold',
                    currentProviderConfig?.colorBg,
                    currentProviderConfig?.color,
                  )}
                >
                  {currentProviderConfig?.letter}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{currentProviderConfig?.name}</p>
                  {activeModel && (
                    <p className="text-[10px] text-muted-foreground truncate">{activeModel}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* ── Main Content ── */}
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          {isLoading && !settings ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="size-6 animate-spin text-[oklch(0.555_0.163_163.5)]" />
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0, transition: { duration: 0.3, ease: 'easeOut' } }}
                exit={{ opacity: 0, x: -12, transition: { duration: 0.15, ease: 'easeIn' } }}
              >
                {tabContentMap[activeTab]()}
              </motion.div>
            </AnimatePresence>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}
