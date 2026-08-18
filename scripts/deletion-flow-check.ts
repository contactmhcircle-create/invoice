/**
 * Verifies record deletion in the real UI: a duplicated organisation deletes
 * cleanly, while one with a linked worker is refused with the reason shown.
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

  await page.locator('.nav-item', { hasText: 'Clients' }).first().click();
  await page.waitForTimeout(900);

  const rows = () => page.locator('tr.clickable', { hasText: 'Hawk Security Group Ltd' });
  if (await rows().count() !== 2) throw new Error('Expected the duplicated organisation twice');
  await page.screenshot({ path: join(outDir, '01-duplicates.png') });

  // Delete the duplicate (second row — the one with nothing linked).
  await rows().nth(1).click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, '02-confirm.png') });
  await page.click('button:has-text("Delete organisation")');
  await page.waitForTimeout(1100);

  if (await rows().count() !== 1) throw new Error('Duplicate was not deleted');
  console.log('  duplicate organisation deleted from the UI');
  await page.screenshot({ path: join(outDir, '03-deduped.png') });

  // The remaining one has a worker paid via it — deletion must be refused.
  await rows().first().click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForTimeout(400);
  await page.click('button:has-text("Delete organisation")');
  await page.waitForTimeout(1100);

  const refusal = page.locator('text=/cannot be deleted.*worker paid via this umbrella/');
  if (!(await refusal.count())) throw new Error('Expected a refusal naming the linked worker');
  console.log('  org with a linked worker refused, reason shown in the modal');
  await page.screenshot({ path: join(outDir, '04-refused.png') });

  await browser.close();
  // The refused deletion legitimately answers 400; the browser logs that
  // status even though the UI handles it. Anything else is a real error.
  const real = errors.filter((e) => !/status of 400/.test(e));
  errors.length = 0;
  errors.push(...real);
  if (errors.length) {
    console.error(`${errors.length} console error(s):`);
    for (const e of errors.slice(0, 10)) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log('\nDeletion flow OK, no console errors.');
}

main().catch((err) => { console.error('Deletion flow failed:', err.message); process.exit(1); });
