/**
 * Content script (runs in the page's isolated world, top frame only).
 *
 * It never holds the vault. It asks the background for usernames on this origin, fills one login only after a
 * trusted user action (click on our icon, the keyboard shortcut, or the popup), and reports submitted logins so
 * the user can be asked whether to save them. Its UI lives in a closed shadow root the page cannot read.
 */
import type { AccountSummary } from '../shared/types';
import type { ContentCommand, ContentRequest, FillData, PendingSave, Reply } from '../shared/messages';

type FillReply = FillData | { locked: true } | null;

function send<T>(msg: ContentRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (reply: Reply<T> | undefined) => {
        if (chrome.runtime.lastError || !reply) return reject(new Error(chrome.runtime.lastError?.message ?? 'No reply'));
        if (reply.ok) resolve(reply.data);
        else reject(new Error(reply.error));
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ------------------------------------------------------------------ field detection

const USERNAME_SELECTOR = [
  'input[autocomplete~="username"]',
  'input[autocomplete~="email"]',
  'input[type="email"]',
  'input[type="text"]',
  'input[type="tel"]',
  'input:not([type])',
].join(',');

function visible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

function passwordFields(root: ParentNode = document): HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter((i) => !i.disabled);
}

function looksLikeUsername(i: HTMLInputElement): boolean {
  const hint = `${i.name} ${i.id} ${i.autocomplete} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`.toLowerCase();
  if (/search|captcha|otp|one-time|code|coupon|promo/.test(hint)) return false;
  return true;
}

/** The username field that belongs to a password field: the last plausible text input before it. */
function usernameFor(pw: HTMLInputElement | null): HTMLInputElement | null {
  const scope: ParentNode = pw?.form ?? document;
  const candidates = [...scope.querySelectorAll<HTMLInputElement>(USERNAME_SELECTOR)].filter(
    (i) => !i.disabled && !i.readOnly && looksLikeUsername(i) && visible(i),
  );
  if (!pw) return candidates.find((i) => /user|email|login/.test(`${i.autocomplete} ${i.name} ${i.id}`.toLowerCase())) ?? null;
  const before = candidates.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
  const preferred = before.filter((i) => /username|email/.test(i.autocomplete));
  return preferred.at(-1) ?? before.at(-1) ?? null;
}

function isLoginField(el: EventTarget | null): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false;
  if (el.type === 'password') return true;
  if (!el.matches(USERNAME_SELECTOR) || !looksLikeUsername(el)) return false;
  // A username field only counts when a password field is in the same form/page, or it is marked as a username.
  if (/username|email/.test(el.autocomplete)) return true;
  const pws = passwordFields(el.form ?? document).filter(visible);
  return pws.length > 0 && usernameFor(pws[0]!) === el;
}

/** Sets a value the way a user would, so frameworks (React, Angular, Vue) notice it. */
function setValue(input: HTMLInputElement, value: string): void {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function fill(username: string, password: string, near?: HTMLInputElement | null): boolean {
  let pw: HTMLInputElement | null = null;
  if (near?.type === 'password') pw = near;
  else if (near?.form) pw = passwordFields(near.form).find(visible) ?? null;
  pw ??= passwordFields().find(visible) ?? null;
  const user = near && near.type !== 'password' ? near : usernameFor(pw);
  let filled = false;
  if (user && visible(user) && username) {
    setValue(user, username);
    filled = true;
  }
  if (pw && visible(pw)) {
    setValue(pw, password);
    filled = true;
  }
  return filled;
}

// ------------------------------------------------------------------ UI (closed shadow DOM)

declare const __SHADOW_MODE__: ShadowRootMode;
const host = document.createElement('mpassword-ui');
// Closed in production so page scripts cannot read the UI; the end-to-end test build opens it for inspection.
const shadow = host.attachShadow({ mode: __SHADOW_MODE__ });
shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .icon { position: fixed; z-index: 2147483646; width: 22px; height: 22px; border-radius: 6px; border: 0; padding: 0;
    background: #1f4fd1; color: #fff; cursor: pointer; display: none; align-items: center; justify-content: center;
    box-shadow: 0 1px 3px rgba(0,0,0,.3); }
  .icon svg { width: 14px; height: 14px; }
  .panel { position: fixed; z-index: 2147483647; min-width: 240px; max-width: 320px; background: #fff; color: #16181d;
    border: 1px solid #d5d9e0; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 8px; display: none; }
  .row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: 0;
    padding: 8px; border-radius: 7px; cursor: pointer; color: inherit; }
  .row:hover, .row:focus-visible { background: #eef2fb; outline: none; }
  .u { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: #5d6470; font-size: 12px; }
  .star { color: #c58a00; }
  .muted { color: #5d6470; padding: 6px 8px; }
  .link { background: none; border: 0; color: #1f4fd1; cursor: pointer; padding: 6px 8px; font-weight: 600; }
  .prompt { position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 320px; background: #fff; color: #16181d;
    border: 1px solid #d5d9e0; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.2); padding: 14px; display: none; }
  .title { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
  .btns { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
  .btn { border: 1px solid #c9ced8; background: #fff; color: #16181d; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-weight: 600; }
  .btn.primary { background: #1f4fd1; border-color: #1f4fd1; color: #fff; }
  .toast { position: fixed; bottom: 20px; right: 20px; z-index: 2147483647; background: #16181d; color: #fff; padding: 10px 14px;
    border-radius: 10px; display: none; max-width: 320px; }
  @media (prefers-color-scheme: dark) {
    .panel, .prompt { background: #1d2027; color: #eceef2; border-color: #353a45; }
    .row:hover, .row:focus-visible { background: #2a3040; }
    .meta, .muted { color: #a3a9b5; }
    .btn { background: #1d2027; color: #eceef2; border-color: #454b58; }
    .link { color: #8fb0ff; }
  }
</style>
<button class="icon" title="Fill with mPassword" aria-label="Fill with mPassword">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/></svg>
</button>
<div class="panel" role="dialog" aria-label="mPassword accounts"></div>
<div class="prompt" role="dialog" aria-label="Save login"></div>
<div class="toast" role="status"></div>`;

const iconEl = shadow.querySelector<HTMLButtonElement>('.icon')!;
const panelEl = shadow.querySelector<HTMLDivElement>('.panel')!;
const promptEl = shadow.querySelector<HTMLDivElement>('.prompt')!;
const toastEl = shadow.querySelector<HTMLDivElement>('.toast')!;

function mount(): void {
  if (!host.isConnected) (document.body ?? document.documentElement).appendChild(host);
}

let activeField: HTMLInputElement | null = null;

function placeIcon(): void {
  if (!activeField || !visible(activeField)) {
    iconEl.style.display = 'none';
    return;
  }
  const r = activeField.getBoundingClientRect();
  iconEl.style.display = 'flex';
  iconEl.style.top = `${Math.round(r.top + (r.height - 22) / 2)}px`;
  iconEl.style.left = `${Math.round(r.right - 22 - 6)}px`;
}

function placePanel(): void {
  const anchor = activeField?.getBoundingClientRect();
  if (!anchor) return;
  panelEl.style.top = `${Math.round(Math.min(anchor.bottom + 6, window.innerHeight - 40))}px`;
  panelEl.style.left = `${Math.round(Math.max(8, Math.min(anchor.right - 280, window.innerWidth - 330)))}px`;
}

function hidePanel(): void {
  panelEl.style.display = 'none';
  panelEl.replaceChildren();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string): void {
  mount();
  toastEl.textContent = text;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.style.display = 'none'), 3500);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function showMessage(text: string): void {
  hidePanel();
  panelEl.append(el('div', 'muted', text));
  placePanel();
  panelEl.style.display = 'block';
}

function showFilled(data: FillData): void {
  hidePanel();
  panelEl.append(el('div', 'muted', `Filled ${data.username || 'password'}`));
  if (data.others > 0) {
    const more = el('button', 'link', `Other accounts (${data.others}) ▾`);
    more.addEventListener('click', (e) => {
      if (e.isTrusted) void showPicker();
    });
    panelEl.append(more);
  }
  placePanel();
  panelEl.style.display = 'block';
  setTimeout(() => {
    if (!panelEl.matches(':hover') && panelEl.querySelector('.link')) hidePanel();
  }, 5000);
}

async function showPicker(): Promise<void> {
  const r = await send<{ locked: boolean; accounts?: AccountSummary[] }>({ type: 'cs:accounts' }).catch(() => null);
  if (!r || r.locked) return showMessage('mPassword is locked. Click the mPassword toolbar icon to unlock.');
  const accounts = r.accounts ?? [];
  if (!accounts.length) return showMessage('No saved logins for this site.');
  hidePanel();
  for (const a of accounts) {
    const row = el('button', 'row');
    const text = el('div', '');
    text.append(el('div', 'u', a.username || '(no username)'));
    const meta = [a.label, a.isDefault ? 'Default' : '', a.lastUsedAt ? `Used ${ago(a.lastUsedAt)}` : ''].filter(Boolean).join(' · ');
    if (meta) text.append(el('div', 'meta', meta));
    if (a.isDefault) row.append(el('span', 'star', '★'));
    row.append(text);
    row.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      const data = await send<FillReply>({ type: 'cs:fill', id: a.id }).catch(() => null);
      hidePanel();
      if (data && 'password' in data) fill(data.username, data.password, activeField);
    });
    panelEl.append(row);
  }
  placePanel();
  panelEl.style.display = 'block';
  panelEl.querySelector<HTMLButtonElement>('.row')?.focus();
}

function ago(t: number): string {
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return d < 30 ? `${d} days ago` : `${Math.floor(d / 30)} mo ago`;
}

iconEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
iconEl.addEventListener('click', async (e) => {
  if (!e.isTrusted) return;
  const data = await send<FillReply>({ type: 'cs:fillDefault' }).catch(() => null);
  if (!data) return showMessage('No saved login for this site yet. It will be offered after you sign in.');
  if ('locked' in data) return showMessage('mPassword is locked. Click the mPassword toolbar icon to unlock.');
  fill(data.username, data.password, activeField);
  showFilled(data);
});

document.addEventListener(
  'focusin',
  (e) => {
    const t = e.target;
    if (isLoginField(t)) {
      mount();
      activeField = t;
      placeIcon();
    }
  },
  true,
);
document.addEventListener(
  'mousedown',
  (e) => {
    if (e.composedPath().includes(host)) return;
    hidePanel();
    if (e.target !== activeField) setTimeout(() => {
      if (document.activeElement !== activeField) {
        activeField = null;
        placeIcon();
      }
    }, 0);
  },
  true,
);
window.addEventListener('scroll', () => (placeIcon(), panelEl.style.display === 'block' && placePanel()), true);
window.addEventListener('resize', () => placeIcon());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hidePanel();
});
// Typing in the page means the user is not using the picker: get out of the way.
document.addEventListener(
  'input',
  (e) => {
    if (e.isTrusted && !e.composedPath().includes(host)) hidePanel();
  },
  true,
);

// ------------------------------------------------------------------ capture on submit

let lastCapture = { username: '', password: '', at: 0 };
/** Remember a username typed on a username-only step (e.g. Google, Microsoft) for the password step. */
let rememberedUsername = '';

function pickNewPassword(fields: HTMLInputElement[]): HTMLInputElement | null {
  const filled = fields.filter((f) => f.value);
  if (!filled.length) return null;
  const marked = filled.find((f) => f.autocomplete.includes('new-password'));
  if (marked) return marked;
  // Change-password forms: current, new, confirm -> the repeated value is the new one.
  if (filled.length >= 2) {
    const last = filled.at(-1)!;
    const prev = filled.at(-2)!;
    if (last.value === prev.value) return last;
  }
  return filled[0]!;
}

function capture(scope: ParentNode): void {
  const pw = pickNewPassword(passwordFields(scope));
  if (!pw) {
    const user = usernameFor(null) ?? (document.activeElement instanceof HTMLInputElement ? document.activeElement : null);
    if (user && isLoginField(user) && user.type !== 'password' && user.value) rememberedUsername = user.value;
    return;
  }
  const user = usernameFor(pw);
  const username = (user?.value || rememberedUsername || '').trim();
  const password = pw.value;
  if (password.length > 1024) return;
  if (lastCapture.password === password && lastCapture.username === username && Date.now() - lastCapture.at < 3000) return;
  lastCapture = { username, password, at: Date.now() };
  void send({ type: 'cs:captured', username, password }).then((stored) => {
    if (!stored) return;
    // Single-page apps: if the form goes away, the login probably worked -> ask now.
    setTimeout(() => {
      if (!pw.isConnected || !visible(pw)) void checkPending();
    }, 1500);
  }).catch(() => undefined);
}

document.addEventListener('submit', (e) => capture((e.target as HTMLFormElement) ?? document), true);
document.addEventListener(
  'click',
  (e) => {
    if (!e.isTrusted) return;
    const btn = (e.target as Element | null)?.closest?.('button, input[type="submit"], input[type="button"], [role="button"]');
    if (!btn) return;
    const form = (btn as HTMLButtonElement).form ?? btn.closest('form');
    capture(form ?? document);
  },
  true,
);
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Enter' && e.isTrusted && e.target instanceof HTMLInputElement && isLoginField(e.target)) {
      capture(e.target.form ?? document);
    }
  },
  true,
);

// ------------------------------------------------------------------ save / update prompt

async function checkPending(): Promise<void> {
  const p = await send<(PendingSave & { locked: boolean }) | null>({ type: 'cs:pending' }).catch(() => null);
  if (p) showPrompt(p);
}

function showPrompt(p: PendingSave & { locked: boolean }): void {
  mount();
  promptEl.replaceChildren();
  const site = new URL(p.origin).hostname;
  const title =
    p.kind === 'update' ? 'Update saved password?' : p.kind === 'another' ? 'Save as another account?' : 'Save this login?';
  promptEl.append(el('div', 'title', title));
  promptEl.append(el('div', 'meta', `${p.username || '(no username)'} on ${site}`));
  const btns = el('div', 'btns');
  const close = () => (promptEl.style.display = 'none');
  const act = (action: 'save' | 'never' | 'dismiss') => async (e: MouseEvent) => {
    if (!e.isTrusted) return;
    close();
    const ok = await send<boolean>({ type: 'cs:resolvePending', action }).catch(() => false);
    if (ok && action === 'save') toast(p.kind === 'update' ? 'Password updated in mPassword' : 'Saved to mPassword');
  };
  if (p.locked) {
    promptEl.append(el('div', 'muted', 'mPassword is locked. Click its toolbar icon and unlock to save; the login is kept for 2 minutes.'));
    const later = el('button', 'btn', 'Not now');
    later.addEventListener('click', act('dismiss'));
    btns.append(later);
  } else {
    const never = el('button', 'btn', 'Never for this site');
    never.addEventListener('click', act('never'));
    const later = el('button', 'btn', 'Not now');
    later.addEventListener('click', act('dismiss'));
    const save = el('button', 'btn primary', p.kind === 'update' ? 'Update' : 'Save');
    save.addEventListener('click', act('save'));
    if (p.kind !== 'update') btns.append(never);
    btns.append(later, save);
  }
  promptEl.append(btns);
  promptEl.style.display = 'block';
}

// After a full page navigation, ask whether a login was just captured on this tab. If the login form is still
// showing, the sign-in probably failed, so stay quiet.
setTimeout(() => {
  if (!passwordFields().some((f) => visible(f) && !f.value)) void checkPending();
}, 600);

// ------------------------------------------------------------------ commands from the background

chrome.runtime.onMessage.addListener((msg: ContentCommand, sender) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (msg.type === 'bg:fill') {
    if (location.origin !== msg.expectedOrigin) return;
    const target = activeField ?? passwordFields().find(visible) ?? null;
    if (!fill(msg.username, msg.password, target)) toast('No visible login form on this page');
  } else if (msg.type === 'bg:shortcut') {
    void send<FillReply>({ type: 'cs:fillShortcut' }).then((d) => {
      if (!d) return toast('No saved login for this site');
      if ('locked' in d) return toast('mPassword is locked');
      const target =
        (document.activeElement instanceof HTMLInputElement && isLoginField(document.activeElement) ? document.activeElement : null) ??
        passwordFields().find(visible) ??
        null;
      fill(d.username, d.password, target);
      toast(d.others > 0 ? `Filled ${d.username || 'login'} · press again for the next account` : `Filled ${d.username || 'login'}`);
    });
  } else if (msg.type === 'bg:locked') {
    toast('mPassword is locked. Click its toolbar icon to unlock.');
  }
});
