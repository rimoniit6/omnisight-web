// Pure formatting / display helpers for the Projects feature.
// Extracted from projects-page.tsx so the page stays focused on data & layout.

export function formatHours(h: number): string {
  return `${h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)}h`;
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function getDaysLeft(deadline: string | null): string {
  if (!deadline) return 'No deadline';
  const now = new Date();
  const due = new Date(deadline);
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return `${Math.abs(diffDays)} days overdue`;
  if (diffDays === 0) return 'Due today';
  if (diffDays === 1) return '1 day left';
  return `${diffDays} days left`;
}

export function isOverdue(deadline: string | null): boolean {
  if (!deadline) return false;
  return new Date(deadline) < new Date();
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
    case 'on_hold':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
    case 'completed':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
    case 'cancelled':
      return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300';
  }
}

export function getStatusLabel(status: string): string {
  switch (status) {
    case 'on_hold': return 'On Hold';
    default: return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'critical':
      return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 border-rose-200 dark:border-rose-800';
    case 'high':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 border-orange-200 dark:border-orange-800';
    case 'medium':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800';
    case 'low':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300 border-sky-200 dark:border-sky-800';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300';
  }
}

export function getProgressColor(pct: number): string {
  if (pct > 75) return 'bg-emerald-500';
  if (pct > 40) return 'bg-amber-500';
  return 'bg-rose-500';
}

export function getInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

const AVATAR_COLORS = [
  'bg-emerald-500', 'bg-teal-500', 'bg-sky-500', 'bg-violet-500',
  'bg-amber-500', 'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500',
];

export function getAvatarColor(index: number): string {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}
