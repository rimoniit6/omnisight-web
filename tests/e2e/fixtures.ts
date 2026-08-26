/**
 * E2E fixtures — per-role authenticated contexts.
 *
 * Each role logs in exactly ONCE (via the real login form), the authenticated
 * storage state is persisted, and every subsequent test for that role reuses
 * the httpOnly session cookie. This keeps the login rate-limit bucket
 * (10 / 5 min / IP+email) far below its ceiling while still exercising the
 * real UI login path.
 */
import { test as base, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export type Role = 'superAdmin' | 'owner' | 'admin' | 'manager' | 'viewer' | 'betaOwner';

const AUTH_DIR = path.join(__dirname, '.auth');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(AUTH_DIR, 'credentials.json'), 'utf8')
) as {
  credentials: Record<Role, { email: string; password: string }>;
};

export const creds = (role: Role) => MANIFEST.credentials[role];

function stateFile(role: Role): string {
  return path.join(AUTH_DIR, `${role}.state.json`);
}

/** Perform a REAL UI login and persist the resulting cookie jar. */
async function loginAndSaveState(role: Role): Promise<string> {
  const file = stateFile(role);
  if (fs.existsSync(file)) return file;

  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // The unauthenticated app renders the LoginPage.
  const email = page.locator('#email');
  await email.waitFor({ state: 'visible', timeout: 30_000 });
  await email.fill(creds(role).email);
  await page.locator('#password').fill(creds(role).password);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Successful login lands on the dashboard shell.
  await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible({
    timeout: 45_000,
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  // Dismiss the onboarding tour overlay so it does not block sidebar clicks
  // in subsequent test sessions. The tour is gated on localStorage.
  await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));
  await page.getByRole('button', { name: /skip tour/i }).first()
    .click({ timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(500);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await page.context().storageState({ path: file });
  await browser.close();
  return file;
}

type RoleFixtures = Partial<Record<Role, Page>> & { rolePage?: Page };

export const test = base.extend<RoleFixtures>({
  superAdmin: async ({ browser }, use) => use(await roleContext(browser, 'superAdmin')),
  owner: async ({ browser }, use) => use(await roleContext(browser, 'owner')),
  admin: async ({ browser }, use) => use(await roleContext(browser, 'admin')),
  manager: async ({ browser }, use) => use(await roleContext(browser, 'manager')),
  viewer: async ({ browser }, use) => use(await roleContext(browser, 'viewer')),
  betaOwner: async ({ browser }, use) => use(await roleContext(browser, 'betaOwner')),
});

async function roleContext(browser: Browser, role: Role): Promise<Page> {
  const statePath = await loginAndSaveState(role);
  const context = await browser.newContext({ storageState: statePath });
  const page = await context.newPage();
  return page;
}

/** Cookie-authenticated APIRequestContext for a role (storage-state reuse). */
export async function apiAs(
  playwright: typeof import('@playwright/test'),
  role: Role
): Promise<import('@playwright/test').APIRequestContext> {
  const statePath = await loginAndSaveState(role);
  return playwright.request.newContext({ storageState: statePath });
}

/** Ensure a role's persisted session exists; returns the storage-state path. */
export async function ensureRoleState(role: Role): Promise<string> {
  return loginAndSaveState(role);
}

export { expect };

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Dismiss any blocking overlay (onboarding tour, command-palette backdrop,
 * etc.) that sits at z-[100] or higher and intercepts pointer events.
 */
async function dismissBlockingOverlays(page: Page): Promise<void> {
  // Ensure the tour is marked completed in localStorage so it does not reappear.
  await page
    .evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'))
    .catch(() => {});
  // Click the "Skip tour" button if the overlay is currently visible.
  await page
    .getByRole('button', { name: /skip tour/i })
    .first()
    .click({ timeout: 1_500 })
    .catch(() => {});
  // Press Escape to close any command-palette / modal overlay.
  await page.keyboard.press('Escape').catch(() => {});
}

/** Navigate via the sidebar button identified by its aria-label. */
export async function navigate(page: Page, label: string): Promise<void> {
  // Find the sidebar region first, then locate the button by aria-label.
  // Using getByRole on the sidebar region + CSS aria-label selector avoids
  // issues with Radix Tooltip wrappers and CSS transition animations that
  // can make bare getByRole('button', { name }) flake in headless Chromium.
  const sidebar = page.getByRole('complementary', { name: 'Sidebar navigation' });
  await sidebar.waitFor({ state: 'visible', timeout: 15_000 });
  // Dismiss any blocking overlay (onboarding tour, command palette backdrop,
  // etc.) that may be sitting on top of the sidebar.
  await dismissBlockingOverlays(page);
  // Try CSS aria-label selector first (works even through Radix wrappers).
  let btn = sidebar.locator(`button[aria-label="${label}"]`).first();
  if ((await btn.count()) === 0) {
    // Fallback: getByRole (may fail with Radix Tooltip in headless).
    btn = sidebar.getByRole('button', { name: label, exact: true }).first();
  }
  if ((await btn.count()) === 0) {
    throw new Error(`Navigation item "${label}" not found — access denied for this role?`);
  }
  await btn.click({ timeout: 10_000 });
}

/** The main content region heading for a freshly opened admin section. */
export function mainHeading(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('heading').first();
}
