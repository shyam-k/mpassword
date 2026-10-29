/**
 * Export and import.
 *  - .mpvault: encrypted with its own export password (Argon2id + XChaCha20-Poly1305), header bound as AD.
 *  - CSV: Chrome / Edge, Bitwarden, or generic columns. Plaintext, so only with explicit consent.
 */
import { deriveKey, newKdfParams, openJson, sealJson, validateKdfParams, wipe, type KdfParams } from './crypto';
import { parseCsv, toCsv } from './csv';
import { normaliseUrl, originOf } from './origin';
import type { Login, LoginInput } from './types';

export const EXPORT_FORMAT = 'mpvault-export';
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ENTRIES = 10_000;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  v: 1;
  createdAt: number;
  count: number;
  kdf: KdfParams;
  n: string;
  c: string;
}

interface ExportPayload {
  logins: Login[];
  defaults: Record<string, string>;
}

function exportAd(f: Pick<ExportFile, 'createdAt' | 'count' | 'kdf'>): string {
  return `mpv1|export|${f.createdAt}|${f.count}|${f.kdf.alg}|${f.kdf.salt}|${f.kdf.ops}|${f.kdf.mem}`;
}

export async function buildEncryptedExport(
  logins: Login[],
  defaults: Record<string, string>,
  exportPassword: string,
  kdfOverride?: { ops: number; mem: number },
): Promise<string> {
  const kdf = await newKdfParams(kdfOverride?.ops, kdfOverride?.mem);
  const head = { createdAt: Date.now(), count: logins.length, kdf };
  const key = await deriveKey(exportPassword, kdf);
  try {
    const sealed = await sealJson(key, { logins, defaults } satisfies ExportPayload, exportAd(head));
    const file: ExportFile = { format: EXPORT_FORMAT, v: 1, ...head, n: sealed.n, c: sealed.c };
    return JSON.stringify(file, null, 2);
  } finally {
    await wipe(key);
  }
}

export class ImportError extends Error {}

export async function readEncryptedExport(text: string, exportPassword: string): Promise<ExportPayload> {
  if (text.length > MAX_IMPORT_BYTES) throw new ImportError('File is too large');
  let f: ExportFile;
  try {
    f = JSON.parse(text) as ExportFile;
  } catch {
    throw new ImportError('Not an mPassword export file');
  }
  if (f.format !== EXPORT_FORMAT || f.v !== 1 || !Number.isInteger(f.count) || !Number.isInteger(f.createdAt)) {
    throw new ImportError('Not an mPassword export file');
  }
  validateKdfParams(f.kdf);
  const key = await deriveKey(exportPassword, f.kdf);
  let payload: ExportPayload;
  try {
    payload = await openJson<ExportPayload>(key, { n: f.n, c: f.c }, exportAd(f));
  } catch {
    throw new ImportError('Wrong export password, or the file was modified');
  } finally {
    await wipe(key);
  }
  if (!Array.isArray(payload.logins) || payload.logins.length !== f.count || payload.logins.length > MAX_IMPORT_ENTRIES) {
    throw new ImportError('Export file contents are invalid');
  }
  return payload;
}

export function buildCsvExport(logins: Login[]): string {
  const rows = [['name', 'url', 'username', 'password', 'note', 'label']];
  for (const l of logins) rows.push([l.title, l.url, l.username, l.password, l.notes, l.label]);
  return toCsv(rows);
}

export interface CsvImportResult {
  source: 'chrome' | 'bitwarden' | 'generic';
  items: LoginInput[];
  skipped: number;
}

const COLS = {
  url: ['url', 'login_uri', 'website', 'uri', 'web site', 'origin'],
  username: ['username', 'login_username', 'user', 'login', 'email', 'user name'],
  password: ['password', 'login_password', 'pass'],
  title: ['name', 'title'],
  notes: ['note', 'notes', 'extra', 'comment'],
  label: ['label'],
};

export function parseCsvImport(text: string): CsvImportResult {
  if (text.length > MAX_IMPORT_BYTES) throw new ImportError('File is too large');
  const rows = parseCsv(text);
  const header = rows.shift()?.map((h) => h.trim().toLowerCase());
  if (!header) throw new ImportError('The CSV file is empty');
  const find = (names: string[]) => header.findIndex((h) => names.includes(h));
  const idx = {
    url: find(COLS.url),
    username: find(COLS.username),
    password: find(COLS.password),
    title: find(COLS.title),
    notes: find(COLS.notes),
    label: find(COLS.label),
  };
  if (idx.url < 0 || idx.password < 0) {
    throw new ImportError('Could not find "url" and "password" columns in the CSV header');
  }
  const source = header.includes('login_uri') ? 'bitwarden' : header.join(',').startsWith('name,url,username,password') ? 'chrome' : 'generic';
  const typeCol = header.indexOf('type');
  const items: LoginInput[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (items.length >= MAX_IMPORT_ENTRIES) {
      skipped++;
      continue;
    }
    const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    if (source === 'bitwarden' && typeCol >= 0 && get(typeCol) && get(typeCol) !== 'login') {
      skipped++;
      continue;
    }
    // Bitwarden may hold several URIs separated by commas/newlines; take the first.
    const rawUrl = get(idx.url).split(/[\n,]/)[0] ?? '';
    const url = normaliseUrl(rawUrl);
    const password = idx.password >= 0 ? (r[idx.password] ?? '') : '';
    if (!originOf(url) || !password) {
      skipped++;
      continue;
    }
    items.push({
      url,
      username: get(idx.username),
      password,
      title: get(idx.title),
      notes: idx.notes >= 0 ? (r[idx.notes] ?? '') : '',
      label: get(idx.label),
    });
  }
  return { source, items, skipped };
}
