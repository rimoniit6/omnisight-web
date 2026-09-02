import { chromium } from 'playwright';
const BASE_URL = 'http://localhost:3000';
async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const logs: string[] = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  
  await page.goto(`${BASE_URL}/dashboard/live-monitor`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  
  const url = page.url();
  console.log('URL:', url);
  
  // Get page text
  const text = await page.textContent('body').catch(() => 'N/A');
  console.log('Body text (first 500 chars):', text?.substring(0, 500));
  
  // Check for any buttons
  const buttons = await page.locator('button').allTextContents();
  console.log('Buttons found:', buttons);
  
  // Check console
  console.log('\nConsole logs:');
  logs.forEach(l => console.log('  ', l));
  
  await page.screenshot({ path: 'screenshots/sound-debug.png' });
  await browser.close();
}
main().catch(console.error);
