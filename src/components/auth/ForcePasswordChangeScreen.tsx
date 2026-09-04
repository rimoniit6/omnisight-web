'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Eye, EyeOff, KeyRound, Loader2, CheckCircle2, XCircle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/lib/store';
import { toast } from 'sonner';

type StrengthLevel = 'weak' | 'medium' | 'strong';

const checkItems: { key: keyof Checks; label: string }[] = [
  { key: 'minLength', label: 'At least 8 characters' },
  { key: 'hasUpper', label: 'Uppercase letter' },
  { key: 'hasLower', label: 'Lowercase letter' },
  { key: 'hasDigit', label: 'Number' },
  { key: 'hasSpecial', label: 'Special character' },
];

interface Checks {
  minLength: boolean;
  hasUpper: boolean;
  hasLower: boolean;
  hasDigit: boolean;
  hasSpecial: boolean;
}

function evaluateStrength(password: string): { level: StrengthLevel; checks: Checks } {
  const checks: Checks = {
    minLength: password.length >= 8,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasDigit: /\d/.test(password),
    hasSpecial: /[^A-Za-z0-9]/.test(password),
  };
  const score = Object.values(checks).filter(Boolean).length;
  const level: StrengthLevel = score >= 4 ? 'strong' : score >= 3 ? 'medium' : 'weak';
  return { level, checks };
}

const LEVEL_STYLE: Record<StrengthLevel, { label: string; bar: string }> = {
  weak: { label: 'Weak', bar: 'bg-red-500' },
  medium: { label: 'Medium', bar: 'bg-amber-500' },
  strong: { label: 'Strong', bar: 'bg-emerald-500' },
};

export function ForcePasswordChangeScreen() {
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const strength = useMemo(() => evaluateStrength(newPassword), [newPassword]);
  const passwordsMatch = newPassword.length > 0 && newPassword === confirmPassword;
  const passwordsMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  const isValid =
    currentPassword.length > 0 &&
    strength.level !== 'weak' &&
    strength.checks.minLength &&
    strength.checks.hasUpper &&
    strength.checks.hasLower &&
    strength.checks.hasDigit &&
    strength.checks.hasSpecial &&
    passwordsMatch;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to change password');
        return;
      }
      // First-login gate cleared — the AuthGuard now renders the app.
      updateUser({ mustChangePassword: false });
      toast.success('Password updated. Welcome to OmniSight!');
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-muted/40">
      <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-primary/5 blur-[80px] pointer-events-none" />
      <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-primary/5 blur-[80px] pointer-events-none" />

      <div className="relative z-10 w-full max-w-md px-4">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="bg-card border border-border rounded-xl shadow-sm p-6"
        >
          <div className="mb-5 text-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <KeyRound className="size-6" />
            </span>
            <h1 className="mt-3 text-xl font-semibold tracking-tight text-foreground">
              Set a New Password
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Your OmniSight account was provisioned with a temporary password.
              For security, set a new password before continuing,{' '}
              <span className="font-medium text-foreground">{user?.email}</span>.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <span>You cannot access the dashboard until this is done.</span>
            </div>

            <div className="space-y-2">
              <Label htmlFor="force-current-password">Current Password</Label>
              <div className="relative">
                <Input
                  id="force-current-password"
                  type={showCurrent ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Temporary password"
                  autoFocus
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  onClick={() => setShowCurrent((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                  aria-label={showCurrent ? 'Hide current password' : 'Show current password'}
                >
                  {showCurrent ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="force-new-password">New Password</Label>
              <div className="relative">
                <Input
                  id="force-new-password"
                  type={showNew ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                  aria-label={showNew ? 'Hide new password' : 'Show new password'}
                >
                  {showNew ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>

              {newPassword.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 flex gap-1">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <div
                          key={i}
                          className="h-1.5 flex-1 rounded-full transition-colors duration-200"
                          style={{
                            backgroundColor:
                              i <= Object.values(strength.checks).filter(Boolean).length
                                ? LEVEL_STYLE[strength.level].bar
                                : 'oklch(0.92 0.005 250)',
                          }}
                        />
                      ))}
                    </div>
                    <span
                      className={`text-xs font-medium ${
                        strength.level === 'strong'
                          ? 'text-emerald-600'
                          : strength.level === 'medium'
                          ? 'text-amber-600'
                          : 'text-red-500'
                      }`}
                    >
                      {LEVEL_STYLE[strength.level].label}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    {checkItems.map(({ key, label }) => (
                      <div key={key} className="flex items-center gap-1.5 text-xs">
                        {strength.checks[key] ? (
                          <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
                        ) : (
                          <XCircle className="size-3.5 text-muted-foreground/50 shrink-0" />
                        )}
                        <span
                          className={
                            strength.checks[key] ? 'text-emerald-600' : 'text-muted-foreground'
                          }
                        >
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="force-confirm-password">Confirm New Password</Label>
              <div className="relative">
                <Input
                  id="force-confirm-password"
                  type={showConfirm ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                  aria-label={showConfirm ? 'Hide confirmation' : 'Show confirmation'}
                >
                  {showConfirm ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {passwordsMismatch && (
                <p className="text-xs text-red-500 flex items-center gap-1">
                  <XCircle className="size-3" /> Passwords do not match
                </p>
              )}
            </div>

            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={!isValid || isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Updating…
                </>
              ) : (
                'Continue to Dashboard'
              )}
            </Button>
          </form>
        </motion.div>
      </div>
    </div>
  );
}
