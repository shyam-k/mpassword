// Screenshots of the popup and in-page UI for visual review.
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const EXT = path.resolve('dist-e2e');
const MASTER = 'purple elephant rides 42 bicycles!';
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/welcome') return res.end('<!doctype html><body style="font-family:sans-serif;padding:40px"><h1>Welcome back</h1></body>');
  res.end(`<!doctype html><body style="font-family:sans-serif;padding:40px;background:#f3f4f6"><h2>Example Mail</h2>
  <form method="post" action="/welcome" style="display:flex;flex-direction:column;gap:10px;width:320px">
  <input id="user" autocomplete="username" style="padding:10px;font-size:14px" placeholder="Email">
  <input id="pass" type="password" style="padding:10px;font-size:14px" placeholder="Password">
  <button id="go" style="padding:10px">Sign in</button></form></body>`);
});
await new Promise((r) => server.listen(8124, '127.0.0.1', r));
const SITE = 'http://127.0.0.1:8124';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-shot-')), {
  headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
const out = (n) => `e2e/shots/${n}.png`;
fs.mkdirSync('e2e/shots', { recursive: true });
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 380, height: 600 });
await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.waitForSelector('#master');
await popup.fill('#master', 'weak');
await popup.screenshot({ path: out('1-setup') });
await popup.fill('#master', MASTER); await popup.fill('#master2', MASTER); await popup.check('#ack');
await popup.click('text=Create vault'); await popup.waitForSelector('nav');
const api = (m) => popup.evaluate((x) => chrome.runtime.sendMessage(x), m);
for (const [url, u, p, label, title] of [
  [SITE, 'work@example.com', 'W0rk-pass!', 'Work', 'Example Mail'],
  [SITE, 'me@example.com', 'Me-pass-22', 'Personal', 'Example Mail'],
  ['https://github.com', 'sk-dev', 'gh-!x9Q2', '', 'GitHub'],
  ['https://bank.example.in', 'sk1983', 'B4nk#secure', '', 'My Bank'],
]) await api({ type: 'save', login: { url, username: u, password: p, label, title } });
await popup.reload(); await popup.waitForSelector('nav');
await popup.screenshot({ path: out('2-all') });
await popup.click('.item.click >> nth=1'); await popup.waitForSelector('form');
await popup.screenshot({ path: out('3-edit'), fullPage: true });
await popup.click('[aria-label="Back"]'); await popup.click('nav >> text=Generator'); await popup.waitForTimeout(300);
await popup.screenshot({ path: out('4-generator') });
await popup.click('nav >> text=Settings'); await popup.waitForTimeout(300);
await popup.screenshot({ path: out('5-settings'), fullPage: true });
await api({ type: 'lock' }); await popup.reload(); await popup.waitForSelector('#unlock-password');
await popup.screenshot({ path: out('6-unlock') });
await popup.fill('#unlock-password', MASTER); await popup.click('button:has-text("Unlock")'); await popup.waitForSelector('nav');

const page = await ctx.newPage();
await page.setViewportSize({ width: 900, height: 520 });
await page.goto(SITE);
await page.click('#user');
await page.locator('mpassword-ui >> .icon').click();
await page.locator('mpassword-ui >> text=Other accounts (1)').click();
await page.waitForTimeout(300);
await page.screenshot({ path: out('7-picker') });
await page.fill('#user', 'new@example.com'); await page.fill('#pass', 'New-pass-1'); await page.click('#go');
await page.locator('mpassword-ui >> .prompt').waitFor({ state: 'visible' });
await page.screenshot({ path: out('8-prompt') });
await ctx.close(); server.close();
