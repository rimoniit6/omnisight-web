import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT = resolve('docs/company-guide/screenshots')

function resolveChromium() {
  const roots = []
  for (const base of [
    join(homedir(), '.vscode-server/extensions'),
    join(homedir(), '.vscode/extensions'),
  ]) {
    if (!existsSync(base)) continue
    const dirs = readdirSync(base)
      .filter((d) => d.startsWith('danielsanmedium.dscodegpt-'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
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
  throw new Error('Could not resolve patchright')
}

const { chromium } = resolveChromium()
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

try {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForSelector('input[type="email"]', { timeout: 15000 })
  await page.fill('input[type="email"]', 'admin@techvision.com')
  await page.fill('input[type="password"]', 'admin123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForTimeout(3500)

  // Force dark theme (next-themes localStorage key), then reload
  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('worklens-theme', 'dark')
    document.documentElement.classList.add('dark')
  })
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(2500)
  const cls = await page.evaluate(() => document.documentElement.className)
  console.log('html class after reload:', cls)
  await page.screenshot({ path: join(OUT, '27-dashboard-dark.png'), fullPage: true })
  console.log('saved dark dashboard')
} catch (e) {
  console.log('ERROR', String(e).slice(0, 500))
}
await browser.close()
