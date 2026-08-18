'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Key, Eye, EyeOff } from 'lucide-react';

interface Props {
  open: boolean;
  mode: 'create' | 'reset' | 'setup';
  onOpenChange: (open: boolean) => void;
  employeeId: string;
  employeeName: string;
  /** Read-only Agent ID shown in setup mode so the admin can confirm it. */
  agentId?: string;
  onSaved: () => void;
}

export function AgentAccountDialog({ open, mode, onOpenChange, employeeId, agentId, onSaved }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);

  // Reset form when the dialog closes. This uses React's documented
  // "adjusting state when a prop changes" pattern (setState during render for
  // the previous-value comparison) instead of an effect, so closing the dialog
  // never leaks a stale password into a future session.
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (!open) {
      setPassword('');
      setConfirm('');
      setSaving(false);
      setShowPassword(false);
    }
  }

  const handleSave = async () => {
    if (!password) {
      toast.error('Password is required');
      return;
    }
    if (password !== confirm) {
      toast.error('Passwords do not match');
      return;
    }
    if (password.length < 12) {
      toast.error('Password must be at least 12 characters');
      return;
    }
    if (!/[A-Z]/.test(password)) {
      toast.error('Password must contain an uppercase letter');
      return;
    }
    if (!/[a-z]/.test(password)) {
      toast.error('Password must contain a lowercase letter');
      return;
    }
    if (!/\d/.test(password)) {
      toast.error('Password must contain a number');
      return;
    }

    setSaving(true);
    try {
      // create → POST /agent-account (no row yet); reset/setup → POST
      // /reset-password (row exists — POST would 409). Setup activates the
      // migrated placeholder account via the same reset endpoint.
      const url =
        mode === 'create'
          ? `/api/employees/${employeeId}/agent-account`
          : `/api/employees/${employeeId}/agent-account/reset-password`;
      const method = 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to save');
      }
      toast.success(
        mode === 'create' ? 'Agent account created' : mode === 'setup' ? 'Agent account set up' : 'Password reset'
      );
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Key className="w-5 h-5 text-primary" />
            <DialogTitle>
              {mode === 'create' ? 'Create Agent Account' : mode === 'setup' ? 'Set up Agent Account' : 'Reset Agent Password'}
            </DialogTitle>
          </div>
          <DialogDescription>
            {mode === 'create'
              ? 'Set the initial password for this employee\'s agent account.'
              : mode === 'setup'
                ? 'Set the first password for this migrated agent account — it will be activated on save.'
                : 'Generate a new password for this employee\'s agent account.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {mode === 'setup' && (
            <div className="grid gap-2">
              <Label htmlFor="agent-id">Agent ID</Label>
              <Input id="agent-id" value={agentId ?? ''} readOnly />
              <p className="text-[11px] text-muted-foreground">
                The Agent ID is derived from the employee record and cannot be changed here.
              </p>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="password">New Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 12 characters"
                className="pr-10"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              At least 12 characters, with uppercase, lowercase, and a number
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm">Confirm Password</Label>
            <Input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter the password"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">
            {saving
              ? 'Saving...'
              : mode === 'create'
                ? 'Create Account'
                : mode === 'setup'
                  ? 'Set up Account'
                  : 'Reset Password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}