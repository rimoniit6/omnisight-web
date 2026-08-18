'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { WebSocketProvider } from '@/components/providers/websocket-provider';
import { PresenceProvider } from '@/components/providers/presence-provider';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <WebSocketProvider>
        <PresenceProvider>
          {children}
        </PresenceProvider>
      </WebSocketProvider>
    </QueryClientProvider>
  );
}
