'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatDistanceToNow } from 'date-fns';
import { isHeartbeatFresh } from '@/lib/presence';

const statusConfig: Record<string, { class: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  online: { class: 'bg-success/10 text-success border-success/25 hover:bg-success/15 hover:text-success capitalize', variant: 'outline' },
  offline: { class: 'bg-danger/10 text-danger border-danger/25 hover:bg-danger/15 hover:text-danger capitalize', variant: 'outline' },
  maintenance: { class: 'bg-warning/10 text-warning border-warning/25 hover:bg-warning/15 hover:text-warning capitalize', variant: 'outline' },
  inactive: { class: 'bg-muted text-muted-foreground hover:bg-muted/80 capitalize', variant: 'secondary' },
  retired: { class: 'bg-muted text-muted-foreground hover:bg-muted/80 capitalize', variant: 'secondary' },
};

interface Device {
  id: string;
  name: string;
  hostname: string | null;
  operatingSystem: string | null;
  status: string;
  employee: { id: string; firstName: string; lastName: string } | null;
  lastHeartbeat: string | null;
  updatedAt: string;
}

interface DeviceTableProps {
  devices: Device[];
  onEdit: (dev: Device) => void;
  onDelete: (id: string) => void;
}

function getOfflineMessage(lastHeartbeat: string | null, _updatedAt: string): string | null {
  if (!lastHeartbeat) return null;
  const diffMs = Date.now() - new Date(lastHeartbeat).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `Went offline ${diffMin} min ago`;
  if (diffMin < 1440) return `Went offline ${Math.floor(diffMin / 60)} hours ago`;
  return null;
}

export function DeviceTable({ devices, onEdit, onDelete }: DeviceTableProps) {
  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b">
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Device</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">OS</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">Assigned To</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden xl:table-cell">Last Heartbeat</th>
              <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {devices.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No devices found</td></tr>
            )}
            {devices.map((dev) => {
              // Device.status is a sticky lifecycle field that never reverts to
              // 'offline' at runtime — online/offline display is derived from
              // heartbeat freshness instead (same semantics as presence).
              const isLifecyclePinned = ['maintenance', 'inactive', 'retired'].includes(dev.status);
              const liveOnline = !isLifecyclePinned && isHeartbeatFresh(dev.lastHeartbeat ? new Date(dev.lastHeartbeat) : null);
              const displayStatus = isLifecyclePinned ? dev.status : liveOnline ? 'online' : 'offline';
              const sc = statusConfig[displayStatus] || statusConfig.inactive;
              const isOnline = liveOnline;
              const isOffline = displayStatus === 'offline';
              const offlineMsg = isOffline ? getOfflineMessage(dev.lastHeartbeat, dev.updatedAt) : null;

              return (
                <tr
                  key={dev.id}
                  className="hover:bg-muted/40 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {isOnline && (
                        <span className="relative flex h-2.5 w-2.5 shrink-0">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-60" />
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-success" />
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="font-medium truncate">{dev.name}</p>
                        {dev.hostname && <p className="text-xs text-muted-foreground">{dev.hostname}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className="text-sm text-muted-foreground">{dev.operatingSystem || '—'}</span>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    <span className="text-sm">{dev.employee ? `${dev.employee.firstName} ${dev.employee.lastName}` : '—'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <Badge className={sc.class} variant={sc.variant}>{displayStatus}</Badge>
                      {offlineMsg && (
                        <span className="text-[10px] text-danger">{offlineMsg}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden xl:table-cell">
                    <span className="text-xs text-muted-foreground">
                      {dev.lastHeartbeat
                        ? formatDistanceToNow(new Date(dev.lastHeartbeat), { addSuffix: true })
                        : 'Never'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 focus-ring-animated"><MoreHorizontal className="w-4 h-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onEdit(dev)}><Pencil className="mr-2 h-4 w-4" /> Edit</DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive" onClick={() => onDelete(dev.id)}><Trash2 className="mr-2 h-4 w-4" /> Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
