'use client';

import { useState, useMemo, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, KeyRound, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthFetch } from '@/hooks/use-auth-fetch';
import { toast } from 'sonner';

type StrengthLevel = 'weak' | 'medium' | 'strong';

interface StrengthResult {
  level: StrengthLevel;
  score: number;
  checks: {
    minLength: boolean;
    hasUpper: boolean;
    hasLower: boolean;
    hasDigit: boolean;
    hasSpecial: boolean;
  };
}

function evaluateStrength(password: string): StrengthResult {
  const checks = {
    minLength: password.length >= 8,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasDigit: /\d/.test(password),
    hasSpecial: /[^A-Za-z0-9]/.test(password),
  };

  const score = Object.values(checks).filter(Boolean).length;

  let level: StrengthLevel = 'weak';
  if (score >= 4) level = 'strong';
  else if (score >= 3) level = 'medium';

  return { level, score, checks };
}

const strengthConfig: Record<StrengthLevel, { label: string; color: string; barColor: string; bgColor: string }> = {
  weak: { label: 'Weak', color: 'text-red-600', barColor: 'bg-red-500', bgColor: 'bg-red-100' },
  medium: { label: 'Medium', color: 'text-amber-600', barColor: 'bg-amber-500', bgColor: 'bg-amber-100' },
  strong: { label: 'Strong', color: 'text-emerald-600', barColor: 'bg-emerald-500', bgColor: 'bg-emerald-100' },
};

const checkItems = [
  { key: 'minLength' as const, label: 'At least 8 characters' },
  { key: 'hasUpper' as const, label: 'Uppercase letter' },
  { key: 'hasLower' as const, label: 'Lowercase letter' },
  { key: 'hasDigit' as const, label: 'Number' },
  { key: 'hasSpecial' as const, label: 'Special character' },
];

function PasswordField({
  id,
  label,
  value,
  onChange,
  showPassword,
  onTogglePassword,
  placeholder,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={showPassword ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="pr-10"
          autoFocus={autoFocus}
        />
        <button
          type="button"
          onClick={onTogglePassword}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          tabIndex={-1}
          aria-label={showPassword ? 'Hide password' : 'Show password'}
        >
          {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </div>
  );
}

export function ChangePasswordDialog({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const authFetch = useAuthFetch();

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

  const resetForm = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowCurrent(false);
    setShowNew(false);
    setShowConfirm(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      resetForm();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isValid || isSubmitting) return;

    setIsSubmitting(true);

    try {
      await authFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });

      toast.success('Password changed successfully');
      handleOpenChange(false);
    } catch (err: unknown) {
      const message =
        (err as { error?: string })?.error ||
        (err as Error)?.message ||
        'Failed to change password';
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const strengthCfg = strengthConfig[strength.level];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-primary" />
            Change Password
          </DialogTitle>
        </DialogHeader>

        <motion.form
          onSubmit={handleSubmit}
          className="space-y-5"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Current Password */}
          <PasswordField
            id="current-password"
            label="Current Password"
            value={currentPassword}
            onChange={setCurrentPassword}
            showPassword={showCurrent}
            onTogglePassword={() => setShowCurrent((v) => !v)}
            placeholder="Enter current password"
            autoFocus
          />

          {/* New Password */}
          <div className="space-y-2">
            <PasswordField
              id="new-password"
              label="New Password"
              value={newPassword}
              onChange={setNewPassword}
              showPassword={showNew}
              onTogglePassword={() => setShowNew((v) => !v)}
              placeholder="Enter new password"
            />

            {/* Strength Indicator */}
            <AnimatePresence>
              {newPassword.length > 0 && (
                <motion.div
                  className="space-y-2"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {/* Bar */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 flex gap-1">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <div
                          key={i}
                          className="h-1.5 flex-1 rounded-full transition-colors duration-200"
                          style={{
                            backgroundColor:
                              i <= strength.score
                                ? strengthCfg.barColor
                                : 'oklch(0.92 0.005 250)',
                          }}
                        />
                      ))}
                    </div>
                    <span className={`text-xs font-medium ${strengthCfg.color}`}>
                      {strengthCfg.label}
                    </span>
                  </div>

                  {/* Requirements checklist */}
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
                            strength.checks[key]
                              ? 'text-emerald-600'
                              : 'text-muted-foreground'
                          }
                        >
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Confirm Password */}
          <div className="space-y-2">
            <PasswordField
              id="confirm-password"
              label="Confirm New Password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              showPassword={showConfirm}
              onTogglePassword={() => setShowConfirm((v) => !v)}
              placeholder="Confirm new password"
            />
            <AnimatePresence>
              {passwordsMismatch && (
                <motion.p
                  className="text-xs text-red-500 flex items-center gap-1"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                >
                  <XCircle className="size-3" />
                  Passwords do not match
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isValid || isSubmitting}
              className="min-w-[120px]"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Changing…
                </>
              ) : (
                'Change Password'
              )}
            </Button>
          </DialogFooter>
        </motion.form>
      </DialogContent>
    </Dialog>
  );
}
