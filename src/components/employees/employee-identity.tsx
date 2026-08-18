'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PresenceDot } from '@/components/ui/presence-dot';
import { cn } from '@/lib/utils';

// Shared employee identity cell: avatar + live presence dot + name.
//
// Any future employee-name surface should render through this component so it
// automatically inherits the global presence indicator. The dot is rendered
// only when the employee is identifiable by id; layout stays identical to the
// old avatar+name cells (dot adds no width when offline/grey).

export interface EmployeeIdentityEmployee {
  id: string;
  firstName: string;
  lastName: string;
  avatar?: string | null;
}

interface EmployeeIdentityProps {
  employee: EmployeeIdentityEmployee;
  /** Avatar size class (default h-7 w-7). */
  avatarClassName?: string;
  showAvatar?: boolean;
  className?: string;
  nameClassName?: string;
  dotClassName?: string;
  title?: string;
}

export function EmployeeIdentity({
  employee,
  avatarClassName,
  showAvatar = true,
  className,
  nameClassName,
  dotClassName,
  title,
}: EmployeeIdentityProps) {
  const initials = `${employee.firstName?.[0] ?? ''}${employee.lastName?.[0] ?? ''}`.toUpperCase();

  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      {showAvatar && (
        <Avatar className={cn('h-7 w-7 shrink-0', avatarClassName)}>
          {employee.avatar && (
            <AvatarImage
              src={employee.avatar}
              alt={`${employee.firstName} ${employee.lastName}`}
            />
          )}
          <AvatarFallback className="bg-muted text-foreground font-semibold text-[10px]">
            {initials}
          </AvatarFallback>
        </Avatar>
      )}
      <PresenceDot employeeId={employee.id} className={dotClassName} title={title} />
      <span className={cn('truncate', nameClassName)}>
        {employee.firstName} {employee.lastName}
      </span>
    </div>
  );
}
