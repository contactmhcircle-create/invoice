import { app, BrowserWindow, Menu, shell, dialog } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { openDatabase } from './db/connection.js';
import type { Db } from './db/connection.js';
import { registerIpc } from './ipc.js';
import { backupDatabase } from './services/backup.js';
import { verifyAuditChain } from './db/audit.js';

const here = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let db: Db;
let dbPath: string;
let dataDir: string;

function resolveDataDir(): string {
  // Everything the business depends on lives in one directory, so backing up
  // the business means copying one folder. CERVIZ_DATA_DIR points it elsewhere,
  // which is how the demo dataset and automated checks are run.
  const dir = process.env.CERVIZ_DATA_DIR ?? join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'documents'), { recursive: true });
  mkdirSync(join(dir, 'backups'), { recursive: true });
  return dir;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'Cerviz Back Office',
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    mainWindow.loadURL(devServer);
  } else {
    mainWindow.loadFile(join(here, '..', 'dist', 'index.html'));
  }

  // External links open in the browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Development screen check. Never runs unless CERVIZ_SCREENSHOT_DIR is set.
  if (process.env.CERVIZ_SCREENSHOT_DIR) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const { runScreenshotPass } = await import('./devScreenshots.js');
      const code = await runScreenshotPass(mainWindow!, process.env.CERVIZ_SCREENSHOT_DIR!);
      app.exit(code);
    });
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Back up now',
          accelerator: 'CmdOrCtrl+B',
          click: async () => {
            const result = backupDatabase(db, dbPath, join(dataDir, 'backups'));
            await dialog.showMessageBox({
              type: result.auditChainOk ? 'info' : 'warning',
              title: 'Backup complete',
              message: `Backup written (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
              detail:
                `${result.path}\n\nSHA-256: ${result.sha256.slice(0, 32)}…\n\n` +
                (result.auditChainOk
                  ? 'Audit trail verified intact at the time of backup.'
                  : 'WARNING: the audit trail did not verify. Investigate before relying on this data.'),
            });
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Verify audit trail',
          click: async () => {
            const result = verifyAuditChain(db);
            await dialog.showMessageBox({
              type: result.ok ? 'info' : 'error',
              title: 'Audit trail verification',
              message: result.ok ? 'Audit trail is intact.' : 'Audit trail is broken.',
              detail: result.ok
                ? `${result.entriesChecked} entries checked. Every entry cryptographically seals the one before it, ` +
                  'so this confirms no historic record has been altered or removed.'
                : `${result.reason}\n\nThe record cannot be relied upon from entry ${result.brokenAtId} onwards. ` +
                  'Restore from a backup taken before the break.',
            });
          },
        },
        {
          label: 'Open data folder',
          click: () => shell.openPath(dataDir),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  dataDir = resolveDataDir();
  dbPath = join(dataDir, 'cerviz.sqlite');
  db = openDatabase(dbPath);

  // A backup on every launch means the worst case is losing one session's work.
  try {
    backupDatabase(db, dbPath, join(dataDir, 'backups'));
  } catch (err) {
    console.error('Startup backup failed:', err);
  }

  registerIpc({ db, dbPath, dataDir });
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { db?.close(); } catch { /* closing a closed database is not worth failing on */ }
});
