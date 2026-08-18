'use client';

import { useWebSocket, type LiveEventLog } from '@/components/providers/websocket-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

import { cn } from '@/lib/utils';
import {
  Monitor,
  Activity,
  Bell,
  Pause,
  Camera,
  UserPlus,
  Wifi,
  WifiOff,
  Radio,
  X,
  Trash2,
  Zap,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';

const eventIcons: Record<string, { icon: React.ElementType; color: string; bgColor: string }> = {
  'device-status': { icon: Monitor, color: 'text-blue-600 dark:text-blue-400', bgColor: 'bg-blue-100 dark:bg-blue-900/30' },
  'activity-ping': { icon: Activity, color: 'text-emerald-600 dark:text-emerald-400', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30' },
  'notification': { icon: Bell, color: 'text-amber-600 dark:text-amber-400', bgColor: 'bg-amber-100 dark:bg-amber-900/30' },
  'break-status': { icon: Pause, color: 'text-orange-600 dark:text-orange-400', bgColor: 'bg-orange-100 dark:bg-orange-900/30' },
  'screenshot': { icon: Camera, color: 'text-purple-600 dark:text-purple-400', bgColor: 'bg-purple-100 dark:bg-purple-900/30' },
  'agent-registration': { icon: UserPlus, color: 'text-teal-600 dark:text-teal-400', bgColor: 'bg-teal-100 dark:bg-teal-900/30' },
};

const priorityStyles: Record<string, string> = {
  low: 'border-l-slate-300 dark:border-l-slate-600',
  medium: 'border-l-amber-400 dark:border-l-amber-600',
  high: 'border-l-rose-400 dark:border-l-rose-600',
  critical: 'border-l-red-500 dark:border-l-red-400',
};

interface LiveFeedPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

function EventItem({ event, index }: { event: LiveEventLog; index: number }) {
  const config = eventIcons[event.type] || eventIcons['activity-ping'];
  const Icon = config.icon;
  const pStyle = priorityStyles[event.priority || 'low'] || priorityStyles.low;

  return (
    <motion.div
      initial={{ opacity: 0, x: -20, height: 0 }}
      animate={{ opacity: 1, x: 0, height: 'auto' }}
      exit={{ opacity: 0, x: 20, height: 0 }}
      transition={{ duration: 0.25, delay: index * 0.03 }}
      className={cn(
        'flex items-start gap-3 px-3 py-2.5 rounded-lg border-l-2 bg-card hover:bg-muted/30 transition-colors',
        pStyle
      )}
    >
      <div className={cn('h-7 w-7 rounded-md flex items-center justify-center shrink-0 mt-0.5', config.bgColor)}>
        <Icon className={cn('h-3.5 w-3.5', config.color)} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground truncate">{event.title}</p>
        <p className="text-[11px] text-muted-foreground truncate mt-0.5">{event.description}</p>
      </div>
      <span className="text-[10px] text-muted-foreground/60 shrink-0 mt-0.5">
        {formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })}
      </span>
    </motion.div>
  );
}

export function LiveFeedPanel({ isOpen, onClose }: LiveFeedPanelProps) {
  const {
    isConnected,
    serverInfo,
    eventLog,
    clearEventLog,
    lastDeviceUpdate,
    lastBreakStatus,
    lastNotification,
    lastScreenshot,
    lastAgentRegistration,
  } = useWebSocket();

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      className="fixed bottom-4 right-4 z-floating w-[340px] max-w-[calc(100vw-2rem)] max-h-[480px] flex flex-col rounded-xl border shadow-xl bg-background"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Radio className="h-4 w-4 text-primary" />
            {isConnected && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            )}
          </div>
          <h3 className="text-sm font-semibold">Live Feed</h3>
          {isConnected ? (
            <Badge className="bg-emerald-100 text-emerald-700 text-[9px] h-4 px-1.5 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400">
              <Wifi className="h-2.5 w-2.5 mr-0.5" />
              Connected
            </Badge>
          ) : (
            <Badge className="bg-slate-100 text-slate-500 text-[9px] h-4 px-1.5 border-slate-200 dark:bg-slate-800 dark:text-slate-400">
              <WifiOff className="h-2.5 w-2.5 mr-0.5" />
              Offline
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {eventLog.length > 0 && (
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={clearEventLog}>
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/20">
        {serverInfo && (
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <span><Zap className="h-3 w-3 inline mr-0.5 text-emerald-500" />{serverInfo.deviceCount} devices</span>
            <span>{serverInfo.employeeCount} employees</span>
          </div>
        )}
        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground font-medium">
          {eventLog.length} events
        </span>
      </div>

      {/* Event List */}
      <ScrollArea className="flex-1 max-h-[340px]">
        <div className="p-2 space-y-1">
          {eventLog.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Radio className="h-8 w-8 mb-2 opacity-30" />
              <p className="text-xs">Waiting for live events...</p>
              <p className="text-[10px] opacity-60 mt-1">Events appear here in real-time</p>
            </div>
          ) : (
            <AnimatePresence mode="popLayout">
              {eventLog.map((event, i) => (
                <EventItem key={event.id} event={event} index={i} />
              ))}
            </AnimatePresence>
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="px-4 py-2 border-t bg-muted/20">
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {lastDeviceUpdate && (
            <span className="flex items-center gap-0.5">
              <Monitor className="h-2.5 w-2.5" />
              Device {lastDeviceUpdate.newStatus}
            </span>
          )}
          {lastBreakStatus && (
            <span className="flex items-center gap-0.5">
              <Pause className="h-2.5 w-2.5" />
              Break {lastBreakStatus.action}
            </span>
          )}
          {lastNotification && (
            <span className="flex items-center gap-0.5">
              <Bell className="h-2.5 w-2.5" />
              Alert
            </span>
          )}
          {lastScreenshot && (
            <span className="flex items-center gap-0.5">
              <Camera className="h-2.5 w-2.5" />
              Screenshot
            </span>
          )}
          {lastAgentRegistration && (
            <span className="flex items-center gap-0.5">
              <UserPlus className="h-2.5 w-2.5" />
              Registration
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
