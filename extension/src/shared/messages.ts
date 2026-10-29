/** Message shapes between the popup / content script and the background service worker. */
import type { AccountSummary, Login, Settings } from './types';
import type { GeneratorOptions } from './generator';

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface PendingSave {
  origin: string;
  username: string;
  /** save = first login for this site, another = new account on a known site, update = password changed */
  kind: 'save' | 'another' | 'update';
  at: number;
}

export interface TabContext {
  tabId: number | null;
  origin: string | null;
  accounts: AccountSummary[];
  pending: PendingSave | null;
}

export interface ImportPreview {
  token: string;
  source: string;
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export interface Status {
  exists: boolean;
  unlocked: boolean;
  lockedOutUntil: number;
  corrupt: number;
}

/** Popup -> background (trusted extension page only). */
export type PopupRequest =
  | { type: 'status' }
  | { type: 'create'; password: string }
  | { type: 'unlock'; password: string }
  | { type: 'lock' }
  | { type: 'list' }
  | { type: 'get'; id: string }
  | { type: 'save'; login: Partial<Login> & { url: string; username: string; password: string } }
  | { type: 'delete'; id: string }
  | { type: 'setDefault'; origin: string; id: string }
  | { type: 'tabContext' }
  | { type: 'fillInTab'; id: string }
  | { type: 'copy'; id: string; field: 'username' | 'password' }
  | { type: 'copyText'; text: string }
  | { type: 'generate'; options?: Partial<GeneratorOptions> }
  | { type: 'getSettings' }
  | { type: 'updateSettings'; patch: Partial<Pick<Settings, 'autoLockMinutes' | 'clipboardClearSeconds'>> }
  | { type: 'removeNeverSave'; origin: string }
  | { type: 'changeMaster'; current: string; next: string }
  | { type: 'exportEncrypted'; master: string; exportPassword: string }
  | { type: 'exportCsv'; master: string }
  | { type: 'importPreview'; kind: 'mpvault' | 'csv'; text: string; password?: string }
  | { type: 'importCommit'; token: string }
  | { type: 'resolvePending'; tabId: number; action: 'save' | 'never' | 'dismiss' };

/** Content script -> background (untrusted: the page's origin is taken from Chrome, never from the message). */
export type ContentRequest =
  | { type: 'cs:accounts' }
  | { type: 'cs:fill'; id: string }
  | { type: 'cs:fillDefault' }
  | { type: 'cs:fillShortcut' }
  | { type: 'cs:captured'; username: string; password: string }
  | { type: 'cs:pending' }
  | { type: 'cs:resolvePending'; action: 'save' | 'never' | 'dismiss' };

/** Background -> content script. */
export type ContentCommand =
  | { type: 'bg:fill'; expectedOrigin: string; username: string; password: string }
  | { type: 'bg:shortcut' }
  | { type: 'bg:locked' };

export interface FillData {
  id: string;
  username: string;
  password: string;
  /** Other accounts for this site, for the "Other accounts" link. */
  others: number;
}
