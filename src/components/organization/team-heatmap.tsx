'use client';

import { useMemo, Fragment, type CSSProperties } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Flame } from 'lucide-react';

interface HeatmapCell {
  department: string;
  dayOfWeek: string;
  avgHours: number;
  avgProductivity: number;
}

interface TeamHeatmapProps {
  data: HeatmapCell[];
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WORK_DISTRIBUTION: Record<string, number> = {
  Mon: 20,
  Tue: 20,
  Wed: 20,
  Thu: 20,
  Fri: 20,
  Sat: 0,
  Sun: 0,
};

function getHeatColor(value: number, max: number): CSSProperties {
  if (max === 0 || value === 0) return { backgroundColor: 'rgb(236 253 245)' }; // emerald-50
  const ratio = Math.min(value / max, 1);
  if (ratio < 0.33) {
    // Light green
    const r = Math.round(209 - ratio * 3 * (209 - 167));
    const g = Math.round(250 - ratio * 3 * (250 - 243));
    const b = Math.round(229 - ratio * 3 * (229 - 208));
    return { backgroundColor: `rgb(${r}, ${g}, ${b})` };
  } else if (ratio < 0.66) {
    // Medium emerald
    const t = (ratio - 0.33) / 0.33;
    const r = Math.round(167 - t * (167 - 16));
    const g = Math.round(243 - t * (243 - 185));
    const b = Math.round(208 - t * (208 - 129));
    return { backgroundColor: `rgb(${r}, ${g}, ${b})` };
  } else {
    // Dark green/emerald
    const t = (ratio - 0.66) / 0.34;
    const r = Math.round(16 - t * 16);
    const g = Math.round(185 - t * (185 - 132));
    const b = Math.round(129 - t * (129 - 82));
    return { backgroundColor: `rgb(${r}, ${g}, ${b})` };
  }
}

function getTextColor(value: number, max: number): string {
  if (max === 0 || value === 0) return 'text-emerald-300';
  const ratio = value / max;
  return ratio > 0.5 ? 'text-white' : 'text-emerald-700';
}

export function TeamHeatmap({ data }: TeamHeatmapProps) {
  const { departments, maxValue, gridMap } = useMemo(() => {
    const deptSet = new Set(data.map(d => d.department));
    const deptList = Array.from(deptSet).sort();
    let max = 0;
    const map: Record<string, Record<string, HeatmapCell>> = {};

    for (const d of data) {
      if (d.avgHours > max) max = d.avgHours;
      if (!map[d.department]) map[d.department] = {};
      map[d.department][d.dayOfWeek] = d;
    }

    return { departments: deptList, maxValue: max, gridMap: map };
  }, [data]);

  if (departments.length === 0) {
    return (
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Flame className="w-4 h-4 text-emerald-500" />
            Team Activity Heatmap
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">No activity data available</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Flame className="w-4 h-4 text-emerald-500" />
          Team Activity Heatmap
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          {/* Column headers with work distribution */}
          <div className="grid gap-1 min-w-[520px]" style={{ gridTemplateColumns: `140px repeat(7, 1fr)` }}>
            <div />
            {DAYS.map(day => (
              <div key={day} className="text-center">
                <span className="text-xs font-medium text-muted-foreground">{day}</span>
                <span className="block text-[10px] text-muted-foreground/60">{WORK_DISTRIBUTION[day]}%</span>
              </div>
            ))}
          </div>

          {/* Heatmap grid */}
          <div className="grid gap-1 mt-1 min-w-[520px]" style={{ gridTemplateColumns: `140px repeat(7, 1fr)` }}>
            {departments.map(dept => (
              <Fragment key={dept}>
                <div className="flex items-center text-xs font-medium text-foreground truncate pr-2">
                  {dept}
                </div>
                {DAYS.map(day => {
                  const cell = gridMap[dept]?.[day];
                  const hours = cell?.avgHours || 0;
                  const productivity = cell?.avgProductivity || 0;
                  return (
                    <Tooltip key={`${dept}-${day}`}>
                      <TooltipTrigger asChild>
                        <div
                          className="h-9 rounded-md flex items-center justify-center text-[10px] font-medium cursor-default transition-transform hover:scale-105"
                          style={getHeatColor(hours, maxValue)}
                        >
                          <span className={getTextColor(hours, maxValue)}>
                            {hours > 0 ? `${hours.toFixed(1)}h` : '—'}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        <div className="font-medium">{dept} · {day}</div>
                        <div className="text-muted-foreground">Avg: {hours.toFixed(2)} hrs</div>
                        <div className="text-muted-foreground">Productivity: {(productivity * 100).toFixed(0)}%</div>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </Fragment>
            ))}
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center gap-2 mt-4">
            <span className="text-[10px] text-muted-foreground">Low</span>
            <div className="flex gap-0.5">
              {Array.from({ length: 7 }).map((_, i) => {
                const val = (maxValue / 6) * i;
                return (
                  <div
                    key={i}
                    className="h-3 w-6 rounded-sm"
                    style={getHeatColor(val, maxValue)}
                  />
                );
              })}
            </div>
            <span className="text-[10px] text-muted-foreground">High</span>
            <span className="text-[10px] text-muted-foreground ml-2">(avg activity hours)</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
