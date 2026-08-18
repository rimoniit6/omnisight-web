'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle2, XCircle, Lightbulb, TrendingUp, AlertTriangle, BarChart3, ChevronDown, ChevronUp, Bell, Eye, Sparkles, Database } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

const typeConfig: Record<string, { icon: React.ElementType; color: string; bg: string; badgeClass: string }> = {
  productivity: { icon: TrendingUp, color: 'text-emerald-600', bg: 'bg-emerald-50', badgeClass: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' },
  anomaly: { icon: AlertTriangle, color: 'text-rose-600', bg: 'bg-rose-50', badgeClass: 'bg-rose-100 text-rose-700 hover:bg-rose-100' },
  recommendation: { icon: Lightbulb, color: 'text-amber-600', bg: 'bg-amber-50', badgeClass: 'bg-amber-100 text-amber-700 hover:bg-amber-100' },
  trend: { icon: BarChart3, color: 'text-teal-600', bg: 'bg-teal-50', badgeClass: 'bg-teal-100 text-teal-700 hover:bg-teal-100' },
  risk: { icon: AlertTriangle, color: 'text-orange-600', bg: 'bg-orange-50', badgeClass: 'bg-orange-100 text-orange-700 hover:bg-orange-100' },
};

function getPriority(type: string, confidence: number | null): { level: 'high' | 'medium' | 'low'; color: string; bgColor: string; label: string } {
  if (type === 'risk' || type === 'anomaly') return { level: 'high', color: 'text-rose-700 dark:text-rose-300', bgColor: 'bg-rose-100 dark:bg-rose-900/30', label: 'High' };
  if (type === 'productivity' && confidence !== null && confidence >= 0.8) return { level: 'high', color: 'text-rose-700 dark:text-rose-300', bgColor: 'bg-rose-100 dark:bg-rose-900/30', label: 'High' };
  if (type === 'recommendation' || (confidence !== null && confidence >= 0.6)) return { level: 'medium', color: 'text-amber-700 dark:text-amber-300', bgColor: 'bg-amber-100 dark:bg-amber-900/30', label: 'Medium' };
  return { level: 'low', color: 'text-emerald-700 dark:text-emerald-300', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30', label: 'Low' };
}

function getTrend(type: string): { icon: () => React.ReactNode; label: string; color: string } {
  switch (type) {
    case 'productivity': return { icon: () => <span className="text-emerald-500 text-xs font-bold">↑</span>, label: 'Improving', color: 'text-emerald-600' };
    case 'risk': return { icon: () => <span className="text-rose-500 text-xs font-bold">↓</span>, label: 'Declining', color: 'text-rose-600' };
    case 'anomaly': return { icon: () => <span className="text-rose-500 text-xs font-bold">↓</span>, label: 'Declining', color: 'text-rose-600' };
    case 'trend': return { icon: () => <span className="text-teal-500 text-xs font-bold">→</span>, label: 'Stable', color: 'text-teal-600' };
    default: return { icon: () => <span className="text-amber-500 text-xs font-bold">→</span>, label: 'Stable', color: 'text-amber-600' };
  }
}

const priorityBorderGradients: Record<string, string> = {
  high: 'border-l-rose-500',
  medium: 'border-l-amber-500',
  low: 'border-l-emerald-500',
};

interface InsightCardProps {
  insight: {
    id: string;
    title: string;
    content: string;
    type: string;
    category: string | null;
    confidence: number | null;
    status: string;
    createdAt: string;
    metadata?: string | null;
  };
  onUpdate: (id: string, status: string) => void;
  index: number;
}

// Parse the persisted provenance metadata (mode/source/provider/model/period/
// evidence) stored on generated insights. Never crashes on malformed metadata.
function parseMetadata(raw: string | null | undefined): {
  mode?: string;
  source?: string;
  provider?: string | null;
  model?: string | null;
  fallbackReason?: string | null;
  periodStart?: string;
  periodEnd?: string;
  keyFindings?: { type: string; severity: string; title: string }[];
  findings?: { type: string; severity: string | null; title: string; statement?: string | null }[];
  evidence?: { label: string; value: string }[];
} | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j;
    return null;
  } catch {
    return null;
  }
}

export function InsightCard({ insight, onUpdate, index }: InsightCardProps) {
  const [expanded, setExpanded] = useState(false);
  const config = typeConfig[insight.type] || typeConfig.recommendation;
  const Icon = config.icon;
  const priority = getPriority(insight.type, insight.confidence);
  const trend = getTrend(insight.type);
  const TrendIcon = trend.icon;
  const borderClass = priorityBorderGradients[priority.level];
  const meta = parseMetadata(insight.metadata);
  // Keyed on mode ONLY: a persisted DATA_SUMMARY may carry the *attempted*
  // provider/model in its metadata, but it was NOT produced by the AI — it
  // must never render the AI badge.
  const isAiGenerated = meta?.mode === 'AI_ANALYSIS';
  const isDataSummary = meta?.mode === 'DATA_SUMMARY';

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.08, duration: 0.3 }}
    >
      <Card className={`border shadow-sm hover:shadow-md transition-all border-l-4 ${borderClass}`}>
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className={`h-10 w-10 rounded-lg ${config.bg} flex items-center justify-center shrink-0`}>
              <Icon className={`w-5 h-5 ${config.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              {/* Title row with badges */}
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold">{insight.title}</h3>
                <Badge className={`${config.badgeClass} badge-glow`} variant="secondary">{insight.type}</Badge>
                <Badge className={`${priority.bgColor} ${priority.color} border-0 text-[10px] font-semibold badge-glow`} variant="secondary">
                  {priority.label}
                </Badge>
                {insight.category && (
                  <Badge variant="outline" className="text-[10px] capitalize">{insight.category}</Badge>
                )}
                {insight.confidence !== null && (
                  <Badge variant="outline" className="text-[10px]">{Math.round(insight.confidence * 100)}% conf.</Badge>
                )}
                {isAiGenerated && (
                  <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">AI Analysis · {meta.model}</Badge>
                )}
                {isDataSummary && (
                  <Badge variant="outline" className="text-[10px] border-amber-400/50 text-amber-700 dark:text-amber-300">Data Summary</Badge>
                )}
                {/* Trend indicator */}
                <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${trend.color}`}>
                  <TrendIcon />
                  <span>{trend.label}</span>
                </span>
              </div>

              {/* Content */}
              <p className={`text-sm text-muted-foreground mt-1.5 leading-relaxed ${!expanded ? 'text-clamp-3' : ''}`}>
                {insight.content}
              </p>

              {/* Expand/collapse toggle */}
              {insight.content.length > 120 && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-1 mt-1 text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 transition-colors"
                >
                  {expanded ? (
                    <><ChevronUp className="w-3 h-3" /> Show less</>
                  ) : (
                    <><ChevronDown className="w-3 h-3" /> Show more</>
                  )}
                </button>
              )}

              {/* Expanded detail section */}
              <AnimatePresence>
                {expanded && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-3 p-3 rounded-lg bg-muted/50 border border-border/50 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {isAiGenerated ? (
                          <><Sparkles className="w-3 h-3 text-emerald-500" /><span>AI Analysis Details</span></>
                        ) : (
                          <><Database className="w-3 h-3 text-amber-500" /><span>Data Summary Details</span></>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-muted-foreground">Type:</span>{' '}
                          <span className="font-medium capitalize">{insight.type}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Confidence:</span>{' '}
                          <span className="font-medium">{insight.confidence !== null ? `${Math.round(insight.confidence * 100)}%` : 'N/A'}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Category:</span>{' '}
                          <span className="font-medium capitalize">{insight.category || 'General'}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Created:</span>{' '}
                          <span className="font-medium">{formatDistanceToNow(new Date(insight.createdAt), { addSuffix: true })}</span>
                        </div>
                      </div>
                      {meta?.periodStart && meta?.periodEnd && (
                        <div className="text-[10px] text-muted-foreground mt-2">
                          Period: {formatDistanceToNow(new Date(meta.periodStart), { addSuffix: true })} →{' '}
                          {new Date(meta.periodEnd).toLocaleDateString()}
                        </div>
                      )}
                      {meta?.keyFindings && meta.keyFindings.length > 0 && (
                        <div className="text-[10px] text-muted-foreground mt-1 space-y-0.5">
                          {meta.keyFindings.slice(0, 3).map((k, i) => (
                            <div key={i} className="flex items-center gap-1.5">
                              <span className={`h-1.5 w-1.5 rounded-full ${k.severity === 'high' ? 'bg-rose-500' : k.severity === 'medium' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                              <span className="capitalize">{k.type}:</span> {k.title}
                            </div>
                          ))}
                        </div>
                      )}
                      {isDataSummary && meta?.evidence && meta.evidence.length > 0 && (
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-1 text-[10px] text-muted-foreground">
                          {meta.evidence.map((e, i) => (
                            <div key={i} className="flex justify-between gap-2">
                              <span>{e.label}:</span>
                              <span className="font-medium text-foreground/80">{e.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {isDataSummary && meta?.fallbackReason && (
                        <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
                          Provider unavailable ({meta.fallbackReason}) — generated directly from employee database data.
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Action bar */}
              <div className="flex items-center justify-between mt-3 pt-2 border-t border-border/50">
                <span className="text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(insight.createdAt), { addSuffix: true })}
                </span>
                {insight.status === 'active' ? (
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px] text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10 px-2"
                      onClick={() => onUpdate(insight.id, 'acknowledged')}
                    >
                      <Eye className="w-3 h-3 mr-1" /> Acknowledge
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px] text-amber-600 hover:text-amber-700 hover:bg-amber-500/10 px-2"
                      onClick={() => {
                        toast.success('Alert created for this insight');
                        onUpdate(insight.id, 'acknowledged');
                      }}
                    >
                      <Bell className="w-3 h-3 mr-1" /> Create Alert
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px] text-muted-foreground hover:text-rose-600 hover:bg-rose-500/10 px-2"
                      onClick={() => onUpdate(insight.id, 'dismissed')}
                    >
                      <XCircle className="w-3 h-3 mr-1" /> Dismiss
                    </Button>
                  </div>
                ) : (
                  <Badge variant="outline" className="text-[10px] capitalize flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    {insight.status}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
