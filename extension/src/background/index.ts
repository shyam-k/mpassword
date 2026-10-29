/**
 * Background service worker: the only place the vault is ever decrypted.
 *
 * Trust boundaries
 *  - Popup messages are accepted only from this extension's own pages (no tab, our own URL).
 *  - Content-script messages are accepted only from top frames; the page origin always comes from
 *    Chrome's MessageSender, never from the message body. A content script can only ever receive the
 *    credentials for its own origin, and only usernames before the user picks one.
 */
import { fromB64 } from '../shared/crypto';
import { DEFAULT_GENERATOR, generatePassword, checkMasterPassword } from '../shared/generator';
import { ChromeLocalKV } from '../shared/kv';
import type {
  ContentCommand,
  ContentRequest,
  FillData,
  ImportPreview,
  PendingSave,
  PopupRequest,
  Reply,
  Status,
  TabContext,
} from '../shared/messages';
import { originMatches, originOf } from '../shared/origin';
import { buildCsvExport, buildEncryptedExport, parseCsvImport, readEncryptedExport, ImportError } from '../shared/transfer';
import type { Login, LoginInput } from '../shared/types';
import { Vault, VaultError, vaultExists } from '../shared/vault';

const kv = new ChromeLocalKV();
const AUTOLOCK_ALARM = 'mp-autolock';
const LOCKOUT_KEY = 'mp:lockout';
const PENDING_TTL_MS = 2 * 60 * 1000;
const SHORTCUT_CYCLE_MS = 2000;

let vault: Vault | null = null;
let restoring: Promise<void> | null = null;

/** Captured logins waiting for the user's decision, per tab. Memory only. */
const pending = new Map<number, PendingSave & { password: string; tabId: number }>();
/** Parsed imports awaiting confirmation. Memory only. */
const imports = new Map<string, { items: LoginInput[]; source: string; at: number }>();
/** Keyboard shortcut cycling state per tab. */
const cycle = new Map<number, { index: number; at: number }>();

// ---------------------------------------------------------------- vault state

/** After a service-worker restart, pick the key back up from memory-only session storage. */
async function ensureRestored(): Promise<void> {
  if (vault) return;
  if (!restoring) {
    restoring = (async () => {
      const { vk } = await chrome.storage.session.get('vk');
      if (typeof vk === 'string') {
        try {
          vault = await Vault.fromKey(kv, fromB64(vk));
        } catch {
          await chrome.storage.session.remove('vk');
        }
      }
    })().finally(() => {
      restoring = null;
    });
  }
  await restoring;
}

function requireVault(): Vault {
  if (!vault || !vault.unlocked) throw new VaultError('mPassword is locked', 'locked');
  return vault;
}

async function setUnlocked(v: Vault): Promise<void> {
  vault = v;
  // Session storage is held in memory only and cleared when the browser closes.
  await chrome.storage.session.set({ vk: v.exportKey() });
  await touch();
}

async function lock(): Promise<void> {
  if (vault) await vault.lock();
  vault = null;
  for (const p of pending.values()) p.password = '';
  imports.clear();
  cycle.clear();
  await chrome.storage.session.remove('vk');
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  await setBadge(false);
}

/** Any user activity pushes the auto-lock deadline back. */
async function touch(): Promise<void> {
  if (!vault) return;
  const minutes = vault.getSettings().autoLockMinutes;
  await chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: minutes });
  await setBadge(true);
}

async function setBadge(unlocked: boolean): Promise<void> {
  await chrome.action.setTitle({ title: unlocked ? 'mPassword (unlocked)' : 'mPassword (locked)' });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === AUTOLOCK_ALARM) void lock();
});

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'locked') void lock();
});

chrome.runtime.onStartup.addListener(() => void lock());

// ---------------------------------------------------------------- brute-force slow-down

interface Lockout {
  fails: number;
  until: number;
}

async function getLockout(): Promise<Lockout> {
  return (await kv.get<Lockout>(LOCKOUT_KEY)) ?? { fails: 0, until: 0 };
}

async function recordFailure(): Promise<void> {
  const l = await getLockout();
  l.fails += 1;
  // After 5 wrong tries, wait 30 s, doubling each time, up to 1 hour.
  if (l.fails >= 5) l.until = Date.now() + Math.min(3600_000, 30_000 * 2 ** (l.fails - 5));
  await kv.set({ [LOCKOUT_KEY]: l });
}

// ---------------------------------------------------------------- helpers

function withoutSecrets(l: Login) {
  return {
    id: l.id,
    title: l.title,
    url: l.url,
    origin: l.origin,
    username: l.username,
    label: l.label,
    lastUsedAt: l.lastUsedAt,
    updatedAt: l.updatedAt,
  };
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function sendToTab(tabId: number, msg: ContentCommand): Promise<void> {
  await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
}

async function verifyMaster(password: string): Promise<void> {
  // Re-derives the key; throws on a wrong password. Used before exports.
  const test = await Vault.unlock(kv, password).catch((e) => {
    if (e instanceof VaultError && e.code === 'bad-password') throw new VaultError('Master password is wrong', 'bad-password');
    throw e;
  });
  await test.lock();
}

let offscreenReady: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Copy a password to the clipboard and clear it again after a delay',
      })
      .finally(() => {
        offscreenReady = null;
      });
  }
  await offscreenReady;
}

async function copyToClipboard(text: string): Promise<void> {
  const seconds = vault?.getSettings().clipboardClearSeconds ?? 30;
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text, clearAfterMs: seconds * 1000 });
}

function pendingKind(v: Vault, origin: string, username: string, password: string): PendingSave['kind'] | null {
  const same = v.loginsFor(origin).filter((l) => l.origin === origin);
  const match = same.find((l) => l.username === username);
  if (match) return match.password === password ? null : 'update';
  return same.length ? 'another' : 'save';
}

async function commitPending(tabId: number): Promise<Login | null> {
  const p = pending.get(tabId);
  if (!p) return null;
  const v = requireVault();
  const existing = v.loginsFor(p.origin).find((l) => l.origin === p.origin && l.username === p.username);
  const saved = existing
    ? await v.upsert({ ...existing, password: p.password })
    : await v.upsert({ url: p.origin, username: p.username, password: p.password });
  p.password = '';
  pending.delete(tabId);
  return saved;
}

function livePending(tabId: number): (PendingSave & { password: string }) | null {
  const p = pending.get(tabId);
  if (!p) return null;
  if (Date.now() - p.at > PENDING_TTL_MS) {
    p.password = '';
    pending.delete(tabId);
    return null;
  }
  // Re-evaluate the kind now (the vault may have been unlocked since capture).
  if (vault?.unlocked) {
    if (vault.getSettings().neverSave.includes(p.origin)) {
      pending.delete(tabId);
      return null;
    }
    const kind = pendingKind(vault, p.origin, p.username, p.password);
    if (!kind) {
      pending.delete(tabId);
      return null;
    }
    p.kind = kind;
  }
  return p;
}

function publicPending(p: PendingSave | null): PendingSave | null {
  return p ? { origin: p.origin, username: p.username, kind: p.kind, at: p.at } : null;
}

async function fillData(v: Vault, login: Login, origin: string): Promise<FillData> {
  await v.markUsed(login.id);
  return { id: login.id, username: login.username, password: login.password, others: v.loginsFor(origin).length - 1 };
}

// ---------------------------------------------------------------- popup handler

async function handlePopup(req: PopupRequest): Promise<unknown> {
  await ensureRestored();
  switch (req.type) {
    case 'status': {
      const lo = await getLockout();
      const s: Status = {
        exists: await vaultExists(kv),
        unlocked: !!vault?.unlocked,
        lockedOutUntil: lo.until > Date.now() ? lo.until : 0,
        corrupt: vault?.corruptIds.length ?? 0,
      };
      return s;
    }
    case 'create': {
      const check = checkMasterPassword(req.password);
      if (!check.ok) throw new VaultError(check.message, 'invalid');
      await setUnlocked(await Vault.create(kv, req.password));
      return true;
    }
    case 'unlock': {
      const lo = await getLockout();
      if (lo.until > Date.now()) {
        throw new VaultError(`Too many attempts. Try again in ${Math.ceil((lo.until - Date.now()) / 1000)} s`, 'bad-password');
      }
      try {
        await setUnlocked(await Vault.unlock(kv, req.password));
      } catch (e) {
        if (e instanceof VaultError && e.code === 'bad-password') await recordFailure();
        throw e;
      }
      await kv.set({ [LOCKOUT_KEY]: { fails: 0, until: 0 } });
      return true;
    }
    case 'lock':
      await lock();
      return true;
  }

  // Everything below needs an unlocked vault.
  const v = requireVault();
  await touch();
  switch (req.type) {
    case 'list':
      return v.list().map(withoutSecrets);
    case 'get':
      return v.get(req.id);
    case 'save': {
      const { id, url, username, password, title, notes, label, matchSubdomains } = req.login;
      return withoutSecrets(await v.upsert({ id, url, username, password, title, notes, label, matchSubdomains }));
    }
    case 'delete':
      await v.remove(req.id);
      return true;
    case 'setDefault':
      await v.setDefault(req.origin, req.id);
      return true;
    case 'tabContext': {
      const tab = await activeTab();
      const origin = tab?.url ? originOf(tab.url) : null;
      const ctx: TabContext = {
        tabId: tab?.id ?? null,
        origin,
        accounts: origin ? v.summariesFor(origin) : [],
        pending: tab?.id !== undefined ? publicPending(livePending(tab.id)) : null,
      };
      return ctx;
    }
    case 'fillInTab': {
      const tab = await activeTab();
      const origin = tab?.url ? originOf(tab.url) : null;
      const login = v.get(req.id);
      if (!tab?.id || !origin || !originMatches(login.origin, origin, login.matchSubdomains)) {
        throw new VaultError('This login is not for the current site', 'invalid');
      }
      await v.markUsed(login.id);
      await sendToTab(tab.id, { type: 'bg:fill', expectedOrigin: origin, username: login.username, password: login.password });
      return true;
    }
    case 'copy': {
      const l = v.get(req.id);
      await copyToClipboard(req.field === 'password' ? l.password : l.username);
      return true;
    }
    case 'copyText':
      await copyToClipboard(req.text);
      return true;
    case 'generate':
      return generatePassword({ ...DEFAULT_GENERATOR, ...req.options });
    case 'getSettings':
      return v.getSettings();
    case 'updateSettings': {
      const s = await v.updateSettings(req.patch);
      await touch();
      return s;
    }
    case 'removeNeverSave':
      await v.removeNeverSave(req.origin);
      return true;
    case 'changeMaster': {
      const check = checkMasterPassword(req.next);
      if (!check.ok) throw new VaultError(check.message, 'invalid');
      await v.changeMasterPassword(req.current, req.next);
      return true;
    }
    case 'exportEncrypted': {
      await verifyMaster(req.master);
      const check = checkMasterPassword(req.exportPassword);
      if (!check.ok) throw new VaultError(`Export password: ${check.message}`, 'invalid');
      return buildEncryptedExport(v.list(), v.getSettings().defaults, req.exportPassword);
    }
    case 'exportCsv':
      await verifyMaster(req.master);
      return buildCsvExport(v.list());
    case 'importPreview': {
      let items: LoginInput[];
      let skipped = 0;
      let source: string = req.kind;
      if (req.kind === 'mpvault') {
        const payload = await readEncryptedExport(req.text, req.password ?? '');
        items = payload.logins.map((l) => ({
          url: l.url,
          username: l.username,
          password: l.password,
          title: l.title,
          notes: l.notes,
          label: l.label,
          matchSubdomains: !!l.matchSubdomains,
        }));
      } else {
        const r = parseCsvImport(req.text);
        items = r.items;
        skipped = r.skipped;
        source = r.source;
      }
      let added = 0;
      let updated = 0;
      let unchanged = 0;
      for (const it of items) {
        const origin = originOf(it.url);
        const ex = origin ? v.list().find((l) => l.origin === origin && l.username === it.username) : undefined;
        if (!ex) added++;
        else if (ex.password === it.password) unchanged++;
        else updated++;
      }
      const token = crypto.randomUUID();
      imports.clear();
      imports.set(token, { items, source, at: Date.now() });
      const preview: ImportPreview = { token, source, added, updated, unchanged, skipped };
      return preview;
    }
    case 'importCommit': {
      const imp = imports.get(req.token);
      if (!imp || Date.now() - imp.at > 10 * 60 * 1000) throw new ImportError('Import expired, choose the file again');
      imports.delete(req.token);
      let count = 0;
      for (const it of imp.items) {
        const origin = originOf(it.url);
        const ex = origin ? v.list().find((l) => l.origin === origin && l.username === it.username) : undefined;
        if (ex && ex.password === it.password) continue;
        await v.upsert(ex ? { ...ex, ...it, id: ex.id } : it);
        count++;
      }
      return count;
    }
    case 'resolvePending':
      return resolvePending(v, req.tabId, req.action);
  }
}

async function resolvePending(v: Vault, tabId: number, action: 'save' | 'never' | 'dismiss'): Promise<boolean> {
  const p = livePending(tabId);
  if (!p) return false;
  if (action === 'save') await commitPending(tabId);
  else {
    if (action === 'never') await v.addNeverSave(p.origin);
    p.password = '';
    pending.delete(tabId);
  }
  return true;
}

// ---------------------------------------------------------------- content-script handler

async function handleContent(req: ContentRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await ensureRestored();
  const tabId = sender.tab?.id;
  const origin = sender.origin ? originOf(sender.origin) : sender.url ? originOf(sender.url) : null;
  if (tabId === undefined || sender.frameId !== 0 || !origin) throw new Error('Not allowed');

  switch (req.type) {
    case 'cs:captured': {
      if (typeof req.password !== 'string' || !req.password || req.password.length > 1024) return false;
      if (typeof req.username !== 'string' || req.username.length > 512) return false;
      if (vault?.unlocked) {
        if (vault.getSettings().neverSave.includes(origin)) return false;
        if (!pendingKind(vault, origin, req.username, req.password)) return false;
      }
      const prev = pending.get(tabId);
      if (prev) prev.password = '';
      pending.set(tabId, { tabId, origin, username: req.username, password: req.password, kind: 'save', at: Date.now() });
      return true;
    }
    case 'cs:pending': {
      const p = livePending(tabId);
      if (!p || p.origin !== origin) return null;
      return { ...publicPending(p), locked: !vault?.unlocked };
    }
    case 'cs:resolvePending': {
      const p = livePending(tabId);
      if (!p || p.origin !== origin) return false;
      if (req.action === 'dismiss') {
        p.password = '';
        pending.delete(tabId);
        return true;
      }
      return resolvePending(requireVault(), tabId, req.action);
    }
  }

  if (!vault?.unlocked) return { locked: true };
  const v = vault;
  await touch();
  switch (req.type) {
    case 'cs:accounts':
      return { locked: false, accounts: v.summariesFor(origin) };
    case 'cs:fill': {
      const l = v.get(req.id);
      if (!originMatches(l.origin, origin, l.matchSubdomains)) throw new Error('Not allowed');
      return fillData(v, l, origin);
    }
    case 'cs:fillDefault': {
      const list = v.loginsFor(origin);
      if (!list[0]) return null;
      return fillData(v, list[0], origin);
    }
    case 'cs:fillShortcut': {
      const list = v.loginsFor(origin);
      if (!list.length) return null;
      const c = cycle.get(tabId);
      const index = c && Date.now() - c.at < SHORTCUT_CYCLE_MS ? (c.index + 1) % list.length : 0;
      cycle.set(tabId, { index, at: Date.now() });
      return fillData(v, list[index]!, origin);
    }
  }
  return null;
}

// ---------------------------------------------------------------- routing

function isOwnExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.target === 'offscreen') return false;
  if (sender.id !== chrome.runtime.id) return false;

  let work: Promise<unknown>;
  if (msg.type.startsWith('cs:')) {
    if (!sender.tab || isOwnExtensionPage(sender)) return false;
    work = handleContent(msg as ContentRequest, sender);
  } else if (isOwnExtensionPage(sender)) {
    work = handlePopup(msg as PopupRequest);
  } else {
    return false;
  }
  work.then(
    (data) => sendResponse({ ok: true, data } satisfies Reply<unknown>),
    (e: unknown) =>
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : 'Something went wrong',
        code: e instanceof VaultError ? e.code : undefined,
      } satisfies Reply<unknown>),
  );
  return true; // async response
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fill-login' || !tab?.id) return;
  await ensureRestored();
  try {
    await sendToTab(tab.id, vault?.unlocked ? { type: 'bg:shortcut' } : { type: 'bg:locked' });
  } catch {
    /* no content script on this page (e.g. chrome:// pages) */
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const p = pending.get(tabId);
  if (p) p.password = '';
  pending.delete(tabId);
  cycle.delete(tabId);
});

