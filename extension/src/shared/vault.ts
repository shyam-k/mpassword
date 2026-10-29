/**
 * The vault: key hierarchy, encrypted storage of logins, per-site defaults.
 *
 * Master password --Argon2id--> KEK --unwraps--> Vault Key (random, 32 bytes) --seals--> each entry
 *
 * Storage keys:
 *   mp:header      VaultHeader (plaintext public params + wrapped vault key)
 *   mp:meta        { deviceId, clock }   Lamport clock for sync
 *   mp:settings    { rev, s }            encrypted Settings
 *   mp:e:<id>      EntryRecord           encrypted Login or tombstone
 */
import {
  CryptoError,
  deriveKey,
  fromB64,
  newKdfParams,
  openJson,
  randomId,
  randomKey,
  sealJson,
  toB64,
  validateKdfParams,
  wipe,
  type KdfParams,
  type Sealed,
} from './crypto';
import type { KV } from './kv';
import { normaliseUrl, originMatches, originOf } from './origin';
import {
  DEFAULT_SETTINGS,
  HISTORY_LIMIT,
  VAULT_FORMAT,
  VAULT_VERSION,
  type AccountSummary,
  type EntryRecord,
  type Login,
  type LoginInput,
  type Settings,
  type VaultHeader,
} from './types';

const HEADER_KEY = 'mp:header';
const META_KEY = 'mp:meta';
const SETTINGS_KEY = 'mp:settings';
const ENTRY_PREFIX = 'mp:e:';

interface Meta {
  deviceId: string;
  clock: number;
}

interface SettingsRecord {
  rev: number;
  s: Sealed;
}

export function headerAd(vaultId: string, kdf: KdfParams): string {
  return `mpv1|hdr|${vaultId}|${kdf.alg}|${kdf.salt}|${kdf.ops}|${kdf.mem}`;
}
export function entryAd(vaultId: string, id: string, rev: number): string {
  return `mpv1|e|${vaultId}|${id}|${rev}`;
}
function settingsAd(vaultId: string, rev: number): string {
  return `mpv1|s|${vaultId}|${rev}`;
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: 'exists' | 'missing' | 'bad-password' | 'locked' | 'not-found' | 'invalid' | 'corrupt',
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

export async function vaultExists(kv: KV): Promise<boolean> {
  return (await kv.get(HEADER_KEY)) !== undefined;
}

export async function readHeader(kv: KV): Promise<VaultHeader> {
  const h = await kv.get<VaultHeader>(HEADER_KEY);
  if (!h) throw new VaultError('No vault yet', 'missing');
  if (h.format !== VAULT_FORMAT || h.v !== VAULT_VERSION || typeof h.vaultId !== 'string') {
    throw new VaultError('Unknown vault format', 'corrupt');
  }
  validateKdfParams(h.kdf);
  return h;
}

export class Vault {
  private logins = new Map<string, Login>();
  private records = new Map<string, EntryRecord>();
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private settingsRev = 0;
  /** Entries that failed authentication on load (tampered or corrupted). They are kept on disk, never shown. */
  readonly corruptIds: string[] = [];

  private constructor(
    private readonly kv: KV,
    readonly header: VaultHeader,
    private key: Uint8Array | null,
    private meta: Meta,
  ) {}

  // ---------- lifecycle ----------

  static async create(kv: KV, masterPassword: string, kdfOverride?: { ops: number; mem: number }): Promise<Vault> {
    if (await vaultExists(kv)) throw new VaultError('A vault already exists', 'exists');
    const kdf = await newKdfParams(kdfOverride?.ops, kdfOverride?.mem);
    const vaultId = await randomId();
    const vk = await randomKey();
    const kek = await deriveKey(masterPassword, kdf);
    let wrappedKey: Sealed;
    try {
      wrappedKey = await sealJson(kek, toB64(vk), headerAd(vaultId, kdf));
    } finally {
      await wipe(kek);
    }
    const header: VaultHeader = { format: VAULT_FORMAT, v: VAULT_VERSION, vaultId, createdAt: Date.now(), kdf, wrappedKey };
    const meta: Meta = { deviceId: await randomId(8), clock: 0 };
    await kv.set({ [HEADER_KEY]: header, [META_KEY]: meta });
    const vault = new Vault(kv, header, vk, meta);
    await vault.saveSettings();
    return vault;
  }

  /** Unlock with the master password. Throws VaultError('bad-password') on a wrong password or tampered header. */
  static async unlock(kv: KV, masterPassword: string): Promise<Vault> {
    const header = await readHeader(kv);
    const kek = await deriveKey(masterPassword, header.kdf);
    let vk: Uint8Array;
    try {
      const vkB64 = await openJson<string>(kek, header.wrappedKey, headerAd(header.vaultId, header.kdf));
      vk = fromB64(vkB64);
    } catch (e) {
      if (e instanceof CryptoError) throw new VaultError('Wrong master password', 'bad-password');
      throw e;
    } finally {
      await wipe(kek);
    }
    return Vault.open(kv, header, vk);
  }

  /** Re-open with an already-unwrapped vault key (e.g. after the service worker restarts). */
  static async fromKey(kv: KV, vk: Uint8Array): Promise<Vault> {
    const header = await readHeader(kv);
    return Vault.open(kv, header, vk);
  }

  private static async open(kv: KV, header: VaultHeader, vk: Uint8Array): Promise<Vault> {
    const meta = (await kv.get<Meta>(META_KEY)) ?? { deviceId: await randomId(8), clock: 0 };
    const vault = new Vault(kv, header, vk, meta);
    await vault.loadAll();
    return vault;
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** Export the raw vault key so the background can keep it in memory-only session storage. */
  exportKey(): string {
    return toB64(this.requireKey());
  }

  async lock(): Promise<void> {
    await wipe(this.key);
    this.key = null;
    for (const l of this.logins.values()) {
      l.password = '';
      l.history = [];
    }
    this.logins.clear();
    this.records.clear();
  }

  async changeMasterPassword(current: string, next: string): Promise<void> {
    const key = this.requireKey();
    // Verify the current password first.
    const kekOld = await deriveKey(current, this.header.kdf);
    try {
      await openJson<string>(kekOld, this.header.wrappedKey, headerAd(this.header.vaultId, this.header.kdf));
    } catch {
      throw new VaultError('Current master password is wrong', 'bad-password');
    } finally {
      await wipe(kekOld);
    }
    const kdf = await newKdfParams(this.header.kdf.ops, this.header.kdf.mem);
    const kek = await deriveKey(next, kdf);
    try {
      const wrappedKey = await sealJson(kek, toB64(key), headerAd(this.header.vaultId, kdf));
      const header: VaultHeader = { ...this.header, kdf, wrappedKey };
      await this.kv.set({ [HEADER_KEY]: header });
      (this as { header: VaultHeader }).header = header;
    } finally {
      await wipe(kek);
    }
  }

  // ---------- reading ----------

  list(): Login[] {
    this.requireKey();
    return [...this.logins.values()].sort((a, b) => a.title.localeCompare(b.title) || a.username.localeCompare(b.username));
  }

  get(id: string): Login {
    this.requireKey();
    const l = this.logins.get(id);
    if (!l) throw new VaultError('Login not found', 'not-found');
    return l;
  }

  /** Logins that apply to a page origin: the default first, then most recently used. */
  loginsFor(pageOrigin: string): Login[] {
    this.requireKey();
    const def = this.defaultIdFor(pageOrigin);
    return [...this.logins.values()]
      .filter((l) => originMatches(l.origin, pageOrigin, l.matchSubdomains))
      .sort((a, b) => {
        if (a.id === def) return -1;
        if (b.id === def) return 1;
        // Exact-origin matches before subdomain matches.
        const ae = a.origin === pageOrigin ? 0 : 1;
        const be = b.origin === pageOrigin ? 0 : 1;
        if (ae !== be) return ae - be;
        return b.lastUsedAt - a.lastUsedAt || a.username.localeCompare(b.username);
      });
  }

  summariesFor(pageOrigin: string): AccountSummary[] {
    const def = this.defaultIdFor(pageOrigin);
    return this.loginsFor(pageOrigin).map((l) => ({
      id: l.id,
      username: l.username,
      label: l.label,
      title: l.title,
      isDefault: l.id === def,
      lastUsedAt: l.lastUsedAt,
    }));
  }

  /** The default login for an origin: the explicit choice, else the only/oldest exact-origin login. */
  defaultIdFor(pageOrigin: string): string | null {
    this.requireKey();
    const explicit = this.settings.defaults[pageOrigin];
    if (explicit && this.logins.has(explicit)) return explicit;
    const exact = [...this.logins.values()].filter((l) => l.origin === pageOrigin).sort((a, b) => a.createdAt - b.createdAt);
    return exact[0]?.id ?? null;
  }

  getSettings(): Settings {
    this.requireKey();
    return structuredClone(this.settings);
  }

  // ---------- writing ----------

  async upsert(input: LoginInput & { id?: string }): Promise<Login> {
    this.requireKey();
    const url = normaliseUrl(input.url);
    const origin = originOf(url);
    if (!origin) throw new VaultError('Enter a valid http(s) website address', 'invalid');
    if (typeof input.username !== 'string' || typeof input.password !== 'string') {
      throw new VaultError('Username and password must be text', 'invalid');
    }
    if (!input.password) throw new VaultError('Password cannot be empty', 'invalid');
    const now = Date.now();
    const existing = input.id ? this.logins.get(input.id) : undefined;
    if (input.id && !existing) throw new VaultError('Login not found', 'not-found');

    const history = existing ? [...existing.history] : [];
    if (existing && existing.password !== input.password) {
      history.unshift({ password: existing.password, changedAt: now });
      history.length = Math.min(history.length, HISTORY_LIMIT);
    }
    const login: Login = {
      id: existing?.id ?? (await randomId()),
      title: (input.title ?? existing?.title ?? '').trim() || new URL(origin).hostname,
      url,
      origin,
      username: input.username,
      password: input.password,
      notes: input.notes ?? existing?.notes ?? '',
      label: (input.label ?? existing?.label ?? '').trim(),
      matchSubdomains: input.matchSubdomains ?? existing?.matchSubdomains ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: input.lastUsedAt ?? existing?.lastUsedAt ?? 0,
      history,
    };
    await this.persist(login);
    // The first login saved for an origin becomes its default.
    if (!existing && !this.settings.defaults[origin]) {
      this.settings.defaults[origin] = login.id;
      await this.saveSettings();
    }
    return login;
  }

  async markUsed(id: string): Promise<void> {
    const l = this.get(id);
    l.lastUsedAt = Date.now();
    await this.persist(l);
  }

  async remove(id: string): Promise<void> {
    const l = this.get(id);
    const rev = await this.tick();
    const rec: EntryRecord = { id, rev, dev: this.meta.deviceId, upd: Date.now(), del: true };
    await this.kv.set({ [ENTRY_PREFIX + id]: rec });
    this.records.set(id, rec);
    this.logins.delete(id);
    for (const [origin, def] of Object.entries(this.settings.defaults)) {
      if (def === id) delete this.settings.defaults[origin];
    }
    l.password = '';
    await this.saveSettings();
  }

  async setDefault(origin: string, id: string): Promise<void> {
    const l = this.get(id);
    if (!originMatches(l.origin, origin, l.matchSubdomains)) throw new VaultError('That login is not for this site', 'invalid');
    this.settings.defaults[origin] = id;
    await this.saveSettings();
  }

  async updateSettings(patch: Partial<Pick<Settings, 'autoLockMinutes' | 'clipboardClearSeconds'>>): Promise<Settings> {
    this.requireKey();
    if (patch.autoLockMinutes !== undefined) {
      this.settings.autoLockMinutes = clampInt(patch.autoLockMinutes, 1, 240);
    }
    if (patch.clipboardClearSeconds !== undefined) {
      this.settings.clipboardClearSeconds = clampInt(patch.clipboardClearSeconds, 5, 300);
    }
    await this.saveSettings();
    return this.getSettings();
  }

  async addNeverSave(origin: string): Promise<void> {
    this.requireKey();
    if (!this.settings.neverSave.includes(origin)) this.settings.neverSave.push(origin);
    await this.saveSettings();
  }

  async removeNeverSave(origin: string): Promise<void> {
    this.requireKey();
    this.settings.neverSave = this.settings.neverSave.filter((o) => o !== origin);
    await this.saveSettings();
  }

  // ---------- internals ----------

  private requireKey(): Uint8Array {
    if (!this.key) throw new VaultError('Vault is locked', 'locked');
    return this.key;
  }

  private async tick(): Promise<number> {
    this.meta.clock += 1;
    await this.kv.set({ [META_KEY]: this.meta });
    return this.meta.clock;
  }

  private async persist(login: Login): Promise<void> {
    const key = this.requireKey();
    const rev = await this.tick();
    const s = await sealJson(key, login, entryAd(this.header.vaultId, login.id, rev));
    const rec: EntryRecord = { id: login.id, rev, dev: this.meta.deviceId, upd: Date.now(), s };
    await this.kv.set({ [ENTRY_PREFIX + login.id]: rec });
    this.records.set(login.id, rec);
    this.logins.set(login.id, login);
  }

  private async saveSettings(): Promise<void> {
    const key = this.requireKey();
    this.settingsRev = await this.tick();
    const s = await sealJson(key, this.settings, settingsAd(this.header.vaultId, this.settingsRev));
    const rec: SettingsRecord = { rev: this.settingsRev, s };
    await this.kv.set({ [SETTINGS_KEY]: rec });
  }

  private async loadAll(): Promise<void> {
    const key = this.requireKey();
    const all = await this.kv.getAll();
    const sr = all[SETTINGS_KEY] as SettingsRecord | undefined;
    if (sr) {
      try {
        this.settings = { ...DEFAULT_SETTINGS, ...(await openJson<Settings>(key, sr.s, settingsAd(this.header.vaultId, sr.rev))) };
        this.settingsRev = sr.rev;
      } catch {
        // Fail closed for the settings record but keep the vault usable with defaults.
        this.corruptIds.push('settings');
      }
    }
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(ENTRY_PREFIX)) continue;
      const rec = v as EntryRecord;
      if (!rec || rec.id !== k.slice(ENTRY_PREFIX.length)) {
        this.corruptIds.push(k.slice(ENTRY_PREFIX.length));
        continue;
      }
      this.records.set(rec.id, rec);
      if (rec.del || !rec.s) continue;
      let login: Login;
      try {
        login = await openJson<Login>(key, rec.s, entryAd(this.header.vaultId, rec.id, rec.rev));
      } catch {
        this.corruptIds.push(rec.id);
        continue;
      }
      if (login.id !== rec.id) {
        this.corruptIds.push(rec.id);
        continue;
      }
      this.logins.set(login.id, login);
    }
  }
}

function clampInt(n: number, min: number, max: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}
