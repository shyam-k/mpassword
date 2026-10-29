/** Minimal key-value storage interface, so the vault can be tested without Chrome. */
export interface KV {
  get<T = unknown>(key: string): Promise<T | undefined>;
  getAll(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export class ChromeLocalKV implements KV {
  async get<T>(key: string): Promise<T | undefined> {
    const r = await chrome.storage.local.get(key);
    return r[key] as T | undefined;
  }
  async getAll(): Promise<Record<string, unknown>> {
    return chrome.storage.local.get(null);
  }
  async set(items: Record<string, unknown>): Promise<void> {
    await chrome.storage.local.set(items);
  }
  async remove(keys: string[]): Promise<void> {
    await chrome.storage.local.remove(keys);
  }
}

export class MemoryKV implements KV {
  data: Record<string, unknown> = {};
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data[key];
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async getAll(): Promise<Record<string, unknown>> {
    return structuredClone(this.data);
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v);
  }
  async remove(keys: string[]): Promise<void> {
    for (const k of keys) delete this.data[k];
  }
}
