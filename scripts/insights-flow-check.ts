/**
 * Verifies the risk monitor, dashboard charts with hover tooltips, the
 * instant-documents hub, and the Companies House auto-fill guard, in the
 * real UI against the PHP server.
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
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
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
    await page.waitForTimeout(1500);
  }

  // --- Dashboard: charts + risk monitor ------------------------------------
  if (!(await page.locator('text=Risk monitor').count())) throw new Error('Risk monitor card missing');
  if (!(await page.locator('text=Invoiced per month').count())) throw new Error('Column chart card missing');
  const riskText = await page.locator('.card', { hasText: 'Risk monitor' }).innerText();
  for (const needle of ['appears 2 times', 'unfilled']) {
    if (!riskText.includes(needle)) throw new Error(`Risk monitor missing "${needle}"`);
  }
  console.log('  risk monitor shows duplicate-org and unfilled-shift findings');

  // Hover the column chart → tooltip with the £ value.
  const chartCard = page.locator('.card', { hasText: 'Invoiced per month' });
  const svg = chartCard.locator('svg');
  const box = (await svg.boundingBox())!;
  // The seeded invoice is in the current month — the last column band.
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const tipText = await chartCard.innerText();
  if (!tipText.includes('£148.00')) throw new Error(`Column tooltip did not show £148.00 — got: ${tipText.slice(0, 200)}`);
  console.log('  column chart hover tooltip shows £148.00');
  await page.screenshot({ path: join(outDir, '01-dashboard.png'), fullPage: true });

  // Line chart hover: both series in one readout.
  const lineCard = page.locator('.card', { hasText: 'Charge vs pay per month' });
  const lbox = (await lineCard.locator('svg').boundingBox())!;
  await page.mouse.move(lbox.x + lbox.width - 30, lbox.y + lbox.height / 2);
  await page.waitForTimeout(400);
  const lineText = await lineCard.innerText();
  if (!lineText.includes('Charged to clients') || !lineText.includes('Paid for labour')) {
    throw new Error('Line chart tooltip/legend missing series');
  }
  console.log('  line chart crosshair readout lists both series');
  await page.screenshot({ path: join(outDir, '02-dashboard-line-hover.png') });

  // Table view exists (nothing gated behind hover).
  await chartCard.locator('button:has-text("View as table")').click();
  await page.waitForTimeout(300);
  if (!(await chartCard.locator('table').count())) throw new Error('Chart table view missing');
  console.log('  chart table view opens');

  // --- Statutory: instant documents hub ------------------------------------
  await page.locator('.nav-item', { hasText: 'Statutory' }).first().click();
  await page.waitForTimeout(1000);
  if (!(await page.locator('text=Instant documents').count())) throw new Error('Document hub missing');
  await page.screenshot({ path: join(outDir, '03-document-hub.png'), fullPage: true });

  const [reg] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('tr', { hasText: 'Right-to-work check register' }).locator('button:has-text("Print / PDF")').click(),
  ]);
  await reg.waitForLoadState('networkidle');
  const regBody = await reg.locator('body').innerText();
  if (!regBody.includes('Right-to-work check register') || !regBody.includes('Sam Officer')) {
    throw new Error('RTW register did not render with live data');
  }
  await reg.screenshot({ path: join(outDir, '04-rtw-register.png'), fullPage: true });
  await reg.close();
  console.log('  RTW register generated with live data');

  // --- Companies House auto-fill guard (no key set → helpful message) ------
  await page.locator('.nav-item', { hasText: 'Clients' }).first().click();
  await page.waitForTimeout(900);
  await page.click('button:has-text("Add organisation")');
  await page.waitForTimeout(500);
  await page.locator('.field', { has: page.locator('label:text-is("Company number")') }).locator('input').fill('09985380');
  await page.click('button:has-text("Auto-fill from Companies House")');
  await page.waitForTimeout(900);
  const modalText = await page.locator('.modal').last().innerText();
  if (!modalText.includes('No Companies House API key is set')) {
    throw new Error('Expected the no-key guidance message');
  }
  console.log('  auto-fill without a key shows the free-key instructions');
  await page.screenshot({ path: join(outDir, '05-ch-autofill-guard.png') });

  await browser.close();
  const real = errors.filter((e) => !/status of 400/.test(e));
  if (real.length) {
    console.error(`${real.length} console error(s):`);
    for (const e of real.slice(0, 10)) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log('\nInsights flow OK, no console errors.');
}

main().catch((err) => { console.error('Insights flow failed:', err.message); process.exit(1); });
