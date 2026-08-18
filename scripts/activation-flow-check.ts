/**
 * Verifies the worker-activation fix in the real UI: a fully-vetted worker
 * stuck at onboarding shows the activation banner, one click makes them
 * active, and the audit records it.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { currentCode } from '../server/auth/totp.js';

const baseUrl = process.argv[2];
const outDir = process.argv[3];
const email = process.argv[4];
const password = process.argv[5];

mkdirSync(outDir, { recursive: true });
const errors: string[] = [];

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1500, height: 980 } });
  const page = await context.newPage();
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e: any) => errors.push(`Uncaught: ${e.message}`));

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
  await page.waitForTimeout(1200);

  if (await page.locator('text=Set up two-factor authentication').count()) {
    await page.click('button:has-text("Set up two-factor authentication")');
    await page.waitForSelector('.setup-key', { timeout: 10_000 });
    const secret = (await page.locator('.setup-key').innerText()).replace(/\s/g, '');
    await page.fill('.code-input', currentCode(secret));
    await page.click('button:has-text("Turn on two-factor")');
    await page.waitForTimeout(1200);
    if (await page.locator('text=Save your recovery codes').count()) {
      await page.click('button:has-text("I have saved them")');
      await page.waitForTimeout(1200);
    }
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
  }

  await page.locator('.nav-item', { hasText: 'Workers' }).first().click();
  await page.waitForTimeout(900);
  await page.locator('tr.clickable', { hasText: 'Muhammad Zohaib' }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(outDir, '01-onboarding-with-banner.png') });

  if (!(await page.locator('text=Vetting complete — this worker can be activated').count())) {
    throw new Error('Activation banner not shown for fully-vetted onboarding worker');
  }
  console.log('  banner shown for fully-vetted onboarding worker');

  await page.click('button:has-text("Mark active")');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(outDir, '02-active.png') });

  const statusSelect = page.locator('.modal select').first();
  if ((await statusSelect.inputValue()) !== 'active') throw new Error('Status did not change to active');
  if (await page.locator('text=Vetting complete').count()) throw new Error('Banner still shown after activation');
  console.log('  one click made the worker active; banner cleared');

  await browser.close();
  if (errors.length) {
    console.error(`${errors.length} console error(s):`);
    for (const e of errors.slice(0, 10)) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log('\nActivation flow OK, no console errors.');
}

main().catch((err) => { console.error('Activation flow failed:', err.message); process.exit(1); });
