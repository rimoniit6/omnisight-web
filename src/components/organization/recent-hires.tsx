'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { UserPlus } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion } from 'framer-motion';

interface RecentHire {
  id: string;
  firstName: string;
  lastName: string;
  designation: string;
  department: string;
  joinDate: string;
  avatar?: string | null;
}

interface RecentHiresProps {
  hires: RecentHire[];
}

const deptColors: Record<string, string> = {
  Engineering: 'bg-emerald-100 text-emerald-700',
  Marketing: 'bg-teal-100 text-teal-700',
  Sales: 'bg-cyan-100 text-cyan-700',
  Design: 'bg-amber-100 text-amber-700',
  HR: 'bg-rose-100 text-rose-700',
  Finance: 'bg-purple-100 text-purple-700',
};

function getDeptColor(dept: string): string {
  return deptColors[dept] || 'bg-slate-100 text-slate-700';
}

export function RecentHires({ hires }: RecentHiresProps) {
  if (hires.length === 0) {
    return (
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-emerald-500" />
            Recent Hires
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">No recent hires</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-emerald-500" />
          Recent Hires
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative">
          {/* Dotted connecting line */}
          <div className="absolute left-5 top-0 bottom-0 w-px border-l border-dashed border-emerald-200" />

          <div className="space-y-4">
            {hires.map((hire, index) => {
              const timeAgo = formatDistanceToNow(new Date(hire.joinDate), { addSuffix: true });
              return (
                <motion.div
                  key={hire.id}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.35, delay: index * 0.1 }}
                  className="relative flex items-start gap-4 pl-2"
                >
                  {/* Avatar with ring */}
                  <div className="relative z-10 shrink-0">
                    <Avatar className="h-10 w-10 border-2 border-white shadow-sm">
                      <AvatarFallback className={`text-xs font-bold ${getDeptColor(hire.department)}`}>
                        {hire.firstName[0]}{hire.lastName[0]}
                      </AvatarFallback>
                    </Avatar>
                    {/* Dot on the timeline */}
                    <div className="absolute -left-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white" />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0 pt-0.5">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                      <span className="font-medium text-sm">{hire.firstName} {hire.lastName}</span>
                      <Badge variant="outline" className="text-[10px] h-4 px-1.5 w-fit">
                        {hire.department}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{hire.designation}</p>
                    <p className="text-[11px] text-emerald-600 mt-1">Joined {timeAgo}</p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
