import { create } from 'zustand';

export type PageType =
  | 'dashboard'
  | 'employees'
  | 'employee-details'
  | 'departments'
  | 'devices'
  | 'activities'
  | 'analytics'
  | 'insights'
  | 'ai-provider'
  | 'notifications'
  | 'alerts'
  | 'audit'
  | 'settings'
  | 'reports'
  | 'organization'
  | 'agent-approvals'
  | 'guests'
  | 'screenshots'
  | 'break-status'
  | 'live-monitor'
  | 'daily-report'
  | 'security'
  | 'policies'
  | 'anomalies'
  | 'consent'
  | 'self-portal'
  | 'projects'
  | 'sentiment';

function getInitialTourState(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem('worklens-tour-completed') === 'true';
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  initials: string;
  avatar: string | null;
  lastLogin: string;
}

export interface AuthOrg {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  logo: string | null;
  status: string;
  timezone: string;
  currency: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  organization: AuthOrg | null;
  isAuthenticated: boolean;
  _hydrated: boolean;
  login: (token: string, user: AuthUser, organization: AuthOrg | null) => void;
  logout: () => void;
  updateUser: (user: Partial<AuthUser>) => void;
  hydrate: () => Promise<void>;
}

/**
 * Auth store — SECURITY: the JWT is held in memory ONLY.
 *
 * Never persisted to localStorage/sessionStorage. The httpOnly session
 * cookie (set by the server) is the durable credential: on reload,
 * hydrate() restores the user/organization from /api/auth/me and mints a
 * fresh in-memory token via /api/auth/refresh-token. This keeps the token
 * out of XSS reach while preserving the same-origin API calls.
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  organization: null,
  isAuthenticated: false,
  _hydrated: false,

  hydrate: async () => {
    try {
      const meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (meRes.ok) {
        const data = await meRes.json();
        set({
          user: data.user,
          organization: data.organization,
          isAuthenticated: true,
          _hydrated: true,
        });
        // Mint an in-memory token from the cookie session (sliding renewal).
        // Failure here is non-fatal — API calls still authenticate via cookie.
        try {
          const refreshRes = await fetch('/api/auth/refresh-token', {
            method: 'POST',
            credentials: 'same-origin',
          });
          if (refreshRes.ok) {
            const refreshed = await refreshRes.json();
            if (refreshed.token) {
              set({
                token: refreshed.token,
                user: refreshed.user || data.user,
                organization: refreshed.user ? get().organization : data.organization,
              });
            }
          }
        } catch {
          /* ignore refresh failure — cookie still authenticates */
        }
        return;
      }
    } catch {
      // Network/offline — treat as unauthenticated rather than crashing.
    }
    set({ isAuthenticated: false, _hydrated: true });
  },

  login: (token, user, organization) => {
    set({ token, user, organization, isAuthenticated: true, _hydrated: true });
  },

  logout: () => {
    set({ token: null, user: null, organization: null, isAuthenticated: false, _hydrated: true });
  },

  updateUser: (updates) => {
    const current = get();
    if (current.user) {
      set({ user: { ...current.user, ...updates } });
    }
  },
}));

interface AppState {
  currentPage: PageType;
  setCurrentPage: (page: PageType) => void;
  pageContext: string;
  setPageContext: (ctx: string) => void;
  /** Human-readable label for the current page context (e.g. employee name).
   *  Never the raw internal DB id — falls back to pageContext when unset. */
  pageContextLabel: string;
  setPageContextLabel: (label: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  departmentFilter: string;
  setDepartmentFilter: (dept: string) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedEmployeeId: string | null;
  setSelectedEmployeeId: (id: string | null) => void;
  tourCompleted: boolean;
  setTourCompleted: (v: boolean) => void;
  currentTourStep: number;
  setCurrentTourStep: (n: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentPage: 'dashboard',
  setCurrentPage: (page) => set({ currentPage: page, pageContext: '', pageContextLabel: '' }),
  pageContext: '',
  setPageContext: (ctx) => set({ pageContext: ctx }),
  pageContextLabel: '',
  setPageContextLabel: (label) => set({ pageContextLabel: label }),
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  mobileOpen: false,
  setMobileOpen: (open) => set({ mobileOpen: open }),
  departmentFilter: '',
  setDepartmentFilter: (dept) => set({ departmentFilter: dept }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),
  selectedEmployeeId: null,
  setSelectedEmployeeId: (id) => set({ selectedEmployeeId: id }),
  tourCompleted: getInitialTourState(),
  setTourCompleted: (v) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('worklens-tour-completed', String(v));
    }
    set({ tourCompleted: v });
  },
  currentTourStep: 0,
  setCurrentTourStep: (n) => set({ currentTourStep: n }),
}));
