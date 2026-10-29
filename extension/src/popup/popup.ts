/** Popup UI. Plain DOM (no framework) to keep dependencies minimal; all text is set with textContent. */
import type { ImportPreview, PendingSave, PopupRequest, Reply, Status, TabContext } from '../shared/messages';
import type { Login, Settings } from '../shared/types';
import { checkMasterPassword, estimateBits, DEFAULT_GENERATOR, type GeneratorOptions } from '../shared/generator';

type Summary = Pick<Login, 'id' | 'title' | 'url' | 'origin' | 'username' | 'label' | 'lastUsedAt' | 'updatedAt'>;

const app = document.getElementById('app')!;
const isFull = new URLSearchParams(location.search).has('full');
if (isFull) document.body.classList.add('full');

async function call<T>(req: PopupRequest): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(req)) as Reply<T> | undefined;
  if (!reply) throw new Error('mPassword background is not responding');
  if (!reply.ok) {
    const err = new Error(reply.error) as Error & { code?: string };
    err.code = reply.code;
    throw err;
  }
  return reply.data;
}

// ------------------------------------------------------------------ tiny DOM helper

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (k in e && typeof v !== 'string') (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const ICONS: Record<string, string> = {
  logo: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.2"/><circle cx="15.5" cy="15.5" r="1.2"/><circle cx="15.5" cy="8.5" r="1.2"/><circle cx="8.5" cy="15.5" r="1.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  tab: '<path d="M14 3h7v7M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
};
function icon(name: string): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name] ?? ''; // static, trusted markup only
  return s;
}
function iconBtn(name: string, label: string, onClick: () => void): HTMLButtonElement {
  return h('button', { class: 'iconbtn', title: label, 'aria-label': label, onclick: onClick }, icon(name));
}

function render(...nodes: Child[]): void {
  app.replaceChildren(...(nodes.filter(Boolean) as Node[]));
}

function flash(target: HTMLElement, text: string, cls = 'ok'): void {
  target.className = cls;
  target.textContent = text;
  setTimeout(() => {
    if (target.textContent === text) target.textContent = '';
  }, 2500);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function strengthMeter(input: HTMLInputElement): HTMLElement {
  const bar = h('i');
  const meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, bar);
  const update = () => {
    const bits = estimateBits(input.value);
    const pct = Math.min(100, Math.round((bits / 100) * 100));
    bar.style.width = `${pct}%`;
    bar.style.background = bits >= 80 ? 'var(--good)' : bits >= 60 ? 'var(--warn)' : 'var(--danger)';
  };
  input.addEventListener('input', update);
  return meter;
}

// ------------------------------------------------------------------ state

type View = 'site' | 'all' | 'generate' | 'settings';
let view: View = 'site';
let ctx: TabContext = { tabId: null, origin: null, accounts: [], pending: null };

function header(extra: Child[] = []): HTMLElement {
  return h(
    'header',
    {},
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('logo')), 'mPassword'),
    ...extra,
  );
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  let status: Status;
  try {
    status = await call<Status>({ type: 'status' });
  } catch (e) {
    render(h('div', { class: 'center' }, h('p', { class: 'error', text: errorText(e) })));
    return;
  }
  if (!status.exists) return showSetup();
  if (!status.unlocked) return showUnlock(status);
  if (location.hash === '#settings') view = 'settings';
  await showMain(status);
}

// ------------------------------------------------------------------ setup

function showSetup(): void {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', id: 'master', autofocus: true });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', id: 'master2' });
  const ack = h('input', { type: 'checkbox', id: 'ack' });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Create vault' });
  const form = h(
    'form',
    {
      class: 'center',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const check = checkMasterPassword(pw.value);
        if (!check.ok) return flash(err, check.message, 'error');
        if (pw.value !== pw2.value) return flash(err, 'The two passwords do not match.', 'error');
        if (!ack.checked) return flash(err, 'Please confirm you understand it cannot be recovered.', 'error');
        btn.disabled = true;
        btn.textContent = 'Creating…';
        try {
          await call({ type: 'create', password: pw.value });
          pw.value = pw2.value = '';
          await boot();
        } catch (e2) {
          btn.disabled = false;
          btn.textContent = 'Create vault';
          flash(err, errorText(e2), 'error');
        }
      },
    },
    h('h1', { text: 'Create your vault' }),
    h('p', { class: 'muted', text: 'Choose a master password. It encrypts everything and never leaves this device.' }),
    h('label', {}, 'Master password', pw),
    strengthMeter(pw),
    h('label', {}, 'Repeat master password', pw2),
    h('label', { class: 'check' }, ack, 'I understand that a forgotten master password cannot be recovered.'),
    err,
    btn,
    h('p', { class: 'muted small', text: 'Tip: four or five random words with a number make a strong, memorable password.' }),
  );
  render(header(), form);
  pw.focus();
}

// ------------------------------------------------------------------ unlock

function showUnlock(status: Status): void {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', id: 'unlock-password', autofocus: true });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Unlock' });
  if (status.lockedOutUntil) flash(err, `Too many attempts. Try again in ${Math.ceil((status.lockedOutUntil - Date.now()) / 1000)} s`, 'error');
  const form = h(
    'form',
    {
      class: 'center',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        btn.disabled = true;
        btn.textContent = 'Unlocking…';
        try {
          await call({ type: 'unlock', password: pw.value });
          pw.value = '';
          await boot();
        } catch (e2) {
          btn.disabled = false;
          btn.textContent = 'Unlock';
          pw.select();
          flash(err, errorText(e2), 'error');
        }
      },
    },
    h('h1', { text: 'Unlock mPassword' }),
    h('label', {}, 'Master password', pw),
    err,
    btn,
  );
  render(header(), form);
  pw.focus();
}

// ------------------------------------------------------------------ main

async function showMain(status?: Status): Promise<void> {
  try {
    ctx = await call<TabContext>({ type: 'tabContext' });
  } catch (e) {
    if ((e as { code?: string }).code === 'locked') return boot();
    throw e;
  }
  if (!ctx.origin && view === 'site') view = 'all';
  const tabs: [View, string][] = [
    ...(ctx.origin ? ([['site', 'This site']] as [View, string][]) : []),
    ['all', 'All logins'],
    ['generate', 'Generator'],
    ['settings', 'Settings'],
  ];
  const nav = h(
    'nav',
    { role: 'tablist' },
    ...tabs.map(([v, label]) =>
      h('button', {
        role: 'tab',
        'aria-selected': String(view === v),
        text: label,
        onclick: () => {
          view = v;
          void showMain();
        },
      }),
    ),
  );
  const body = h('div', { class: 'body' });
  render(
    header([
      !isFull && iconBtn('tab', 'Open in a tab', () => void chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1') })),
      iconBtn('lock', 'Lock now', async () => {
        await call({ type: 'lock' });
        await boot();
      }),
    ]),
    nav,
    body,
  );
  if (status?.corrupt) {
    body.append(
      h('div', { class: 'banner danger' }, h('p', { text: `${status.corrupt} stored item(s) failed integrity checks and are hidden. Restore from a backup if needed.` })),
    );
  }
  if (ctx.pending && ctx.tabId !== null) body.append(pendingBanner(ctx.pending, ctx.tabId));
  if (view === 'site') body.append(siteView());
  else if (view === 'all') body.append(await allView());
  else if (view === 'generate') body.append(generatorView());
  else body.append(await settingsView());
}

function pendingBanner(p: PendingSave, tabId: number): HTMLElement {
  const title = p.kind === 'update' ? 'Update saved password?' : p.kind === 'another' ? 'Save as another account?' : 'Save this login?';
  const act = (action: 'save' | 'never' | 'dismiss') => async () => {
    await call({ type: 'resolvePending', tabId, action });
    await showMain();
  };
  return h(
    'div',
    { class: 'banner info' },
    h('div', {}, h('strong', { text: title }), h('div', { class: 'sub', text: `${p.username || '(no username)'} on ${hostOf(p.origin)}` })),
    h(
      'div',
      { class: 'row-actions' },
      p.kind !== 'update' && h('button', { class: 'btn sm', text: 'Never', onclick: act('never') }),
      h('button', { class: 'btn sm', text: 'Not now', onclick: act('dismiss') }),
      h('button', { class: 'btn sm primary', text: p.kind === 'update' ? 'Update' : 'Save', onclick: act('save') }),
    ),
  );
}

function siteView(): HTMLElement {
  const origin = ctx.origin!;
  const wrap = h('div', { class: 'body', style: 'padding:0' });
  const msg = h('div', { class: 'ok' });
  wrap.append(
    h(
      'div',
      { class: 'field' },
      h('div', { class: 'grow' }, h('h2', { text: hostOf(origin) }), h('div', { class: 'sub', text: `${ctx.accounts.length} saved account(s)` })),
      h('button', { class: 'btn sm', onclick: () => showEdit(null, origin) }, 'Add'),
    ),
  );
  if (!ctx.accounts.length) {
    wrap.append(h('div', { class: 'empty', text: 'No logins for this site yet. Sign in and mPassword will offer to save it.' }));
    return wrap;
  }
  const list = h('div', { class: 'list' });
  for (const a of ctx.accounts) {
    const star = h('button', {
      class: `star ${a.isDefault ? 'on' : ''}`,
      title: a.isDefault ? 'Default for this site' : 'Make default for this site',
      'aria-label': a.isDefault ? 'Default for this site' : 'Make default for this site',
      text: a.isDefault ? '★' : '☆',
      onclick: async () => {
        await call({ type: 'setDefault', origin, id: a.id });
        await showMain();
      },
    });
    list.append(
      h(
        'div',
        { class: 'item' },
        star,
        h(
          'div',
          { class: 'grow click', style: 'cursor:pointer', onclick: () => void openEdit(a.id) },
          h('div', { class: 'name' }, a.username || '(no username)', a.label ? h('span', { class: 'tag', text: a.label }) : null),
          h('div', { class: 'sub', text: a.isDefault ? 'Default · fills first' : a.title }),
        ),
        iconBtn('copy', 'Copy password', async () => {
          await call({ type: 'copy', id: a.id, field: 'password' });
          flash(msg, 'Password copied. Clipboard clears automatically.');
        }),
        h('button', {
          class: 'btn sm primary',
          text: 'Fill',
          onclick: async () => {
            try {
              await call({ type: 'fillInTab', id: a.id });
              window.close();
            } catch (e) {
              flash(msg, errorText(e), 'error');
            }
          },
        }),
      ),
    );
  }
  wrap.append(list, msg);
  return wrap;
}

async function allView(): Promise<HTMLElement> {
  const all = await call<Summary[]>({ type: 'list' });
  const search = h('input', { type: 'search', placeholder: 'Search sites, usernames, labels', 'aria-label': 'Search' });
  const list = h('div', { class: 'list' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const items = all.filter((l) => !q || `${l.title} ${l.origin} ${l.username} ${l.label}`.toLowerCase().includes(q));
    list.replaceChildren(
      ...(items.length
        ? items.map((l) =>
            h(
              'div',
              { class: 'item click', onclick: () => void openEdit(l.id) },
              h('div', { class: 'avatar', text: (l.title || hostOf(l.origin)).slice(0, 1) }),
              h(
                'div',
                { class: 'grow' },
                h('div', { class: 'name' }, l.title || hostOf(l.origin), l.label ? h('span', { class: 'tag', text: l.label }) : null),
                h('div', { class: 'sub', text: `${l.username || '(no username)'} · ${hostOf(l.origin)}` }),
              ),
            ),
          )
        : [h('div', { class: 'empty', text: all.length ? 'No matches.' : 'Your vault is empty.' })]),
    );
  };
  search.addEventListener('input', draw);
  draw();
  setTimeout(() => search.focus(), 0);
  return h(
    'div',
    { class: 'body', style: 'padding:0' },
    h('div', { class: 'field' }, search, h('button', { class: 'btn', onclick: () => showEdit(null, ctx.origin) }, 'Add')),
    list,
  );
}

// ------------------------------------------------------------------ edit

async function openEdit(id: string): Promise<void> {
  const login = await call<Login>({ type: 'get', id });
  showEdit(login, null);
}

function showEdit(login: Login | null, origin: string | null): void {
  const title = h('input', { type: 'text', value: login?.title ?? '', placeholder: 'e.g. GitHub' });
  const url = h('input', { type: 'url', value: login?.url ?? origin ?? '', placeholder: 'https://example.com', required: true });
  const username = h('input', { type: 'text', value: login?.username ?? '', autocomplete: 'off' });
  const password = h('input', { type: 'password', value: login?.password ?? '', autocomplete: 'new-password', class: 'mono', required: true });
  const label = h('input', { type: 'text', value: login?.label ?? '', placeholder: 'e.g. Work, Personal' });
  const notes = h('textarea', {});
  notes.value = login?.notes ?? '';
  const sub = h('input', { type: 'checkbox', checked: !!login?.matchSubdomains });
  const err = h('div', { class: 'error' });
  const confirmDelete = h('div', { class: 'banner danger', style: 'display:none' });

  const toggle = iconBtn('eye', 'Show or hide password', () => {
    password.type = password.type === 'password' ? 'text' : 'password';
  });
  const gen = iconBtn('dice', 'Generate a strong password', async () => {
    password.value = await call<string>({ type: 'generate', options: loadGenOptions() });
    password.type = 'text';
    password.dispatchEvent(new Event('input'));
  });
  const copyBtn = iconBtn('copy', 'Copy password', async () => {
    await call({ type: 'copyText', text: password.value });
    flash(err, 'Copied. Clipboard clears automatically.');
  });

  const history = login?.history?.length
    ? h(
        'details',
        {},
        h('summary', { class: 'muted small', text: `Password history (${login.history.length})` }),
        ...login.history.map((hi) =>
          h(
            'div',
            { class: 'hist' },
            h('span', { class: 'mono', text: '•'.repeat(10) }),
            h('span', { class: 'muted', text: new Date(hi.changedAt).toLocaleDateString() }),
            h('button', {
              class: 'btn sm',
              text: 'Copy',
              onclick: async () => {
                await call({ type: 'copyText', text: hi.password });
                flash(err, 'Old password copied.');
              },
            }),
          ),
        ),
      )
    : null;

  const form = h(
    'form',
    {
      class: 'body',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        try {
          await call({
            type: 'save',
            login: {
              id: login?.id,
              title: title.value,
              url: url.value,
              username: username.value,
              password: password.value,
              label: label.value,
              notes: notes.value,
              matchSubdomains: sub.checked,
            },
          });
          await showMain();
        } catch (e2) {
          flash(err, errorText(e2), 'error');
        }
      },
    },
    h('label', {}, 'Website', url),
    h('label', {}, 'Title', title),
    h('label', {}, 'Username or email', username),
    h('label', {}, 'Password', h('div', { class: 'field' }, password, toggle, gen, copyBtn)),
    strengthMeter(password),
    h('label', {}, 'Account label (shown in the picker)', label),
    h('label', {}, 'Notes', notes),
    h('label', { class: 'check' }, sub, 'Also offer on subdomains of this site'),
    history,
    err,
    confirmDelete,
    h(
      'div',
      { class: 'row-actions' },
      login &&
        h('button', {
          type: 'button',
          class: 'btn danger',
          text: 'Delete',
          onclick: () => {
            confirmDelete.style.display = 'flex';
            confirmDelete.replaceChildren(
              h('p', { text: `Delete ${login.username || 'this login'} for ${hostOf(login.origin)}? This cannot be undone.` }),
              h(
                'div',
                { class: 'row-actions' },
                h('button', { type: 'button', class: 'btn sm', text: 'Cancel', onclick: () => (confirmDelete.style.display = 'none') }),
                h('button', {
                  type: 'button',
                  class: 'btn sm primary',
                  text: 'Delete',
                  onclick: async () => {
                    await call({ type: 'delete', id: login.id });
                    await showMain();
                  },
                }),
              ),
            );
          },
        }),
      h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => void showMain() }),
      h('button', { type: 'submit', class: 'btn primary', text: 'Save' }),
    ),
  );
  password.dispatchEvent(new Event('input'));
  render(
    header([iconBtn('back', 'Back', () => void showMain())]),
    h('div', { class: 'body', style: 'padding-bottom:0' }, h('h1', { text: login ? 'Edit login' : 'Add login' })),
    form,
  );
  (login ? password : url.value ? username : url).focus();
}

// ------------------------------------------------------------------ generator

function loadGenOptions(): GeneratorOptions {
  try {
    return { ...DEFAULT_GENERATOR, ...JSON.parse(localStorage.getItem('mp-gen') ?? '{}') };
  } catch {
    return { ...DEFAULT_GENERATOR };
  }
}

function generatorView(): HTMLElement {
  const opts = loadGenOptions();
  const out = h('div', { class: 'gen-out mono', 'aria-live': 'polite' });
  const lenLabel = h('span', { text: String(opts.length) });
  const msg = h('div', { class: 'ok' });
  const regen = async () => {
    try {
      localStorage.setItem('mp-gen', JSON.stringify(opts));
    } catch {
      /* ignore */
    }
    out.textContent = await call<string>({ type: 'generate', options: opts });
  };
  const range = h('input', { type: 'range', min: '8', max: '64', value: String(opts.length) });
  range.addEventListener('input', () => {
    opts.length = Number(range.value);
    lenLabel.textContent = range.value;
    void regen();
  });
  const box = (key: 'lower' | 'upper' | 'digits' | 'symbols' | 'avoidAmbiguous', text: string) => {
    const c = h('input', { type: 'checkbox', checked: opts[key] });
    c.addEventListener('change', () => {
      opts[key] = c.checked;
      void regen();
    });
    return h('label', { class: 'check' }, c, text);
  };
  void regen();
  return h(
    'div',
    { class: 'section' },
    out,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', text: 'New', onclick: () => void regen() }),
      h('button', {
        class: 'btn primary',
        text: 'Copy',
        onclick: async () => {
          await call({ type: 'copyText', text: out.textContent ?? '' });
          flash(msg, 'Copied. Clipboard clears automatically.');
        },
      }),
    ),
    msg,
    h('label', {}, h('span', {}, 'Length: ', lenLabel), range),
    box('lower', 'Lowercase a–z'),
    box('upper', 'Uppercase A–Z'),
    box('digits', 'Digits 0–9'),
    box('symbols', 'Symbols !@#…'),
    box('avoidAmbiguous', 'Avoid look-alikes (l, 1, O, 0)'),
  );
}

// ------------------------------------------------------------------ settings, export, import

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function settingsView(): Promise<HTMLElement> {
  const s = await call<Settings>({ type: 'getSettings' });
  const wrap = h('div', { class: 'body', style: 'padding:0' });

  // General
  const autoLock = h('input', { type: 'number', min: '1', max: '240', value: String(s.autoLockMinutes) });
  const clip = h('input', { type: 'number', min: '5', max: '300', value: String(s.clipboardClearSeconds) });
  const genMsg = h('div', { class: 'ok' });
  wrap.append(
    h(
      'div',
      { class: 'section' },
      h('h2', { text: 'Security' }),
      h('label', {}, 'Auto-lock after (minutes idle)', autoLock),
      h('label', {}, 'Clear copied passwords after (seconds)', clip),
      h('div', { class: 'row-actions' },
        genMsg,
        h('button', {
          class: 'btn',
          text: 'Save',
          onclick: async () => {
            try {
              await call({ type: 'updateSettings', patch: { autoLockMinutes: Number(autoLock.value), clipboardClearSeconds: Number(clip.value) } });
              flash(genMsg, 'Saved');
            } catch (e) {
              flash(genMsg, errorText(e), 'error');
            }
          },
        }),
      ),
    ),
  );

  // Never-save list
  if (s.neverSave.length) {
    wrap.append(
      h(
        'div',
        { class: 'section' },
        h('h2', { text: 'Never offer to save on' }),
        ...s.neverSave.map((o) =>
          h('div', { class: 'field' }, h('span', { class: 'grow', text: hostOf(o) }),
            h('button', {
              class: 'btn sm',
              text: 'Remove',
              onclick: async () => {
                await call({ type: 'removeNeverSave', origin: o });
                await showMain();
              },
            })),
        ),
      ),
    );
  }

  // Change master password
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const nxt = h('input', { type: 'password', autocomplete: 'new-password' });
  const nxt2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const cmMsg = h('div', { class: 'error' });
  wrap.append(
    h(
      'details',
      { class: 'section' },
      h('summary', {}, h('strong', { text: 'Change master password' })),
      h('label', {}, 'Current master password', cur),
      h('label', {}, 'New master password', nxt),
      strengthMeter(nxt),
      h('label', {}, 'Repeat new master password', nxt2),
      cmMsg,
      h('div', { class: 'row-actions' },
        h('button', {
          class: 'btn primary',
          text: 'Change',
          onclick: async () => {
            if (nxt.value !== nxt2.value) return flash(cmMsg, 'New passwords do not match.', 'error');
            try {
              await call({ type: 'changeMaster', current: cur.value, next: nxt.value });
              cur.value = nxt.value = nxt2.value = '';
              flash(cmMsg, 'Master password changed.');
            } catch (e) {
              flash(cmMsg, errorText(e), 'error');
            }
          },
        })),
    ),
  );

  // Export
  const exMaster = h('input', { type: 'password', autocomplete: 'current-password' });
  const exPw = h('input', { type: 'password', autocomplete: 'new-password' });
  const exPw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const csvAck = h('input', { type: 'checkbox' });
  const exMsg = h('div', { class: 'error' });
  const stamp = new Date().toISOString().slice(0, 10);
  wrap.append(
    h(
      'details',
      { class: 'section' },
      h('summary', {}, h('strong', { text: 'Export' })),
      h('p', { class: 'muted small', text: 'The encrypted .mpvault backup uses its own export password. Keep that password somewhere safe; without it the file cannot be opened.' }),
      h('label', {}, 'Your master password (to confirm it is you)', exMaster),
      h('label', {}, 'Export password for the file', exPw),
      strengthMeter(exPw),
      h('label', {}, 'Repeat export password', exPw2),
      exMsg,
      h('div', { class: 'row-actions' },
        h('button', {
          class: 'btn primary',
          text: 'Download encrypted backup',
          onclick: async () => {
            if (exPw.value !== exPw2.value) return flash(exMsg, 'Export passwords do not match.', 'error');
            try {
              const text = await call<string>({ type: 'exportEncrypted', master: exMaster.value, exportPassword: exPw.value });
              download(`mpassword-backup-${stamp}.mpvault`, text, 'application/json');
              exMaster.value = exPw.value = exPw2.value = '';
              flash(exMsg, 'Backup downloaded.');
            } catch (e) {
              flash(exMsg, errorText(e), 'error');
            }
          },
        })),
      h('div', { class: 'banner warn' },
        h('p', { text: 'Plaintext CSV: anyone who gets this file can read every password. Use it only to move to another password manager, then delete it.' }),
        h('label', { class: 'check', style: 'color:inherit' }, csvAck, 'I understand the file is not encrypted'),
        h('div', { class: 'row-actions' },
          h('button', {
            class: 'btn sm',
            text: 'Download unencrypted CSV',
            onclick: async () => {
              if (!csvAck.checked) return flash(exMsg, 'Tick the box to confirm first.', 'error');
              try {
                const text = await call<string>({ type: 'exportCsv', master: exMaster.value });
                download(`mpassword-${stamp}-UNENCRYPTED.csv`, text, 'text/csv');
                exMaster.value = '';
                csvAck.checked = false;
              } catch (e) {
                flash(exMsg, errorText(e), 'error');
              }
            },
          }))),
    ),
  );

  // Import
  wrap.append(importSection());

  wrap.append(h('p', { class: 'muted small', text: 'mPassword 0.1.0 · vault stored encrypted on this device only.' }));
  return wrap;
}

function importSection(): HTMLElement {
  const sec = h('details', { class: 'section', open: isFull && location.hash === '#settings' });
  sec.append(h('summary', {}, h('strong', { text: 'Import' })));
  if (!isFull) {
    // File pickers can close the popup on some systems, so import runs in a full tab.
    sec.append(
      h('p', { class: 'muted small', text: 'Import from an .mpvault backup, Chrome/Edge CSV, Bitwarden CSV, or any CSV with url and password columns.' }),
      h('div', { class: 'row-actions' },
        h('button', {
          class: 'btn',
          text: 'Open import in a tab',
          onclick: () => void chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1#settings') }),
        })),
    );
    return sec;
  }
  const file = h('input', { type: 'file', accept: '.mpvault,.json,.csv,text/csv,application/json' });
  const pw = h('input', { type: 'password', autocomplete: 'off' });
  const pwWrap = h('label', { style: 'display:none' }, 'Export password of the backup file', pw);
  const msg = h('div', { class: 'error' });
  const result = h('div', {});
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    pwWrap.style.display = f && !f.name.toLowerCase().endsWith('.csv') ? 'flex' : 'none';
    result.replaceChildren();
  });
  sec.append(
    h('label', {}, 'File', file),
    pwWrap,
    msg,
    h('div', { class: 'row-actions' },
      h('button', {
        class: 'btn primary',
        text: 'Preview import',
        onclick: async () => {
          const f = file.files?.[0];
          if (!f) return flash(msg, 'Choose a file first.', 'error');
          if (f.size > 10 * 1024 * 1024) return flash(msg, 'File is too large (max 10 MB).', 'error');
          const kind = f.name.toLowerCase().endsWith('.csv') ? 'csv' : 'mpvault';
          try {
            const text = await f.text();
            const p = await call<ImportPreview>({ type: 'importPreview', kind, text, password: pw.value });
            result.replaceChildren(
              h('div', { class: 'banner info' },
                h('p', { text: `${p.added} new, ${p.updated} with a changed password, ${p.unchanged} already saved, ${p.skipped} skipped (source: ${p.source}).` }),
                h('div', { class: 'row-actions' },
                  h('button', {
                    class: 'btn sm primary',
                    text: `Import ${p.added + p.updated}`,
                    disabled: p.added + p.updated === 0,
                    onclick: async () => {
                      const n = await call<number>({ type: 'importCommit', token: p.token });
                      result.replaceChildren(
                        h('div', { class: 'banner info' }, h('p', { text: `Imported ${n} login(s).${kind === 'csv' ? ' Now delete the CSV file: it is not encrypted.' : ''}` })),
                      );
                      pw.value = '';
                      file.value = '';
                    },
                  }))),
            );
          } catch (e) {
            flash(msg, errorText(e), 'error');
          }
        },
      })),
    result,
  );
  return sec;
}

void boot();
