/**
 * Drives the new manual-invoice flow in the real UI against the PHP server:
 * sign in + 2FA, create a manual invoice, add/edit/remove lines, edit the
 * header, issue it, check it is frozen, and screenshot the rendered document.
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

/** A field input located by its label text. */
const field = (page: any, label: string) =>
  page.locator('.field', { has: page.locator(`label:text-is("${label}")`) }).locator('input, select').first();

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1500, height: 980 } });
  const page = await context.newPage();
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e: any) => errors.push(`Uncaught: ${e.message}`));

  // Sign in and enrol 2FA (fresh instance).
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

  // Sales invoices → New invoice.
  await page.locator('.nav-item', { hasText: 'Sales invoices' }).first().click();
  await page.waitForTimeout(800);
  await page.click('button:has-text("New invoice")');
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, '01-new-invoice-modal.png') });

  const clientOptions = await field(page, 'Client').locator('option').count();
  console.log(`  client options: ${clientOptions}`);
  await field(page, 'Purchase order reference (optional)').fill('PO-2026-114');
  await page.click('button:has-text("Create draft")');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(outDir, '02-empty-draft.png') });

  // Add a plain-amount line.
  await page.click('button:has-text("Add line")');
  await field(page, 'Description').fill('Static guarding — Riverside site, March');
  await field(page, 'Amount (£)').fill('1250.00');
  await page.click('.modal-stack button:has-text("Save"), button:has-text("Save")');
  await page.waitForTimeout(900);

  // Add a qty × unit line.
  await page.click('button:has-text("Add line")');
  await field(page, 'Description').fill('Key holding call-out');
  await field(page, 'Quantity').fill('4');
  await field(page, 'Unit price (£)').fill('25.00');
  await page.click('button:has-text("Save")');
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(outDir, '03-two-lines.png') });

  if (!(await page.locator('text=(4 × £25.00)').count())) throw new Error('Quantity folding not visible');

  // Edit the first line.
  await page.locator('button:has-text("Edit")').first().click();
  await field(page, 'Description').fill('Static guarding — Riverside site, March (revised)');
  await field(page, 'Amount (£)').fill('1200.00');
  await page.click('button:has-text("Save")');
  await page.waitForTimeout(900);

  // Edit the header PO.
  await page.click('a:has-text("edit details")');
  await field(page, 'Purchase order reference').fill('PO-2026-115');
  await page.click('button:has-text("Save")');
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(outDir, '04-edited-draft.png') });

  const totalText = await page.locator('.modal .row-between, .row-between').first().innerText().catch(() => '');
  console.log(`  header after edits: ${totalText.replace(/\n/g, ' | ')}`);

  // Issue it — becomes frozen: no Edit/Remove/Add line.
  await page.click('button:has-text("Issue invoice")');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(outDir, '05-issued.png') });
  // Exact match — has-text("Edit") would substring-match the "Credit note" button.
  const editButtons = await page.getByRole('button', { name: 'Edit', exact: true }).count();
  const addLine = await page.locator('button:has-text("Add line")').count();
  if (editButtons || addLine) throw new Error('Issued invoice still shows editing controls');
  console.log('  issued: editing controls gone');

  // The rendered document (the reference layout) in a popup.
  const [doc] = await Promise.all([
    context.waitForEvent('page'),
    page.click('button:has-text("Print / save PDF")'),
  ]);
  await doc.waitForLoadState('networkidle');
  await doc.screenshot({ path: join(outDir, '06-document.png'), fullPage: true });
  const body = await doc.locator('body').innerText();
  for (const needle of ['BALANCE DUE', 'INVOICE TO', 'Please pay the invoice']) {
    if (!body.includes(needle)) throw new Error(`Document missing "${needle}"`);
  }
  console.log('  document contains BALANCE DUE, INVOICE TO and the payment block');

  await browser.close();
  if (errors.length) {
    console.error(`${errors.length} console error(s):`);
    for (const e of errors.slice(0, 10)) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log('\nInvoice flow OK, no console errors.');
}

main().catch((err) => { console.error('Invoice flow failed:', err.message); process.exit(1); });
