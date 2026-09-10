'use client';

import { useAppStore, useAuthStore, type PageType } from '@/lib/store';
import { useCurrentUser } from '@/hooks/use-current-user';
import { visibleGroupsFor } from '@/lib/sidebar-nav';
import { useEffectiveBranding } from '@/hooks/use-effective-branding';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import Image from 'next/image';
import { SheetTitle } from '@/components/ui/sheet';



interface MobileSidebarContentProps {
  onNavigate: () => void;
}

export function MobileSidebarContent({ onNavigate }: MobileSidebarContentProps) {
  const router = useRouter();
  const { currentPage, setCurrentPage } = useAppStore();
  const { user } = useCurrentUser();
  const authUser = useAuthStore((s) => s.user);
  const organization = useAuthStore((s) => s.organization);
  const displayUser = user || authUser;
  const branding = useEffectiveBranding();

  // S-2: role-aware navigation (mirrors the desktop sidebar).
  // Platform rule: an org-less super_admin sees ONLY the Control Center.
  const role = displayUser?.role ?? null;
  const visibleGroups = visibleGroupsFor(role, Boolean(organization));

  const handleNavClick = (page: PageType, href?: string) => {
    if (href) {
      router.push(href);
    } else {
      setCurrentPage(page);
      onNavigate();
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-background">
      <SheetTitle className="sr-only">Navigation Menu</SheetTitle>

      {/* Logo area */}
      <div className="flex items-center h-16 px-4 border-b border-border">
        <div className="flex items-center gap-3">
          {branding.logoType === 'svg' && branding.logoSvg ? (
            <div
              style={{
                width: branding.logoWidth && branding.logoWidth > 0 ? branding.logoWidth : 48,
                height: branding.logoHeight && branding.logoHeight > 0 ? branding.logoHeight : 48,
              }}
              dangerouslySetInnerHTML={{ __html: branding.logoSvg }}
              className="shrink-0 flex items-center justify-center"
            />
          ) : (
            <Image src={branding.logoUrl} alt={branding.brandName} width={48} height={48} className="object-contain shrink-0" unoptimized />
          )}
          <span className="font-semibold text-lg">{branding.brandName}</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {visibleGroups.map((group, gi) => (            <div key={group.id}>
            {gi > 0 && <div className="my-2 mx-3 h-px bg-border" />}
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 px-3 mb-1.5">
              {group.section}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = currentPage === item.page;
                return (
                  <button
                    key={item.page}
                    onClick={() => handleNavClick(item.page, item.href)}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-primary/8 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    <Icon className="w-[18px] h-[18px] shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* User info block — from database */}
      {displayUser && (
      <div className="px-3 py-3 border-t border-border">
        <div className="flex items-center gap-3 px-2 py-1">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarFallback className="text-[10px] bg-muted text-muted-foreground font-medium">
              {displayUser.initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{displayUser.name}</p>
            <p className="text-[11px] text-muted-foreground truncate">{displayUser.roleLabel}</p>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
