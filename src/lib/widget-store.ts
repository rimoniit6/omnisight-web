'use client';

import { create } from 'zustand';

export type WidgetId = 'welcome' | 'kpi' | 'productivity-chart' | 'department-chart' | 'device-chart' | 'top-employees' | 'activity-feed';

export interface WidgetConfig {
  id: WidgetId;
  visible: boolean;
  order: number;
}

interface WidgetState {
  widgets: WidgetConfig[];
  setWidgetVisible: (id: WidgetId, visible: boolean) => void;
  reorderWidgets: (fromIndex: number, toIndex: number) => void;
  resetWidgets: () => void;
}

const defaultWidgets: WidgetConfig[] = [
  { id: 'welcome', visible: true, order: 0 },
  { id: 'kpi', visible: true, order: 1 },
  { id: 'productivity-chart', visible: true, order: 2 },
  { id: 'department-chart', visible: true, order: 3 },
  { id: 'device-chart', visible: true, order: 4 },
  { id: 'top-employees', visible: true, order: 5 },
  { id: 'activity-feed', visible: true, order: 6 },
];

function loadWidgets(): WidgetConfig[] {
  if (typeof window === 'undefined') return defaultWidgets;
  try {
    const saved = localStorage.getItem('worklens-widget-layout');
    if (saved) return JSON.parse(saved);
  } catch {
    // ignore parse errors
  }
  return defaultWidgets;
}

function saveWidgets(widgets: WidgetConfig[]) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('worklens-widget-layout', JSON.stringify(widgets));
  }
}

export const useWidgetStore = create<WidgetState>((set) => ({
  widgets: loadWidgets(),
  setWidgetVisible: (id, visible) => {
    set((state) => {
      const widgets = state.widgets.map((w) => (w.id === id ? { ...w, visible } : w));
      saveWidgets(widgets);
      return { widgets };
    });
  },
  reorderWidgets: (fromIndex, toIndex) => {
    set((state) => {
      const widgets = [...state.widgets];
      const [moved] = widgets.splice(fromIndex, 1);
      widgets.splice(toIndex, 0, moved);
      const reordered = widgets.map((w, i) => ({ ...w, order: i }));
      saveWidgets(reordered);
      return { widgets: reordered };
    });
  },
  resetWidgets: () => {
    saveWidgets(defaultWidgets);
    set({ widgets: defaultWidgets });
  },
}));

/** Human-readable labels and icons for each widget */
export const widgetMeta: Record<WidgetId, { label: string; icon: string }> = {
  welcome: { label: 'Welcome Banner', icon: 'Sparkles' },
  kpi: { label: 'KPI Cards', icon: 'BarChart3' },
  'productivity-chart': { label: 'Productivity Chart', icon: 'TrendingUp' },
  'department-chart': { label: 'Department Chart', icon: 'Building2' },
  'device-chart': { label: 'Device Status', icon: 'Monitor' },
  'top-employees': { label: 'Top Employees', icon: 'Trophy' },
  'activity-feed': { label: 'Activity Feed', icon: 'Activity' },
};
