// End-to-end test: loads dist-e2e/ into Chromium and drives a local test site.
// Run: npm run e2e
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const EXT = path.resolve('dist-e2e');
const MASTER = 'purple elephant rides 42 bicycles!';
let failures = 0;
function check(cond, name) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------- test site
const loginPage = (title) => `<!doctype html><title>${title}</title><h1>${title}</h1>
<form method="post" action="/welcome">
  <input name="user" id="user" type="text" autocomplete="username" placeholder="Email">
  <input name="pass" id="pass" type="password" autocomplete="current-password">
  <button id="go" type="submit">Sign in</button>
</form>`;
const spaPage = `<!doctype html><title>SPA</title><div id="root"><form id="f">
  <input id="user" type="email"><input id="pass" type="password"><button id="go">Log in</button></form></div>
<script>document.getElementById('f').addEventListener('submit', e => { e.preventDefault();
  setTimeout(() => { document.getElementById('root').innerHTML = '<h1>Dashboard</h1>'; }, 300); });</script>`;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/login') return res.end(loginPage('Login'));
  if (req.url === '/spa') return res.end(spaPage);
  if (req.url === '/welcome') {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => res.end('<!doctype html><h1>Welcome</h1><p>Signed in.</p>'));
  }
  res.end('<!doctype html><p>ok</p>');
});
await new Promise((r) => server.listen(8123, '127.0.0.1', r));
const SITE = 'http://127.0.0.1:8123';

// ---------------------------------------------------------------- browser
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-e2e-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
check(!!extId, `extension loaded (${extId})`);

const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html?full=1`);
const api = (msg) => popup.evaluate((m) => chrome.runtime.sendMessage(m), msg);

// ---------- setup
await popup.fill('#master', 'short');
await popup.fill('#master2', 'short');
await popup.check('#ack');
await popup.click('text=Create vault');
check(await popup.locator('.error', { hasText: '12 characters' }).isVisible(), 'weak master password rejected');
await popup.fill('#master', MASTER);
await popup.fill('#master2', MASTER);
await popup.click('text=Create vault');
await popup.waitForSelector('nav');
check(true, 'vault created and unlocked');

const raw = await sw.evaluate(() => chrome.storage.local.get(null));
check(!!raw['mp:header'] && raw['mp:header'].kdf.alg === 'argon2id13', 'header stored with Argon2id params');

// ---------- helpers for the in-page UI (open shadow root in the e2e build)
const ui = (page, sel) => page.locator(`mpassword-ui >> ${sel}`);
async function signIn(page, url, user, pass) {
  await page.goto(url);
  await page.fill('#user', user);
  await page.fill('#pass', pass);
  await page.click('#go');
}

const page = await ctx.newPage();
async function filledWith(user, pass) {
  try {
    await page.waitForFunction(
      ([u, p]) => document.querySelector('#user')?.value === u && (p === null || document.querySelector('#pass')?.value === p),
      [user, pass],
      { timeout: 4000 },
    );
    return true;
  } catch {
    return false;
  }
}

// ---------- save first login
await signIn(page, `${SITE}/login`, 'alice@example.com', 'Alice-pass-1');
await page.waitForSelector('text=Welcome');
await ui(page, '.prompt').waitFor({ state: 'visible', timeout: 5000 });
check((await ui(page, '.prompt .title').textContent()) === 'Save this login?', 'save prompt after form submit');
await ui(page, '.prompt button.primary').click();
await page.waitForTimeout(400);
let list = await api({ type: 'list' });
check(list.data.length === 1 && list.data[0].username === 'alice@example.com', 'login saved after clicking Save');

// ---------- second account on the same site
await signIn(page, `${SITE}/login`, 'bob@example.com', 'Bob-pass-2');
await page.waitForSelector('text=Welcome');
await ui(page, '.prompt').waitFor({ state: 'visible', timeout: 5000 });
check((await ui(page, '.prompt .title').textContent()) === 'Save as another account?', 'second account offered as "another account"');
await ui(page, '.prompt button.primary').click();
await page.waitForTimeout(400);

// ---------- same credentials again: no prompt
await signIn(page, `${SITE}/login`, 'alice@example.com', 'Alice-pass-1');
await page.waitForSelector('text=Welcome');
await page.waitForTimeout(1200);
check(!(await ui(page, '.prompt').isVisible()), 'no prompt when the login is already saved');

// ---------- fill default + picker
await page.goto(`${SITE}/login`);
await page.click('#user');
await ui(page, '.icon').waitFor({ state: 'visible' });
await ui(page, '.icon').click();
check(await filledWith('alice@example.com', 'Alice-pass-1'), 'icon click fills the default account');
await ui(page, 'text=Other accounts (1)').click();
await ui(page, '.row').first().waitFor();
const rows = await ui(page, '.row .u').allTextContents();
check(rows.join(',') === 'alice@example.com,bob@example.com', `picker lists default first (${rows.join(', ')})`);
await ui(page, '.row', ).nth(1).click();
check(await filledWith('bob@example.com', 'Bob-pass-2'), 'picking another account fills it');

// ---------- make bob the default, then the icon fills bob
const bob = (await api({ type: 'list' })).data.find((l) => l.username === 'bob@example.com');
await api({ type: 'setDefault', origin: SITE, id: bob.id });
await page.goto(`${SITE}/login`);
await page.click('#pass');
await ui(page, '.icon').click();
check(await filledWith('bob@example.com', 'Bob-pass-2'), 'changed default is filled first');

// ---------- password change -> update prompt, history kept
await signIn(page, `${SITE}/login`, 'alice@example.com', 'Alice-pass-NEW');
await page.waitForSelector('text=Welcome');
await ui(page, '.prompt').waitFor({ state: 'visible', timeout: 5000 });
check((await ui(page, '.prompt .title').textContent()) === 'Update saved password?', 'changed password offers an update');
await ui(page, '.prompt button.primary').click();
await page.waitForTimeout(400);
const alice = (await api({ type: 'list' })).data.find((l) => l.username === 'alice@example.com');
const aliceFull = (await api({ type: 'get', id: alice.id })).data;
check(aliceFull.password === 'Alice-pass-NEW' && aliceFull.history[0]?.password === 'Alice-pass-1', 'password updated and old one kept in history');
check((await api({ type: 'list' })).data.length === 2, 'no duplicate created on update');

// ---------- single-page app login
await signIn(page, `${SITE}/spa`, 'carol@example.com', 'Carol-pass-3');
await page.waitForSelector('text=Dashboard');
await ui(page, '.prompt').waitFor({ state: 'visible', timeout: 5000 });
check(true, 'SPA login (no navigation) also offers to save');
await ui(page, '.prompt button:has-text("Not now")').click();

// ---------- other origin gets nothing
await page.goto(`http://localhost:8123/login`);
await page.click('#user');
await ui(page, '.icon').click();
await ui(page, '.panel').waitFor({ state: 'visible' });
check((await page.inputValue('#pass')) === '' && (await ui(page, '.panel').textContent()).includes('No saved login'), 'different origin (localhost vs 127.0.0.1) gets no credentials');

// ---------- content script cannot ask for another origin's login by id
const forged = await page.evaluate(() => typeof chrome === 'undefined' || !chrome.runtime?.sendMessage);
check(forged, 'page scripts have no access to the extension messaging API');

// ---------- storage holds only ciphertext
const dump = JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null)));
check(!dump.includes('Alice-pass') && !dump.includes('alice@example.com') && !dump.includes('Bob-pass'), 'chrome.storage.local contains no plaintext usernames or passwords');

// ---------- export
const exp = await api({ type: 'exportEncrypted', master: MASTER, exportPassword: 'another long export pass 9' });
check(exp.ok && !exp.data.includes('Alice-pass') && JSON.parse(exp.data).format === 'mpvault-export', 'encrypted export contains no plaintext');
const badExp = await api({ type: 'exportEncrypted', master: 'wrong master pw!!', exportPassword: 'another long export pass 9' });
check(!badExp.ok, 'export refused with the wrong master password');

// ---------- import preview of the same file: everything already saved
const prev = await api({ type: 'importPreview', kind: 'mpvault', text: exp.data, password: 'another long export pass 9' });
check(prev.ok && prev.data.unchanged === 2 && prev.data.added === 0, `import preview detects duplicates (${JSON.stringify(prev.data ?? prev.error)})`);
const csv = 'name,url,username,password,note\nGit,https://github.com,dev,Gh-1,\n';
const prevCsv = await api({ type: 'importPreview', kind: 'csv', text: csv });
const committed = await api({ type: 'importCommit', token: prevCsv.data.token });
check(committed.data === 1, 'CSV import adds a login');

// ---------- lock
await api({ type: 'lock' });
const st = await api({ type: 'status' });
check(st.data.unlocked === false, 'lock wipes the session key');
const session = await sw.evaluate(() => chrome.storage.session.get(null));
check(!session.vk, 'no key left in session storage after lock');
await page.goto(`${SITE}/login`);
await page.click('#user');
await ui(page, '.icon').click();
await ui(page, '.panel').waitFor({ state: 'visible' });
check((await ui(page, '.panel').textContent()).includes('locked') && (await page.inputValue('#pass')) === '', 'locked vault fills nothing');

// ---------- wrong password, then unlock in the popup UI
await popup.reload();
await popup.fill('#unlock-password', 'not the password');
await popup.click('button:has-text("Unlock")');
await popup.locator('.error', { hasText: 'Wrong master password' }).waitFor({ timeout: 10000 });
check(true, 'wrong master password rejected');
await popup.fill('#unlock-password', MASTER);
await popup.click('button:has-text("Unlock")');
await popup.waitForSelector('nav');
check((await api({ type: 'list' })).data.length === 3, 'unlock restores all 3 logins');


await ctx.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
