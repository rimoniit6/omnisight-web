'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Settings2,
  Sparkles,
  BarChart3,
  TrendingUp,
  Building2,
  Monitor,
  Trophy,
  Activity,
  RotateCcw,
  GripVertical,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useWidgetStore,
  widgetMeta,
  type WidgetConfig,
} from '@/lib/widget-store';

const iconMap: Record<string, React.ElementType> = {
  Sparkles,
  BarChart3,
  TrendingUp,
  Building2,
  Monitor,
  Trophy,
  Activity,
};

function SortableWidget({
  widget,
  onToggle,
}: {
  widget: WidgetConfig;
  onToggle: (id: WidgetConfig['id'], visible: boolean) => void;
}) {
  const meta = widgetMeta[widget.id];
  const IconComp = iconMap[meta.icon] ?? Activity;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: widget.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    scale: isDragging ? 1.02 : 1,
    zIndex: isDragging ? 50 : undefined,
  boxShadow: isDragging
      ? '0 4px 12px rgba(0, 0, 0, 0.1)'
      : undefined,
  position: 'relative' as const,
  cursor: 'default',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded-lg px-2 py-2 transition-colors select-none ${
        widget.visible
          ? 'bg-background'
          : 'bg-muted/40 opacity-60'
      }`}
    >
      {/* Drag handle */}
      <button
        type="button"
        className="p-0.5 rounded hover:bg-muted cursor-grab active:cursor-grabbing shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        aria-label={`Drag to reorder ${meta.label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>

      {/* Icon */}
      <div
        className={`flex items-center justify-center w-7 h-7 rounded-md shrink-0 transition-colors ${
          widget.visible
            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
            : 'bg-muted text-muted-foreground'
        }`}
      >
        <IconComp className="w-3.5 h-3.5" />
      </div>

      {/* Label */}
      <span className="text-sm font-medium flex-1 truncate">
        {meta.label}
      </span>

      {/* Visibility toggle */}
      <Switch
        checked={widget.visible}
        onCheckedChange={(checked) => onToggle(widget.id, checked)}
        aria-label={`Toggle ${meta.label}`}
      />
    </div>
  );
}

export function WidgetCustomizer() {
  const { widgets, setWidgetVisible, reorderWidgets, resetWidgets } = useWidgetStore();
  const [open, setOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const sorted = [...widgets].sort((a, b) => a.order - b.order);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIdx = sorted.findIndex((w) => w.id === active.id);
      const newIdx = sorted.findIndex((w) => w.id === over.id);
      if (oldIdx !== -1 && newIdx !== -1) {
        reorderWidgets(oldIdx, newIdx);
      }
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
            >
              <Settings2 className="w-4 h-4" />
              <span className="hidden sm:inline">Customize</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="tooltip-pop">
          <p className="text-xs font-medium">Customize dashboard layout</p>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        side="bottom"
        className="w-80 p-0"
      >
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-100 dark:bg-emerald-900/40">
                <Settings2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold leading-tight">Dashboard Widgets</h3>
                <p className="text-[11px] text-muted-foreground">Toggle & reorder widgets</p>
              </div>
            </div>
          </div>

          <Separator className="my-1" />

          {/* Widget list */}
          <div className="max-h-80 overflow-y-auto px-2 py-2 space-y-0.5">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={sorted.map((w) => w.id)}
                strategy={verticalListSortingStrategy}
              >
                {sorted.map((widget) => (
                  <SortableWidget
                    key={widget.id}
                    widget={widget}
                    onToggle={setWidgetVisible}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>

          <Separator className="my-1" />

          {/* Footer */}
          <div className="px-4 pb-3 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full gap-2 text-muted-foreground hover:text-foreground"
              onClick={() => {
                resetWidgets();
              }}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset to Default
            </Button>
          </div>
        </motion.div>
      </PopoverContent>
    </Popover>
  );
}
