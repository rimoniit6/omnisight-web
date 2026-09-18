// OmniSight — Demo-First Experience: deterministic fixture data.
//
// Pure data + pure helpers (no DB, no fs) so the seeder/simulator stay
// testable and values are stable across resets. All identities are clearly
// fictional: reserved example.com emails, fictional names, fictional Dhaka
// area coordinates, synthetic window titles. NO real customer/person data.

// ─── Deterministic PRNG (mulberry32) — reproducible sequences ──────────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of a string into a 31-bit int (for per-entity seeds). */
export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

// ─── Departments (3) ───────────────────────────────────────────────────────
export const DEMO_DEPARTMENTS = ['Engineering', 'Design', 'Operations'] as const;

// ─── Employees (8, clearly fictional) ──────────────────────────────────────
export interface DemoEmployeeFixture {
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  designation: string;
  department: (typeof DEMO_DEPARTMENTS)[number];
  avatarHue: number;
}

const PEOPLE: Array<[string, string, (typeof DEMO_DEPARTMENTS)[number], string]> = [
  ['Rimon', 'Ahmed', 'Engineering', 'Senior Backend Engineer'],
  ['Nabila', 'Rahman', 'Design', 'Product Designer'],
  ['Tanvir', 'Hasan', 'Engineering', 'Frontend Engineer'],
  ['Sadia', 'Karim', 'Engineering', 'QA Engineer'],
  ['Rafi', 'Chowdhury', 'Operations', 'Operations Analyst'],
  ['Maliha', 'Sultana', 'Design', 'UX Researcher'],
  ['Imran', 'Kabir', 'Engineering', 'DevOps Engineer'],
  ['Farhana', 'Akter', 'Operations', 'Support Lead'],
];

export const DEMO_EMPLOYEES: DemoEmployeeFixture[] = PEOPLE.map(([first, last, dept, role], i) => ({
  employeeId: `DEMO-${String(i + 1).padStart(3, '0')}`,
  firstName: first,
  lastName: last,
  email: `${first.toLowerCase()}.${last.toLowerCase()}@demo.example.com`,
  designation: role,
  department: dept,
  avatarHue: (i * 47) % 360,
}));

// ─── Devices (one per employee, one shared spare) ──────────────────────────
export interface DemoDeviceFixture {
  name: string;
  hostname: string;
  operatingSystem: string;
  osVersion: string;
  employeeCode: string | null; // null → unassigned spare
}

export const DEMO_DEVICES: DemoDeviceFixture[] = [
  ...DEMO_EMPLOYEES.map((e) => ({
    name: `${e.firstName}-Workstation`,
    hostname: `DEMO-${e.employeeId}-WS`,
    operatingSystem: 'Windows 11 Pro',
    osVersion: '10.0.22631',
    employeeCode: e.employeeId,
  })),
  {
    name: 'Demo-Laptop-Spare',
    hostname: 'DEMO-SPARE-01',
    operatingSystem: 'Windows 11 Pro',
    osVersion: '10.0.22631',
    employeeCode: null,
  },
];

// ─── Activity vocabulary (synthetic window titles / domains) ───────────────
export const DEMO_APPS = {
  productive: [
    { title: 'VS Code — omnisight-web', app: 'VS Code' },
    { title: 'VS Code — infra-terraform', app: 'VS Code' },
    { title: 'IntelliJ IDEA — billing-service', app: 'IntelliJ IDEA' },
    { title: 'Figma — Dashboard Redesign', app: 'Figma' },
    { title: 'Excel — Q3 Metrics.xlsx', app: 'Excel' },
  ],
  neutral: [
    { title: 'Slack — #engineering', app: 'Slack' },
    { title: 'Slack — #general', app: 'Slack' },
    { title: 'Teams — Weekly Sync', app: 'Teams' },
    { title: 'Outlook — Inbox', app: 'Outlook' },
    { title: 'Notion — Team Wiki', app: 'Notion' },
  ],
  unproductive: [
    { title: 'Steam', app: 'Steam' },
    { title: 'YouTube — Watch', app: 'Chrome' },
    { title: 'Twitter / X — Feed', app: 'Chrome' },
  ],
} as const;

export const DEMO_SITES = {
  productive: [
    { title: 'GitHub — omnisight/omnisight-web', url: 'https://github.com' },
    { title: 'Stack Overflow — Question', url: 'https://stackoverflow.com' },
    { title: 'MDN Web Docs', url: 'https://developer.mozilla.org' },
  ],
  neutral: [
    { title: 'Google Search', url: 'https://google.com' },
    { title: 'Wikipedia — Article', url: 'https://wikipedia.org' },
  ],
  unproductive: [
    { title: 'Reddit — r/gaming', url: 'https://reddit.com' },
    { title: 'Netflix — Browse', url: 'https://netflix.com' },
  ],
} as const;

// ─── Synthetic screenshot scenes (drawn onto generated PNGs) ────────────────
export interface DemoScreenshotScene {
  title: string;
  hue: number;
  lines: string[];
}

export const DEMO_SCREENSHOT_SCENES: DemoScreenshotScene[] = [
  { title: 'VS Code', hue: 210, lines: ['src/lib/demo/simulator.ts', 'npm run dev', '— omnisight-web'] },
  { title: 'Figma', hue: 280, lines: ['Dashboard / Overview', 'Auto layout', 'Frame 42'] },
  { title: 'Slack', hue: 160, lines: ['#engineering', 'Build green ✓', 'deploy @ 14:05'] },
  { title: 'Excel', hue: 30, lines: ['Q3-Metrics.xlsx', '=SUM(B2:B31)', 'Sheet1'] },
  { title: 'Chrome', hue: 190, lines: ['GitHub', 'omnisight/omnisight-web', 'Pull requests'] },
  { title: 'Notion', hue: 250, lines: ['Team Wiki', 'Roadmap — Q3', 'Getting started'] },
];

// ─── Fictional Dhaka-area coordinates (clearly simulated, no real persons) ──
export const DEMO_LOCATIONS = [
  { lat: 23.7806, lng: 90.4074, label: 'Gulshan (simulated)' },
  { lat: 23.7509, lng: 90.3934, label: 'Dhanmondi (simulated)' },
  { lat: 23.8103, lng: 90.4125, label: 'Banani (simulated)' },
  { lat: 23.7925, lng: 90.4043, label: 'Mohakhali (simulated)' },
] as const;

// ─── Alerts ────────────────────────────────────────────────────────────────
export const DEMO_ALERTS = [
  { title: 'Off-hours activity detected', type: 'security', severity: 'warning', description: 'Simulated activity outside working hours on DEMO-001-WS.' },
  { title: 'High inactivity', type: 'high_inactivity', severity: 'info', description: 'Simulated idle period exceeded threshold for DEMO-005.' },
  { title: 'Policy violation (simulated)', type: 'policy_violation', severity: 'error', description: 'Restricted application access attempt on DEMO-003-WS.' },
] as const;

// ─── Projects (3) + time-entry categories ──────────────────────────────────
export const DEMO_PROJECTS = [
  { name: 'Demo Platform Migration', color: '#10b981', priority: 'high', status: 'active' },
  { name: 'Demo Mobile App', color: '#3b82f6', priority: 'medium', status: 'active' },
  { name: 'Demo Internal Tooling', color: '#f59e0b', priority: 'low', status: 'on_hold' },
] as const;

export const TIME_ENTRY_CATEGORIES = ['development', 'design', 'testing', 'review', 'meeting'] as const;

// ─── Work-pattern helpers ──────────────────────────────────────────────────
export const WORK_START_MINUTES = 9 * 60; // 09:00 local
export const WORK_END_MINUTES = 18 * 60; // 18:00 local

/** YYYY-MM-DD in Asia/Dhaka (+06, no DST) for a UTC instant. */
export function dhakaDayKey(d: Date): string {
  const dhaka = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  return dhaka.toISOString().slice(0, 10);
}

/** UTC instant for a Dhaka local wall-clock on a given day key. */
export function dhakaInstant(dayKey: string, minutes: number): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  // Dhaka local time = UTC+6 → UTC minutes = local minutes - 360.
  return new Date(Date.UTC(y, m - 1, d, 0, minutes - 360));
}

/** Friday/Saturday weekend (Bangladesh). */
export function isDhakaWeekend(dayKey: string): boolean {
  const dow = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
  return dow === 5 || dow === 6;
}
