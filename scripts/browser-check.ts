/**
 * Drives the running application in a real browser, through the whole first-run
 * flow: sign in, forced password change, forced two-factor setup, then every
 * screen. Fails on any console error.
 *
 * Development tool. Usage:
 *   tsx scripts/browser-check.ts <baseUrl> <outputDir> <email> <password>
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { currentCode } from '../server/auth/totp.js';

const baseUrl = process.argv[2] ?? 'http://localhost:8080';
const outDir = process.argv[3] ?? './screens';
const email = process.argv[4] ?? 'owner@cerviz.co.uk';
const initialPassword = process.argv[5] ?? 'a-long-enough-test-password';
const newPassword = 'a-much-better-owner-password';

mkdirSync(outDir, { recursive: true });

const PAGES = [
  'dashboard', 'workers', 'rota', 'clients',
  'timesheets', 'invoices', 'purchases', 'reports',
  'statutory', 'users', 'settings', 'account',
];

const errors: string[] = [];
let shot = 0;

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1500, height: 980 } });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`Uncaught: ${err.message}`));

  const capture = async (name: string) => {
    shot++;
    await page.screenshot({ path: join(outDir, `${String(shot).padStart(2, '0')}-${name}.png`) });
    console.log(`  captured ${name}`);
  };

  // --- Sign in -------------------------------------------------------------
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await capture('login');

  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', initialPassword);
  await page.click('button[type=submit]');
  await page.waitForTimeout(1200);

  // --- Forced password change ---------------------------------------------
  if (await page.locator('text=Choose a new password').count()) {
    console.log('  forced password change shown');
    await capture('forced-password-change');
    const fields = page.locator('input[type=password]');
    await fields.nth(0).fill(initialPassword);
    await fields.nth(1).fill(newPassword);
    await fields.nth(2).fill(newPassword);
    await page.click('button[type=submit]');
    await page.waitForTimeout(2000);

    // Changing the password ends the session, so sign in again.
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.fill('input[type=email]', email);
    await page.fill('input[type=password]', newPassword);
    await page.click('button[type=submit]');
    await page.waitForTimeout(1500);
  }

  // --- Forced two-factor setup --------------------------------------------
  if (await page.locator('text=Set up two-factor authentication').count()) {
    console.log('  forced two-factor setup shown');
    await capture('forced-2fa-prompt');

    await page.click('button:has-text("Set up two-factor authentication")');
    await page.waitForSelector('.setup-key', { timeout: 10_000 });
    await capture('2fa-qr-code');

    const displayed = (await page.locator('.setup-key').innerText()).replace(/\s/g, '');
    console.log(`  secret read from the page (${displayed.length} chars)`);

    await page.fill('.code-input', currentCode(displayed));
    await page.click('button:has-text("Turn on two-factor")');
    await page.waitForTimeout(1500);

    if (await page.locator('text=Save your recovery codes').count()) {
      console.log('  recovery codes shown');
      await capture('recovery-codes');
      await page.click('button:has-text("I have saved them")');
      await page.waitForTimeout(1500);
    }
  }

  // The gate clears only after a reload picks up the new state.
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  if (await page.locator('input[type=email]').count()) {
    // Session ended during setup; sign in with two-factor this time.
    await page.fill('input[type=email]', email);
    await page.fill('input[type=password]', newPassword);
    await page.click('button[type=submit]');
    await page.waitForTimeout(1200);
    throw new Error('Two-factor code required again — cannot continue without the stored secret.');
  }

  // --- Every screen --------------------------------------------------------
  for (const name of PAGES) {
    const nav = page.locator('.nav-item', { hasText: labelFor(name) });
    if (await nav.count() === 0) {
      console.log(`  ${name}: not in navigation for this role`);
      continue;
    }
    await nav.first().click();
    await page.waitForTimeout(900);
    const title = await page.locator('.page-title').first().innerText().catch(() => 'NO TITLE');
    console.log(`  ${name}: "${title}"`);
    await capture(name);
  }

  // --- Phone layout --------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await capture('phone-dashboard');
  await page.click('.menu-toggle');
  await page.waitForTimeout(400);
  await capture('phone-menu');

  await browser.close();

  if (errors.length) {
    console.error(`\n${errors.length} console error(s):`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log('\nNo console errors.');
}

function labelFor(id: string): string {
  return ({
    dashboard: 'Dashboard', workers: 'Workers', rota: 'Rota', clients: 'Clients',
    timesheets: 'Timesheets', invoices: 'Sales invoices', purchases: 'Purchases',
    reports: 'Reports', statutory: 'Statutory', users: 'Users', settings: 'Settings',
    account: 'My account',
  } as Record<string, string>)[id] ?? id;
}

main().catch((err) => {
  console.error('Browser check failed:', err.message);
  process.exit(1);
});
