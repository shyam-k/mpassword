import { describe, expect, it } from 'vitest';
import { buildCsvExport, buildEncryptedExport, parseCsvImport, readEncryptedExport } from '../src/shared/transfer';
import { MemoryKV } from '../src/shared/kv';
import { Vault } from '../src/shared/vault';
import { parseCsv } from '../src/shared/csv';

const FAST = { ops: 2, mem: 16 * 1024 * 1024 };

describe('csv', () => {
  it('parses quotes, commas and newlines', () => {
    expect(parseCsv('a,"b,c","d ""q""\nx"\r\n1,2,3\n')).toEqual([
      ['a', 'b,c', 'd "q"\nx'],
      ['1', '2', '3'],
    ]);
  });

  it('imports Chrome CSV', () => {
    const r = parseCsvImport('name,url,username,password,note\nGitHub,https://github.com/login,me,"p,w",hi\nbad,,x,y,\n');
    expect(r.source).toBe('chrome');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ url: 'https://github.com/login', username: 'me', password: 'p,w', notes: 'hi' });
    expect(r.skipped).toBe(1);
  });

  it('imports Bitwarden CSV and skips notes items', () => {
    const csv =
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
      ',,login,Site,,,,https://a.com,u,p,\n,,note,Secret note,text,,,,,,\n';
    const r = parseCsvImport(csv);
    expect(r.source).toBe('bitwarden');
    expect(r.items).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });

  it('round-trips through our own CSV export', async () => {
    const v = await Vault.create(new MemoryKV(), 'master password 123!', FAST);
    await v.upsert({ url: 'https://a.com', username: 'u', password: 'p"1,2', label: 'Work' });
    const r = parseCsvImport(buildCsvExport(v.list()));
    expect(r.items[0]).toMatchObject({ username: 'u', password: 'p"1,2', label: 'Work' });
  });
});

describe('encrypted export', () => {
  it('round-trips and rejects the wrong password or a modified file', async () => {
    const v = await Vault.create(new MemoryKV(), 'master password 123!', FAST);
    await v.upsert({ url: 'https://a.com', username: 'u', password: 'secret-1' });
    const text = await buildEncryptedExport(v.list(), {}, 'export password 99', FAST);
    expect(text).not.toContain('secret-1');
    const back = await readEncryptedExport(text, 'export password 99');
    expect(back.logins[0]!.password).toBe('secret-1');
    await expect(readEncryptedExport(text, 'nope nope nope')).rejects.toThrow(/Wrong export password/);
    const f = JSON.parse(text);
    f.count = 2;
    await expect(readEncryptedExport(JSON.stringify(f), 'export password 99')).rejects.toThrow();
  });
});
