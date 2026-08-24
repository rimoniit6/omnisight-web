'use client';

import { useQuery } from '@tanstack/react-query';
import { WelcomeBanner } from './welcome-banner';
import { KpiCards } from './kpi-cards';
import { ProductivityChart } from './productivity-chart';
import { DepartmentChart } from './department-chart';
import { DeviceStatusChart } from './device-status-chart';
import { ActivityFeed } from './activity-feed';
import { TopEmployees } from './top-employees';
import { DashboardSkeleton } from './dashboard-skeleton';
import { WidgetCustomizer } from './widget-customizer';
import { LiveFeedPanel } from './live-feed-panel';
import { useWebSocket, type ActivityPingEvent } from '@/components/providers/websocket-provider';
import { useAppStore } from '@/lib/store';
import { useWidgetStore, type WidgetId } from '@/lib/widget-store';
import { useRef, useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, UserPlus, FileBarChart, Bell, Settings, Radio } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PdfDownloadButton } from '@/components/reports/pdf-download-button';
import { pushUnique } from '@/lib/live-ticker';
import { format } from 'date-fns';

// Chart widgets paired in 2-col grids (module scope: referentially stable).
const CHART_WIDGET_IDS = ['productivity-chart', 'department-chart', 'device-chart', 'top-employees'] as const;

function getVisibleOrderedWidgets(widgets: ReturnType<typeof useWidgetStore.getState>['widgets']): WidgetId[] {
  return widgets
    .filter((w) => w.visible)
    .sort((a, b) => a.order - b.order)
    .map((w) => w.id);
}

const fadeVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

// Live Activity strip length (was the inline `.slice(0, 3)`).
const TICKER_MAX = 3;

export function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard');
      const json = await res.json();
      return json.data;
    },
  });

  const [liveFeedOpen, setLiveFeedOpen] = useState(false);

  // Single WebSocket connection (shared via context)
  const { isConnected, lastActivity } = useWebSocket();

  const activityBuffer = useRef<ActivityPingEvent[]>([]);
  const [tickerItems, setTickerItems] = useState<ActivityPingEvent[]>([]);

  const { setCurrentPage } = useAppStore();
  const { widgets } = useWidgetStore();

  const visibleOrdered = useMemo(() => getVisibleOrderedWidgets(widgets), [widgets]);

  // Group chart widgets into rows of 2, preserving order
  const chartRows = useMemo(() => {
    const charts = CHART_WIDGET_IDS.filter((id) => visibleOrdered.includes(id));
    const rows: (typeof CHART_WIDGET_IDS[number])[][] = [];
    for (let i = 0; i < charts.length; i += 2) {
      rows.push(charts.slice(i, i + 2));
    }
    return rows;
  }, [visibleOrdered]);

  useEffect(() => {
    if (lastActivity) {
      // Idempotent insertion keyed on the event's stable id (the DB primary
      // key for activity rows). If the same activity is delivered twice over
      // the socket (broadcast retry / reconnect race / historical poll-cursor
      // re-broadcast), the duplicate is REPLACED instead of appended — never
      // two children with the same React key. The incoming event is always
      // newest, so it lands first; the strip stays capped at TICKER_MAX.
      activityBuffer.current = pushUnique(activityBuffer.current, lastActivity, TICKER_MAX, (e) => e.id);
      setTickerItems(activityBuffer.current);
    }
  }, [lastActivity]);

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  const quickActions = [
    { icon: UserPlus, label: 'Add Employee', onClick: () => setCurrentPage('employees') },
    { icon: FileBarChart, label: 'Generate Report', onClick: () => setCurrentPage('reports') },
    { icon: Bell, label: 'View Alerts', onClick: () => setCurrentPage('alerts') },
    { icon: Settings, label: 'Settings', onClick: () => setCurrentPage('settings') },
  ];

  return (
    <div data-tour-target="dashboard-content" className="space-y-6 overflow-x-hidden" role="region" aria-label="Dashboard">
      {/* Top bar: quick actions + customize */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-lg border border-border bg-card p-1 shadow-sm">
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <Tooltip key={action.label}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={action.onClick}
                      aria-label={action.label}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span className="hidden md:inline">{action.label}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs font-medium">{action.label}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PdfDownloadButton
            endpoint="/api/reports/pdf/dashboard"
            body={{}}
            filename={`dashboard-report-${format(new Date(), 'yyyy-MM-dd')}.pdf`}
            label="Export PDF"
            size="sm"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setLiveFeedOpen(!liveFeedOpen)}
                className="relative flex items-center justify-center h-9 px-3 rounded-full border bg-background hover:bg-muted transition-colors gap-2"
              >
                <Radio className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-medium">Live</span>
                {isConnected && (
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p className="text-xs font-medium">Live Event Feed</p></TooltipContent>
          </Tooltip>
          <WidgetCustomizer />
        </div>
      </div>

      {/* Live Feed Floating Panel */}
      <AnimatePresence>
        {liveFeedOpen && (
          <LiveFeedPanel isOpen={liveFeedOpen} onClose={() => setLiveFeedOpen(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence mode="popLayout">
        {/* Welcome Banner */}
        {visibleOrdered.includes('welcome') && (
          <motion.div key="welcome" variants={fadeVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.3 }}>
            <WelcomeBanner />
          </motion.div>
        )}

        {/* KPI Cards */}
        {visibleOrdered.includes('kpi') && (
          <motion.div key="kpi" variants={fadeVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.3, delay: 0.05 }}>
            <KpiCards
                data={data ? {
                  totalEmployees: data.totalEmployees,
                  totalDevices: data.totalDevices,
                  onlineDevices: data.onlineDevices,
                  avgProductivity: data.avgProductivity,
                  activeAlerts: data.activeAlerts,
                  productivityScore: data.productivityScore ?? 0,
                } : undefined}
                isLoading={false}
              />
          </motion.div>
        )}

        {/* Chart rows */}
        {chartRows.map((row, rowIdx) => (
          <motion.div
            key={`chart-row-${rowIdx}`}
            className="grid grid-cols-1 lg:grid-cols-2 gap-6"
            variants={fadeVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.3, delay: 0.1 + rowIdx * 0.05 }}
          >
            {row.map((chartId) => (
              <div key={chartId} className="rounded-xl">
                {chartId === 'productivity-chart' && (
                  <ProductivityChart data={data?.dailyProductivity} isLoading={false} />
                )}
                {chartId === 'department-chart' && (
                  <DepartmentChart data={data?.departmentBreakdown} isLoading={false} />
                )}
                {chartId === 'device-chart' && (
                  <DeviceStatusChart data={data?.deviceStatusBreakdown} isLoading={false} />
                )}
                {chartId === 'top-employees' && (
                  <TopEmployees data={data?.topEmployees} isLoading={false} />
                )}
              </div>
            ))}
          </motion.div>
        ))}

        {/* Activity Feed */}
        {visibleOrdered.includes('activity-feed') && (
          <motion.div key="activity-feed" variants={fadeVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.3, delay: 0.15 }}>
            <ActivityFeed data={data?.recentActivities} isLoading={false} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Live Activity Ticker */}
      <AnimatePresence>
        {tickerItems.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="border shadow-sm rounded-lg overflow-hidden"
          >
            <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 border-b">
              <Zap className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-semibold text-foreground">Live Activity</span>
              <span className="relative flex h-2 w-2 ml-1">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
              </span>
            </div>
            <div className="divide-y max-h-36 overflow-y-auto">
              {tickerItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between px-4 py-2 gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                      item.category === 'productive'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : item.category === 'neutral'
                          ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                          : 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
                    }`}>{
                      item.category
                    }</span>
                    <span className="text-xs truncate"><span className="font-medium">{item.employeeName}</span> — {item.activityType === 'website' && item.activityUrl ? item.activityUrl : item.activityTitle}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{item.department}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
