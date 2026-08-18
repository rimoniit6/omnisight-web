"use client";

import * as React from "react";
import { format } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { type DateRange } from "react-day-picker";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface DatePickerWithRangeProps {
  date: DateRange | undefined;
  onDateChange: (date: DateRange | undefined) => void;
  className?: string;
  align?: "start" | "center" | "end";
}

export function DatePickerWithRange({
  date,
  onDateChange,
  className,
  align = "start",
}: DatePickerWithRangeProps) {
  return (
    <div className={cn("grid gap-2", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id="date"
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal h-9 text-sm",
              !date && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4 shrink-0 text-emerald-500" />
            {date?.from ? (
              date.to ? (
                <>
                  {format(date.from, "MMM dd, yyyy")} – {format(date.to, "MMM dd, yyyy")}
                </>
              ) : (
                format(date.from, "MMM dd, yyyy")
              )
            ) : (
              <span>Pick a date range</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align={align}>
          <Calendar
            initialFocus
            mode="range"
            defaultMonth={date?.from}
            selected={date}
            onSelect={onDateChange}
            numberOfMonths={2}
            captionLayout="dropdown"
          />
          <div className="flex items-center justify-between px-4 pb-3 pt-1 border-t">
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 px-2"
                onClick={() => {
                  const today = new Date();
                  onDateChange({ from: today, to: today });
                }}
              >
                Today
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 px-2"
                onClick={() => {
                  const today = new Date();
                  const weekAgo = new Date(today);
                  weekAgo.setDate(weekAgo.getDate() - 7);
                  onDateChange({ from: weekAgo, to: today });
                }}
              >
                Last 7 days
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 px-2"
                onClick={() => {
                  const today = new Date();
                  const monthAgo = new Date(today);
                  monthAgo.setDate(monthAgo.getDate() - 30);
                  onDateChange({ from: monthAgo, to: today });
                }}
              >
                Last 30 days
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 px-2"
                onClick={() => {
                  const today = new Date();
                  const threeMonthsAgo = new Date(today);
                  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
                  onDateChange({ from: threeMonthsAgo, to: today });
                }}
              >
                Last 90 days
              </Button>
            </div>
            {date?.from && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 px-2 text-muted-foreground"
                onClick={() => onDateChange(undefined)}
              >
                Clear
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
