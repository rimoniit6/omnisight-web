// Standalone capture driver for the company guide.
// Resolves patchright the same way browser.mjs does, logs in, and screenshots every page.
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT = resolve('docs/company-guide/screenshots')
mkdirSync(OUT, { recursive: true })

function resolveChromium() {
  const roots = []
  for (const base of [
    join(homedir(), '.vscode-server/extensions'),
    join(homedir(), '.vscode/extensions'),
  ]) {
    if (!existsSync(base)) continue
    const dirs = readdirSync(base)
      .filter((d) => d.startsWith('danielsanmedium.dscodegpt-'))
      .sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
      )
    const newest = dirs[dirs.length - 1]
    if (newest) roots.push(join(base, newest, 'standalone') + '/')
  }
  for (const root of roots) {
    try {
      const mod = createRequire(root)('patchright')
      const chromium = mod?.chromium ?? mod?.default?.chromium
      if (chromium) return { chromium, root }
    } catch {}
  }
  throw new Error('Could not resolve patchright. Checked: ' + roots.join('\n'))
}

const { chromium } = resolveChromium()
const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200))
})
page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)))

async function shot(name) {
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(OUT, name), fullPage: true })
  console.log('saved', name)
}

async function nav(label, name) {
  const sidebar = page.locator('aside[data-tour-target="sidebar"]')
  const btn = sidebar.getByRole('button', { name: label, exact: true })
  try {
    await btn.click({ force: true, timeout: 8000 })
  } catch {
    await btn.evaluate((el) => el.click())
  }
  await page.waitForTimeout(2000)
  await shot(name)
}

const results = {}
try {
  // 1) Login page
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForSelector('input[type="email"]', { timeout: 15000 })
  await shot('00-login.png')

  // 2) Log in
  await page.fill('input[type="email"]', 'admin@techvision.com')
  await page.fill('input[type="password"]', 'admin123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForTimeout(3000)
  results.afterLogin = page.url()

  // Dashboard
  await shot('01-dashboard.png')

  // Main pages via sidebar (aria-label = label)
  await nav('Employees', '02-employees.png')
  await nav('Departments', '03-departments.png')
  await nav('Devices', '04-devices.png')
  await nav('Activities', '05-activities.png')
  await nav('Screenshots', '06-screenshots.png')
  await nav('Break Monitor', '07-break-monitor.png')
  await nav('Live Monitor', '08-live-monitor.png')
  await nav('Analytics', '09-analytics.png')
  await nav('AI Insights', '10-ai-insights.png')
  await nav('AI Provider', '11-ai-provider.png')
  await nav('Agent Approvals', '12-agent-approvals.png')
  await nav('Notifications', '13-notifications.png')
  await nav('Alerts', '14-alerts.png')
  await nav('Audit Logs', '15-audit-logs.png')
  await nav('Security', '16-security.png')
  await nav('Policies', '17-policies.png')
  await nav('Anomaly Detection', '18-anomalies.png')
  await nav('Consent', '19-consent.png')
  await nav('My Portal', '20-self-portal.png')
  await nav('Projects', '21-projects.png')
  await nav('Sentiment', '22-sentiment.png')
  await nav('Organization', '23-organization.png')
  await nav('Reports', '24-reports.png')
  await nav('Daily Report', '25-daily-report.png')
  await nav('Settings', '26-settings.png')

  // Dashboard in the other theme (app defaults to dark in this env, so capture light)
  await nav('Dashboard', '27-dashboard-dark.png')
  const themeBtn = page.locator('button[aria-label="Toggle theme"]').first()
  if ((await themeBtn.count()) > 0) {
    await themeBtn.click()
    await page.waitForTimeout(2000)
    await shot('28-dashboard-light-mode.png')
  }
} catch (e) {
  results.error = String(e).slice(0, 500)
}
results.consoleErrors = consoleErrors.slice(0, 10)
console.log('RESULTS', JSON.stringify(results, null, 1))
await browser.close()
