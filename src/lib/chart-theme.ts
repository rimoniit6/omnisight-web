// Centralized chart theme for consistent styling across all charts
export const chartTheme = {
  colors: {
    emerald: '#10b981',
    teal: '#14b8a6',
    cyan: '#06b6d4',
    amber: '#f59e0b',
    rose: '#f43f5e',
    purple: '#8b5cf6',
    emeraldLight: 'rgba(16, 185, 129, 0.15)',
    tealLight: 'rgba(20, 184, 166, 0.15)',
    cyanLight: 'rgba(6, 182, 212, 0.15)',
    amberLight: 'rgba(245, 158, 11, 0.15)',
    roseLight: 'rgba(244, 63, 94, 0.15)',
  },
  gradients: {
    emeraldArea: ['#10b981', 'rgba(16, 185, 129, 0.1)'],
    tealArea: ['#14b8a6', 'rgba(20, 184, 166, 0.1)'],
    cyanArea: ['#06b6d4', 'rgba(6, 182, 212, 0.1)'],
  },
  departmentColors: ['#10b981', '#14b8a6', '#06b6d4', '#f59e0b', '#f43f5e', '#8b5cf6', '#ec4899', '#6366f1'],
  categoryColors: {
    productive: '#10b981',
    neutral: '#f59e0b',
    unproductive: '#f43f5e',
  },
  tooltip: {
    backgroundColor: 'hsl(var(--card))',
    border: '1px solid hsl(var(--border))',
    titleColor: 'hsl(var(--foreground))',
    textColor: 'hsl(var(--muted-foreground))',
    padding: '10px 14px',
    borderRadius: '8px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  },
};

export type ChartColorScheme = 'emerald' | 'teal' | 'cyan' | 'amber' | 'rose' | 'multi';

export function getColorScheme(scheme: ChartColorScheme): string[] {
  switch (scheme) {
    case 'emerald': return ['#10b981', '#34d399', '#6ee7b7', '#a7f3d0', '#d1fae5'];
    case 'teal': return ['#14b8a6', '#2dd4bf', '#5eead4', '#99f6e4', '#ccfbf1'];
    case 'cyan': return ['#06b6d4', '#22d3ee', '#67e8f9', '#a5f3fc', '#cffafe'];
    case 'amber': return ['#f59e0b', '#fbbf24', '#fcd34d', '#fde68a', '#fef3c7'];
    case 'rose': return ['#f43f5e', '#fb7185', '#fda4af', '#fecdd3', '#ffe4e6'];
    case 'multi': return chartTheme.departmentColors;
  }
}

/** Standard tooltip content style derived from chartTheme */
export function getTooltipStyle(isDark?: boolean) {
  return {
    background: isDark ? '#1e293b' : chartTheme.tooltip.backgroundColor,
    border: chartTheme.tooltip.border,
    borderRadius: chartTheme.tooltip.borderRadius as string,
    padding: chartTheme.tooltip.padding,
    boxShadow: chartTheme.tooltip.boxShadow,
    fontSize: '12px' as const,
    color: isDark ? '#e2e8f0' : '#374151',
  };
}
