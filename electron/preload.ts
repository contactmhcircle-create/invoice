import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer gets exactly one function. Everything goes through the main
 * process, which owns the database — the UI never touches SQLite directly.
 */

export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// Not generic: .cts files cannot use unconstrained type parameters in arrow
// functions, and the renderer-side client applies the typing anyway.
contextBridge.exposeInMainWorld('cerviz', {
  invoke(channel: string, payload?: unknown): Promise<IpcResult> {
    return ipcRenderer.invoke('cerviz:invoke', channel, payload);
  },
  platform: process.platform,
});
