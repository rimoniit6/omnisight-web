import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(__dirname, '..', 'docs', 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function captureScreenshot(page, name) {
  const path = resolve(SCREENSHOT_DIR, name);
  await page.screenshot({ path, timeout: 15000 });
  console.log(`✓ Captured: ${name}`);
}

// Dismiss any tour/onboarding overlays
async function dismissOverlays(page) {
  // Press Escape to dismiss any overlays
  await page.keyboard.press('Escape');
  await sleep(500);
  // Try clicking any dismiss/skip buttons
  const dismissBtns = page.locator('button:has-text("Skip"), button:has-text("Dismiss"), button:has-text("Got it"), button:has-text("Close"), button:has-text("×"), button:has-text("Done"), button:has-text("End tour")');
  const count = await dismissBtns.count();
  for (let i = 0; i < count; i++) {
    try {
      await dismissBtns.nth(i).click({ timeout: 2000 });
      await sleep(300);
    } catch {}
  }
  // Also try to remove overlay divs via JS
  await page.evaluate(() => {
    document.querySelectorAll('[class*="tour"], [class*="overlay"], [class*="onboarding"], [data-tour]').forEach(el => {
      if (el.style) el.style.display = 'none';
    });
    // Remove fixed overlays
    document.querySelectorAll('.fixed.inset-0').forEach(el => {
      if (el.style) el.style.display = 'none';
    });
  });
  await sleep(500);
}

async function navigateAndCapture(page, label, file) {
  console.log(`Navigating to: ${label}`);
  try {
    const button = page.locator(`button[aria-label="${label}"]`);
    if (await button.count() > 0) {
      await button.click({ force: true, timeout: 5000 });
      await sleep(2500);
      await captureScreenshot(page, file);
      return true;
    }
  } catch (err) {
    console.log(`  ⚠ Click failed for ${label}: ${err.message?.substring(0, 80)}`);
    // Try force click with JS
    try {
      await page.evaluate((lbl) => {
        const btn = document.querySelector(`button[aria-label="${lbl}"]`);
        if (btn) btn.click();
      }, label);
      await sleep(2500);
      await captureScreenshot(page, file);
      return true;
    } catch {}
  }
  console.log(`  ⚠ Could not navigate to: ${label}`);
  return false;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Navigate to login page
  console.log('Navigating to login page...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(2000);

  // Capture login page
  await captureScreenshot(page, '01-login.png');

  // Use super admin credentials
  const loginEmail = 'rimon@admin.com';
  const loginPassword = 'Rimon0000000';
  
  console.log(`Attempting login with: ${loginEmail}`);
  const emailInput = page.locator('input[type="email"], input#email');
  const passwordInput = page.locator('input[type="password"], input#password');
  
  if (await emailInput.count() > 0) {
    await emailInput.fill(loginEmail);
    await passwordInput.fill(loginPassword);
    
    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();
    await sleep(4000);
    
    const loginError = page.locator('#login-error');
    if (await loginError.count() > 0) {
      const errorText = await loginError.textContent();
      console.log(`Login error: ${errorText}`);
      await captureScreenshot(page, '01-login-error.png');
    } else {
      console.log('Login successful!');
    }
  }

  // Wait for dashboard to load
  await sleep(3000);
  
  // Dismiss any tour/onboarding overlays
  console.log('Dismissing overlays...');
  await dismissOverlays(page);
  
  // Capture dashboard
  await captureScreenshot(page, '02-dashboard.png');
  console.log('Dashboard captured');

  // Define pages to capture
  const pages = [
    { label: 'Employees', file: '03-employees.png' },
    { label: 'Departments', file: '04-departments.png' },
    { label: 'Devices', file: '05-devices.png' },
    { label: 'Activities', file: '06-activities.png' },
    { label: 'Screenshots', file: '07-screenshots.png' },
    { label: 'Audio Transcriptions', file: '08-audio.png' },
    { label: 'Break Monitor', file: '09-break-monitor.png' },
    { label: 'Live Monitor', file: '10-live-monitor.png' },
    { label: 'Analytics', file: '11-analytics.png' },
    { label: 'AI Insights', file: '12-ai-insights.png' },
    { label: 'Sentiment', file: '13-sentiment.png' },
    { label: 'AI Provider', file: '14-ai-provider.png' },
    { label: 'Agent Approvals', file: '15-agent-approvals.png' },
    { label: 'Notifications', file: '16-notifications.png' },
    { label: 'Alerts', file: '17-alerts.png' },
    { label: 'Audit Logs', file: '18-audit-logs.png' },
    { label: 'Agent Security', file: '19-agent-security.png' },
    { label: 'Policies', file: '20-policies.png' },
    { label: 'Anomaly Detection', file: '21-anomalies.png' },
    { label: 'Consent', file: '22-consent.png' },
    { label: 'Projects', file: '23-projects.png' },
    { label: 'Employee Portal', file: '24-self-portal.png' },
    { label: 'Organization', file: '25-organization.png' },
    { label: 'Users & Members', file: '26-users.png' },
    { label: 'Reports', file: '27-reports.png' },
    { label: 'Daily Report', file: '28-daily-report.png' },
    { label: 'Settings', file: '29-settings.png' },
    { label: 'Branding', file: '30-branding.png' },
    { label: 'Super Admin', file: '31-super-admin.png' },
  ];

  for (const { label, file } of pages) {
    await navigateAndCapture(page, label, file);
    // Dismiss overlays after each navigation
    await dismissOverlays(page);
  }

  // Capture sidebar collapse
  console.log('Capturing collapsed sidebar...');
  try {
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Collapse sidebar"]');
      if (btn) btn.click();
    });
    await sleep(1000);
    await captureScreenshot(page, '32-sidebar-collapsed.png');
  } catch (err) {
    console.log(`  ⚠ Could not collapse sidebar: ${err.message}`);
  }

  await browser.close();
  console.log('\n✅ Screenshot capture complete!');
  console.log(`Screenshots saved to: ${SCREENSHOT_DIR}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
