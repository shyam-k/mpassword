import type { KdfParams, Sealed } from './crypto';

export const VAULT_FORMAT = 'mpassword-vault';
export const VAULT_VERSION = 1;

/** Stored in plaintext; contains only public parameters and the wrapped (encrypted) vault key. */
export interface VaultHeader {
  format: typeof VAULT_FORMAT;
  v: typeof VAULT_VERSION;
  vaultId: string;
  createdAt: number;
  kdf: KdfParams;
  /** Vault key sealed under the key derived from the master password. */
  wrappedKey: Sealed;
}

/** One stored entry. `s` holds the encrypted Login; tombstones have no `s`. */
export interface EntryRecord {
  id: string;
  /** Lamport counter: higher wins when syncing. */
  rev: number;
  /** Device that made this revision. */
  dev: string;
  /** Wall-clock time of this revision (display only, never trusted for ordering). */
  upd: number;
  del?: true;
  s?: Sealed;
}

export interface PasswordHistoryItem {
  password: string;
  changedAt: number;
}

/** A decrypted login. Only ever lives in memory of the service worker (and briefly in the popup). */
export interface Login {
  id: string;
  title: string;
  url: string;
  /** Normalised origin, e.g. https://accounts.example.com */
  origin: string;
  username: string;
  password: string;
  notes: string;
  /** Optional account label shown in the picker, e.g. "Work". */
  label: string;
  /** Also offer this login on subdomains of the saved host. Off by default. */
  matchSubdomains: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  history: PasswordHistoryItem[];
}

export type LoginInput = Partial<Omit<Login, 'createdAt' | 'updatedAt' | 'history' | 'origin'>> & {
  url: string;
  username: string;
  password: string;
};

export interface Settings {
  /** origin -> default login id for that origin */
  defaults: Record<string, string>;
  /** origins where the save prompt is never shown */
  neverSave: string[];
  autoLockMinutes: number;
  clipboardClearSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  defaults: {},
  neverSave: [],
  autoLockMinutes: 5,
  clipboardClearSeconds: 30,
};

/** What the content script is allowed to see before a fill: no passwords. */
export interface AccountSummary {
  id: string;
  username: string;
  label: string;
  title: string;
  isDefault: boolean;
  lastUsedAt: number;
}

export const HISTORY_LIMIT = 5;
