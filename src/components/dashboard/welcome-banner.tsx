'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useCurrentUser } from '@/hooks/use-current-user';
import { UserPlus, BarChart3, FileText, AlertTriangle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

function getMotivationalMessage(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Ready to make today productive!';
  if (hour < 17) return 'Halfway through the day — keep it up!';
  return 'Great work today! Time to wrap up.';
}

function getFormattedDate(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function WelcomeBanner() {
  const { setCurrentPage } = useAppStore();
  const { user } = useCurrentUser();
  const [greeting, setGreeting] = useState(getGreeting());
  const [date, setDate] = useState(getFormattedDate());
  const [motivational, setMotivational] = useState(getMotivationalMessage());

  useEffect(() => {
    const timer = setInterval(() => {
      setGreeting(getGreeting());
      setDate(getFormattedDate());
      setMotivational(getMotivationalMessage());
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  const { data } = useQuery<{
    totalEmployees: number;
    onlineDevices: number;
  } | null>({
    queryKey: ['dashboard-welcome'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard');
      
      // Handle HTTP errors
      if (!res.ok) {
        return null;
      }
      
      const json = await res.json();
      return json.data ?? null;
    },
    staleTime: 60000,
  });

  const activeEmployees = data?.totalEmployees ?? 0;
  const onlineDevices = data?.onlineDevices ?? 0;

  const quickActions = [
    { label: 'Add Employee', icon: UserPlus, page: 'employees' as const },
    { label: 'View Reports', icon: FileText, page: 'reports' as const },
    { label: 'Generate Report', icon: BarChart3, page: 'analytics' as const },
    { label: 'View Alerts', icon: AlertTriangle, page: 'alerts' as const },
  ];

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-primary/[0.06] via-card to-primary/[0.03] dark:from-primary/[0.08] dark:via-card dark:to-primary/[0.04]">
      {/* Subtle decorative washes */}
      <div className="absolute -top-16 -right-16 h-40 w-40 rounded-full bg-primary/5 blur-2xl pointer-events-none" />
      <div className="absolute -bottom-16 -left-16 h-32 w-32 rounded-full bg-primary/5 blur-xl pointer-events-none" />

      <div className="relative z-10 p-6 md:p-7">
        <div className="flex flex-col gap-5">
          {/* Top row: greeting + date */}
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-muted-foreground">Welcome back</span>
              </div>
              <h2 className="text-2xl md:text-[26px] font-semibold tracking-tight text-foreground">
                {greeting}, <span className="text-primary">{user?.name?.split(' ')[0] || 'Admin'}</span>
              </h2>
              <p className="text-muted-foreground text-sm mt-1">{date}</p>
              <p className="text-muted-foreground/70 text-xs mt-0.5">{motivational}</p>
            </div>
            <div className="flex items-center gap-2.5 text-xs">
              <div className="flex items-center gap-1.5 bg-muted/80 border border-border rounded-full px-3 py-1.5 text-foreground">
                <div className="h-2 w-2 rounded-full bg-primary" />
                <span className="font-medium">{activeEmployees} active employees</span>
              </div>
              <div className="flex items-center gap-1.5 bg-muted/80 border border-border rounded-full px-3 py-1.5 text-foreground">
                <div className="h-2 w-2 rounded-full bg-info" />
                <span className="font-medium">{onlineDevices} online devices</span>
              </div>
            </div>
          </div>

          {/* Quick actions */}
          <div className="flex flex-wrap gap-2">
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <Button
                  key={action.page}
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs font-medium border-border bg-card/60 hover:bg-muted text-foreground"
                  onClick={() => setCurrentPage(action.page)}
                >
                  <Icon className="w-3.5 h-3.5 mr-1.5 text-primary" />
                  {action.label}
                </Button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
