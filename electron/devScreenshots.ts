import type { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Development check: drives the running application through every screen and
 * captures each one, failing on any console error.
 *
 * Because it runs inside the real app with the real IPC layer and the real
 * database, a screen that throws fails here rather than in front of a user.
 * Activated only by CERVIZ_SCREENSHOT_DIR; never runs in normal use.
 */

const PAGES = [
  'dashboard', 'workers', 'rota', 'clients',
  'timesheets', 'invoices', 'purchases', 'reports', 'statutory', 'settings',
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runScreenshotPass(win: BrowserWindow, outDir: string): Promise<number> {
  mkdirSync(outDir, { recursive: true });

  const errors: string[] = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  await wait(2000);

  for (let i = 0; i < PAGES.length; i++) {
    await win.webContents.executeJavaScript(
      `(() => { const n = [...document.querySelectorAll('.nav-item')]; if (n[${i}]) n[${i}].click(); return true; })()`,
    );
    await wait(1200);

    const image = await win.webContents.capturePage();
    writeFileSync(join(outDir, `${String(i + 1).padStart(2, '0')}-${PAGES[i]}.png`), image.toPNG());

    const title = await win.webContents.executeJavaScript(
      `document.querySelector('.page-title')?.textContent ?? 'NO TITLE'`,
    );
    const loading = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.spinner').length`,
    );
    console.log(`[screens] ${PAGES[i]}: "${title}"${loading ? ` — ${loading} still loading` : ''}`);
  }

  if (errors.length) {
    console.error(`[screens] ${errors.length} console error(s):`);
    for (const e of errors.slice(0, 25)) console.error(`  ${e}`);
    return 1;
  }
  console.log('[screens] no console errors');
  return 0;
}
