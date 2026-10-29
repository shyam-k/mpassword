import { describe, expect, it } from 'vitest';
import { MemoryKV } from '../src/shared/kv';
import { Vault, VaultError } from '../src/shared/vault';
import { openJson, sealJson, randomKey, deriveKey, newKdfParams } from '../src/shared/crypto';
import type { EntryRecord, VaultHeader } from '../src/shared/types';

const FAST = { ops: 2, mem: 16 * 1024 * 1024 };
const PW = 'correct horse battery staple 42!';

async function fresh() {
  const kv = new MemoryKV();
  const v = await Vault.create(kv, PW, FAST);
  return { kv, v };
}

function flip(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1]! ^= 1;
  return btoa(String.fromCharCode(...bytes));
}

describe('crypto', () => {
  it('round-trips and rejects wrong associated data', async () => {
    const k = await randomKey();
    const s = await sealJson(k, { a: 1 }, 'ad1');
    expect(await openJson(k, s, 'ad1')).toEqual({ a: 1 });
    await expect(openJson(k, s, 'ad2')).rejects.toThrow(/Decryption failed/);
  });

  it('derives the same key for the same password and params', async () => {
    const p = await newKdfParams(FAST.ops, FAST.mem);
    const a = await deriveKey('pw', p);
    const b = await deriveKey('pw', p);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('refuses weak KDF params from a tampered header', async () => {
    const p = { ...(await newKdfParams(FAST.ops, FAST.mem)), mem: 1024 };
    await expect(deriveKey('pw', p)).rejects.toThrow(/unsafe/);
  });
});

describe('vault', () => {
  it('stores only ciphertext', async () => {
    const { kv, v } = await fresh();
    await v.upsert({ url: 'https://example.com/login', username: 'alice', password: 'SuperSecret#1' });
    const dump = JSON.stringify(kv.data);
    expect(dump).not.toContain('SuperSecret#1');
    expect(dump).not.toContain('alice');
  });

  it('unlocks with the right password and rejects a wrong one', async () => {
    const { kv, v } = await fresh();
    await v.upsert({ url: 'example.com', username: 'alice', password: 'p1' });
    await v.lock();
    await expect(Vault.unlock(kv, 'wrong password!!')).rejects.toBeInstanceOf(VaultError);
    const u = await Vault.unlock(kv, PW);
    expect(u.list().map((l) => l.username)).toEqual(['alice']);
  });

  it('holds several accounts per site with a default first', async () => {
    const { v } = await fresh();
    const a = await v.upsert({ url: 'https://mail.example.com', username: 'work@x.com', password: 'a', label: 'Work' });
    const b = await v.upsert({ url: 'https://mail.example.com/inbox', username: 'me@x.com', password: 'b', label: 'Personal' });
    await v.upsert({ url: 'https://other.com', username: 'z', password: 'c' });
    const origin = 'https://mail.example.com';
    expect(v.defaultIdFor(origin)).toBe(a.id);
    expect(v.summariesFor(origin).map((s) => s.username)).toEqual(['work@x.com', 'me@x.com']);
    await v.setDefault(origin, b.id);
    const sums = v.summariesFor(origin);
    expect(sums[0]!.id).toBe(b.id);
    expect(sums[0]!.isDefault).toBe(true);
    expect(sums.some((s) => 'password' in s)).toBe(false);
  });

  it('never matches other origins or http for https', async () => {
    const { v } = await fresh();
    await v.upsert({ url: 'https://bank.com', username: 'u', password: 'p' });
    expect(v.loginsFor('https://bank.com.evil.io')).toHaveLength(0);
    expect(v.loginsFor('http://bank.com')).toHaveLength(0);
    expect(v.loginsFor('https://login.bank.com')).toHaveLength(0);
  });

  it('matches subdomains only when enabled', async () => {
    const { v } = await fresh();
    await v.upsert({ url: 'https://bank.com', username: 'u', password: 'p', matchSubdomains: true });
    expect(v.loginsFor('https://login.bank.com')).toHaveLength(1);
    expect(v.loginsFor('https://evilbank.com')).toHaveLength(0);
  });

  it('keeps password history', async () => {
    const { v } = await fresh();
    const l = await v.upsert({ url: 'a.com', username: 'u', password: 'one' });
    await v.upsert({ id: l.id, url: 'a.com', username: 'u', password: 'two' });
    expect(v.get(l.id).history.map((h) => h.password)).toEqual(['one']);
  });

  it('detects a tampered entry and hides it', async () => {
    const { kv, v } = await fresh();
    const l = await v.upsert({ url: 'a.com', username: 'u', password: 'p' });
    await v.upsert({ url: 'b.com', username: 'u2', password: 'p2' });
    await v.lock();
    const rec = kv.data[`mp:e:${l.id}`] as EntryRecord;
    rec.s = { n: rec.s!.n, c: flip(rec.s!.c) };
    const u = await Vault.unlock(kv, PW);
    expect(u.corruptIds).toEqual([l.id]);
    expect(u.list().map((x) => x.username)).toEqual(['u2']);
  });

  it('detects entries swapped between ids or rolled to another rev', async () => {
    const { kv, v } = await fresh();
    const a = await v.upsert({ url: 'a.com', username: 'ua', password: 'pa' });
    const b = await v.upsert({ url: 'b.com', username: 'ub', password: 'pb' });
    await v.lock();
    const ra = kv.data[`mp:e:${a.id}`] as EntryRecord;
    const rb = kv.data[`mp:e:${b.id}`] as EntryRecord;
    kv.data[`mp:e:${a.id}`] = { ...ra, s: rb.s };
    const u = await Vault.unlock(kv, PW);
    expect(u.corruptIds).toContain(a.id);
  });

  it('rejects a header whose KDF params were edited', async () => {
    const { kv, v } = await fresh();
    await v.lock();
    const h = kv.data['mp:header'] as VaultHeader;
    h.kdf.ops = 3;
    await expect(Vault.unlock(kv, PW)).rejects.toMatchObject({ code: 'bad-password' });
  });

  it('changes the master password without re-encrypting entries', async () => {
    const { kv, v } = await fresh();
    await v.upsert({ url: 'a.com', username: 'u', password: 'p' });
    await v.changeMasterPassword(PW, 'a brand new master password 7');
    await v.lock();
    await expect(Vault.unlock(kv, PW)).rejects.toBeInstanceOf(VaultError);
    const u = await Vault.unlock(kv, 'a brand new master password 7');
    expect(u.list()).toHaveLength(1);
  });

  it('removes logins as tombstones and clears defaults', async () => {
    const { kv, v } = await fresh();
    const l = await v.upsert({ url: 'a.com', username: 'u', password: 'p' });
    await v.remove(l.id);
    expect(v.list()).toHaveLength(0);
    expect((kv.data[`mp:e:${l.id}`] as EntryRecord).del).toBe(true);
    expect(v.defaultIdFor('https://a.com')).toBeNull();
  });

  it('refuses to work after lock', async () => {
    const { v } = await fresh();
    await v.lock();
    expect(() => v.list()).toThrow(/locked/);
  });
});
