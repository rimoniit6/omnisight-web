'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DeviceTable } from './device-table';
import { DeviceDialog } from './device-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Plus, Monitor, Wifi, WifiOff, Wrench, MonitorX, ShieldCheck, AlertCircle } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PaginationControls } from '@/components/ui/pagination-controls';
import { toast } from 'sonner';
import { QuickStats, type QuickStat } from '@/components/ui/quick-stats';
import { useLiveUpdates } from '@/hooks/use-live-updates';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';

const PIE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--primary)'];

interface Device {
  id: string;
  name: string;
  hostname: string | null;
  operatingSystem: string | null;
  osVersion: string | null;
  processor: string | null;
  memory: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  status: string;
  employeeId: string | null;
  employee?: { id: string; firstName: string; lastName: string } | null;
  lastHeartbeat?: string | null;
  updatedAt?: string;
}

export function DevicesPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editDevice, setEditDevice] = useState<Device | null>(null);
  const [page, setPage] = useState(1);
  const [liveUpdates, setLiveUpdates] = useState(false);
  const [timeAgo, setTimeAgo] = useState('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastUpdatedRef = useRef<number | null>(null);
  const queryClient = useQueryClient();

  const { isConnected } = useLiveUpdates();

  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['devices', statusFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', '10');
      if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter);
      const res = await fetch(`/api/devices?${params}`);
      return res.json();
    },
    // Bounded fallback: realtime events (device-status / employee-presence)
    // are the fast path while the socket is connected. When the socket is
    // unavailable, poll at a slow 30s cadence so a stopped agent still flips
    // to OFFLINE without a manual reload — never an aggressive loop.
    refetchInterval: liveUpdates ? 15000 : isConnected ? false : 30000,
  });

  const { data: summary } = useQuery({
    queryKey: ['device-summary'],
    queryFn: async () => {
      const res = await fetch('/api/devices/summary');
      return res.json();
    },
    refetchInterval: liveUpdates ? 15000 : isConnected ? false : 30000,
  });

  const { data: chartData } = useQuery({
    queryKey: ['device-chart-data'],
    queryFn: async () => {
      const res = await fetch('/api/devices/chart-data');
      return res.json();
    },
    refetchInterval: liveUpdates ? 15000 : isConnected ? false : 30000,
  });

  useEffect(() => {
    if (dataUpdatedAt) {
      lastUpdatedRef.current = dataUpdatedAt;
    }
  }, [dataUpdatedAt]);

  useEffect(() => {
    const update = () => {
      const ts = lastUpdatedRef.current;
      if (!ts) return;
      const seconds = Math.floor((Date.now() - ts) / 1000);
      if (seconds < 60) setTimeAgo(`${seconds} seconds ago`);
      else if (seconds < 3600) setTimeAgo(`${Math.floor(seconds / 60)} min ago`);
      else setTimeAgo(`${Math.floor(seconds / 3600)} hours ago`);
    };
    update();
    intervalRef.current = setInterval(update, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/devices/${id}`, { method: 'DELETE' });
      toast.success('Device deleted');
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      queryClient.invalidateQueries({ queryKey: ['device-summary'] });
      queryClient.invalidateQueries({ queryKey: ['device-chart-data'] });
    } catch {
      toast.error('Failed to delete device');
    }
  };

  const s = summary || {};
  const healthPercent = s.healthPercent || 0;
  const healthColor = healthPercent > 80 ? '[&>div]:bg-success' : healthPercent > 50 ? '[&>div]:bg-warning' : '[&>div]:bg-danger';

  const deviceStats: QuickStat[] = [
    { label: 'Total Devices', value: s.total || 0, icon: Monitor, color: 'emerald' },
    { label: 'Online', value: s.online || 0, icon: Wifi, color: 'emerald' },
    { label: 'Offline', value: s.offline || 0, icon: WifiOff, color: 'rose' },
    { label: 'Maintenance', value: s.maintenance || 0, icon: Wrench, color: 'amber' },
  ];

  const statusChartData = chartData?.statusCounts || [];
  const osData = chartData?.osDistribution || [];
  const uptime = chartData?.uptime || {};

  return (
    <div className="space-y-5" role="region" aria-label="Devices">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Devices</h2>
          <p className="text-sm text-muted-foreground mt-0.5 truncate">
            Monitor your device fleet{s.total ? ` — ${s.online || 0} online of ${s.total}` : ''}
          </p>
        </div>
        <Button
          onClick={() => { setEditDevice(null); setDialogOpen(true); }}
          className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm shrink-0"
        >
          <Plus className="w-4 h-4 mr-2" /> Add Device
        </Button>
      </div>

      {/* Quick Stats */}
      <QuickStats stats={deviceStats} />

      {/* Fleet Overview Card */}
      <Card className="falcon-card falcon-card-hover">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">Fleet Overview</span>
              </div>
              <Badge variant="secondary" className="font-mono text-xs">{s.total || 0} total</Badge>
              <div className="flex items-center gap-1.5">
                <Wifi className="w-3.5 h-3.5 text-success" />
                <span className="text-xs text-success font-medium">{s.online || 0}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <WifiOff className="w-3.5 h-3.5 text-danger" />
                <span className="text-xs text-danger font-medium">{s.offline || 0}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Wrench className="w-3.5 h-3.5 text-warning" />
                <span className="text-xs text-warning font-medium">{s.maintenance || 0}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <MonitorX className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground font-medium">{s.inactive || 0}</span>
              </div>
            </div>
            <div className="flex items-center gap-3 min-w-[200px]">
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-muted-foreground">Fleet Health</span>
                  <span className="text-xs font-semibold">{healthPercent}%</span>
                </div>
                <Progress value={healthPercent} className={`h-1.5 ${healthColor}`} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="border shadow-sm lg:col-span-1">
          <CardHeader className="p-3 pb-0">
            <CardTitle className="text-xs font-medium text-muted-foreground">Device Status Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <div style={{ height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={statusChartData} margin={{ top: 5, right: 5, bottom: 5, left: -15 }}>
                  <XAxis dataKey="status" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--popover))' }}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {statusChartData.map((entry: { color: string }, index: number) => (
                      <Cell key={`bar-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="border shadow-sm lg:col-span-1">
          <CardHeader className="p-3 pb-0">
            <CardTitle className="text-xs font-medium text-muted-foreground">OS Distribution</CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <div style={{ height: 180 }}>
              {osData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={osData}
                      cx="50%"
                      cy="45%"
                      innerRadius={35}
                      outerRadius={55}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {osData.map((_entry: unknown, index: number) => (
                        <Cell key={`pie-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--popover))' }}
                    />
                    <Legend
                      iconSize={8}
                      iconType="circle"
                      wrapperStyle={{ fontSize: 11 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No OS data available</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border shadow-sm lg:col-span-1">
          <CardHeader className="p-3 pb-0">
            <CardTitle className="text-xs font-medium text-muted-foreground">Uptime Statistics</CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <div className="space-y-4 h-[152px] flex flex-col justify-center">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-success/10 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-4 h-4 text-success" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground font-medium leading-tight">Average Uptime</p>
                  <p className="text-xl font-bold text-foreground leading-tight mt-0.5">{uptime.percentage ?? 0}%</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-info/10 flex items-center justify-center shrink-0">
                  <Wifi className="w-4 h-4 text-info" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-muted-foreground font-medium leading-tight">Most Reliable</p>
                  <p className="text-sm font-semibold truncate">{uptime.mostReliableDevice || 'N/A'}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-danger/10 flex items-center justify-center shrink-0">
                  <AlertCircle className="w-4 h-4 text-danger" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground font-medium leading-tight">Needs Attention</p>
                  <p className="text-xl font-bold text-foreground leading-tight mt-0.5">{uptime.needsAttention ?? 0}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex flex-col sm:flex-row gap-3 flex-1 w-full sm:w-auto">
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="online">Online</SelectItem>
              <SelectItem value="offline">Offline</SelectItem>
              <SelectItem value="maintenance">Maintenance</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* WebSocket Live Connection Indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border bg-muted/30">
            <span className="relative flex h-2.5 w-2.5">
              {isConnected ? (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                </>
              ) : (
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-gray-400" />
              )}
            </span>
            <span className={`text-xs font-medium ${isConnected ? 'text-success' : 'text-muted-foreground'}`}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          {/* Live Updates Toggle */}
          <div className="flex items-center gap-2">
            <div className="relative">
              {liveUpdates && (
                <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                </span>
              )}
              <Switch checked={liveUpdates} onCheckedChange={setLiveUpdates} />
            </div>
            <label className="text-sm text-muted-foreground cursor-pointer select-none" onClick={() => setLiveUpdates(!liveUpdates)}>
              Auto-Refresh
            </label>
          </div>

        </div>
      </div>

      {/* Last updated timestamp */}
      {(liveUpdates || isConnected) && timeAgo && (
        <p className="text-xs text-muted-foreground -mt-2">
          Last updated: {timeAgo}
        </p>
      )}

      {/* Device Table */}
      {isLoading ? (
        <div className="border rounded-lg p-8 text-center text-muted-foreground">Loading devices...</div>
      ) : (
        <>
          <DeviceTable
            devices={data?.data || []}
            onEdit={(dev) => { setEditDevice(dev as unknown as Device); setDialogOpen(true); }}
            onDelete={handleDelete}
          />
          <PaginationControls
            currentPage={data?.page || 1}
            totalPages={data?.totalPages || 1}
            totalItems={data?.total || 0}
            pageSize={10}
            onPageChange={setPage}
          />
        </>
      )}
      <DeviceDialog open={dialogOpen} onOpenChange={setDialogOpen} device={editDevice} onSaved={() => { queryClient.invalidateQueries({ queryKey: ['devices'] }); queryClient.invalidateQueries({ queryKey: ['device-summary'] }); queryClient.invalidateQueries({ queryKey: ['device-chart-data'] }); }} />
    </div>
  );
}
