'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { AgentAccountDialog } from './agent-account-dialog';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Key,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Lock,
  Clock,
  Plus,
  RotateCcw,
} from 'lucide-react';

interface AccountData {
  id: string;
  agentId: string;
  status: string;
  lastLoginAt: string | null;
  failedLoginCount: number;
  lockedUntil: string | null;
  passwordChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  employeeId: string;
}

/**
 * Query result carrying an explicit error classification so a permission
 * failure (403) can NEVER masquerade as "no account" (which would render a
 * misleading Create/Setup button for a manager/viewer).
 */
type AccountQuery =
  | { kind: 'ok'; data: AccountData | null }
  | { kind: 'permission' }
  | { kind: 'error' };

const statusConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  active: { label: 'Active', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300', icon: CheckCircle2 },
  disabled: { label: 'Disabled', color: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300', icon: XCircle },
  locked: { label: 'Locked', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300', icon: Lock },
};

function getStatus(acct: AccountData | null): { label: string; color: string; icon: typeof CheckCircle2 } {
  if (!acct) return { label: 'Not Created', color: 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400', icon: XCircle };
  if (acct.lockedUntil && new Date(acct.lockedUntil) > new Date()) {
    return { label: 'Locked', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300', icon: Lock };
  }
  return statusConfig[acct.status] || { label: acct.status, color: 'bg-gray-100 text-gray-600', icon: XCircle };
}

export function AgentAccountCard({ employeeId }: Props) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<'create' | 'reset' | 'setup' | null>(null);

  const { data, isLoading } = useQuery<AccountQuery>({
    queryKey: ['agent-account', employeeId],
    queryFn: async () => {
      const res = await fetch(`/api/employees/${employeeId}/agent-account`);
      // 403 — the session role cannot manage agent accounts (manager/viewer).
      // Distinct state: never show Create/Setup, which would 403 on submit.
      if (res.status === 403) return { kind: 'permission' };
      // 404 / no account row → legitimate "no account" state.
      if (res.status === 404) return { kind: 'ok', data: null };
      if (!res.ok) return { kind: 'error' };
      const json = (await res.json()) as { data: AccountData | null };
      return { kind: 'ok', data: json.data };
    },
  });

  const acct = data?.kind === 'ok' ? data.data : null;
  const permissionDenied = data?.kind === 'permission';
  const loadFailed = data?.kind === 'error';

  // Migrated placeholder account: the backfill migration created one AgentAccount
  // per employee (disabled, passwordChangedAt null, placeholder hash) — the
  // "create" condition (acct == null) is never true for migrated employees.
  // A disabled account with no configured password is a placeholder awaiting
  // first-time setup, NOT a deliberately disabled account.
  const isPlaceholder = !!acct && acct.status === 'disabled' && acct.passwordChangedAt === null;

  const status = getStatus(acct);
  const StatusIcon = status.icon;
  const isLocked = status.label === 'Locked';

  const handleMutate = async () => {
    qc.invalidateQueries({ queryKey: ['agent-account', employeeId] });
  };

  const handleToggle = async () => {
    if (!acct) return;
    const newStatus = acct.status === 'active' ? 'disabled' : 'active';
    try {
      const res = await fetch(`/api/employees/${employeeId}/agent-account`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      toast.success(newStatus === 'active' ? 'Agent account enabled' : 'Agent account disabled');
      handleMutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update');
    }
  };

  return (
    <>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4 text-primary" />
              <CardTitle className="text-sm font-medium">Agent Account</CardTitle>
            </div>
            {isLoading ? (
              <div className="h-5 w-16 rounded bg-muted animate-pulse" />
            ) : !permissionDenied && !loadFailed ? (
              <Badge className={`${status.color} gap-1`} variant="outline">
                <StatusIcon className="w-3 h-3" />
                {status.label}
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <div className="h-4 w-48 rounded bg-muted/50 animate-pulse" />
              <div className="h-3 w-32 rounded bg-muted/30 animate-pulse" />
            </div>
          ) : permissionDenied ? (
            <p className="text-sm text-muted-foreground">
              You don&apos;t have permission to manage agent accounts.
            </p>
          ) : loadFailed ? (
            <p className="text-sm text-muted-foreground">
              Failed to load agent account information.
            </p>
          ) : isPlaceholder ? (
            // Migrated placeholder (disabled, no password configured): the ONLY
            // action is first-time setup — a single dialog that sets the
            // password AND activates the account (reset-password endpoint).
            // Generic "Enable Account" is deliberately hidden here because a
            // placeholder has no usable credential to enable.
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground min-w-[100px]">Agent ID</span>
                <span className="font-mono font-medium">{acct.agentId}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                This employee does not have an active Agent Account yet.
              </p>
              <Button size="sm" onClick={() => setDialog('setup')}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                Set up Agent Account
              </Button>
            </div>
          ) : acct ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground min-w-[100px]">Agent ID</span>
                <span className="font-mono font-medium">{acct.agentId}</span>
              </div>
              {acct.lastLoginAt && (
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Last login</span>
                  <span>{formatDistanceToNow(new Date(acct.lastLoginAt), { addSuffix: true })}</span>
                </div>
              )}
              {acct.passwordChangedAt && (
                <div className="flex items-center gap-2 text-sm">
                  <RotateCcw className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Password last changed</span>
                  <span>{formatDistanceToNow(new Date(acct.passwordChangedAt), { addSuffix: true })}</span>
                </div>
              )}
              {isLocked && (
                <div className="flex items-center gap-2 text-sm text-orange-600 dark:text-orange-400">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>
                    Locked until{' '}
                    {acct!.lockedUntil
                      ? format(new Date(acct!.lockedUntil), 'MMM dd, HH:mm')
                      : 'Unknown'}
                  </span>
                  <span className="text-muted-foreground">
                    ({acct!.failedLoginCount} failed attempts)
                  </span>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDialog('reset')}
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1" />
                  Reset Password
                </Button>
                <Button
                  size="sm"
                  variant={acct.status === 'active' ? 'destructive' : 'default'}
                  onClick={handleToggle}
                >
                  {acct.status === 'active' ? 'Disable Account' : 'Enable Account'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This employee does not have an agent account yet. Create one to enable
                agent authentication.
              </p>
              <Button size="sm" onClick={() => setDialog('create')}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                Create Agent Account
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AgentAccountDialog
        open={dialog !== null}
        mode={dialog ?? 'create'}
        onOpenChange={() => setDialog(null)}
        employeeId={employeeId}
        employeeName=""
        agentId={acct?.agentId}
        onSaved={handleMutate}
      />
    </>
  );
}