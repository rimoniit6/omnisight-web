'use client';

import React from 'react';
import { Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  icon?: React.ElementType;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
        <Icon className="w-7 h-7 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-semibold text-foreground mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-sm mb-4">{description}</p>
      {action && (
        <Button
          variant="outline"
          size="sm"
          onClick={action.onClick}
          className="text-emerald-600 border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
