'use client';

// Legacy re-export - all consumers should migrate to WebSocketProvider context
// This file provides backward compatibility for existing imports
export {
  useWebSocket,
  useWebSocket as useLiveUpdates,
  WebSocketProvider,
  type DeviceStatusEvent,
  type ActivityPingEvent,
  type NotificationEvent,
  type BreakStatusEvent,
  type ScreenshotEvent,
  type ConnectedEvent,
  type LiveEventLog,
  type LiveEventType,
  type UsbEventEvent,
} from '@/components/providers/websocket-provider';
