# mPassword — Chrome extension

Zero-knowledge password manager for Chrome (Manifest V3). Your vault is encrypted on this device; nothing is sent anywhere.

## Install (load unpacked)

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension/dist` folder.
3. Pin mPassword to the toolbar, click it and create your vault.

After changing the source, run `npm run build` and click the reload icon on the extension card.

## Using it

- **Saving:** sign in to a site as usual. After the login goes through, mPassword asks *Save this login?*
  (or *Save as another account?* / *Update saved password?*). Nothing is stored until you click Save.
- **Filling:** click into a login field and press the small key icon. The site's default account fills at once;
  *Other accounts (n)* opens a picker. You can also press **Ctrl+Shift+L** (Cmd+Shift+L on Mac); press again within
  2 seconds to cycle to the next account.
- **Several accounts per site:** each login can have a label (Work, Personal). In the popup's *This site* tab, the star
  sets which account fills first.
- **Export / import:** Settings → Export makes an encrypted `.mpvault` backup protected by its own export password.
  Import takes `.mpvault`, Chrome/Edge CSV, Bitwarden CSV, or any CSV with `url` and `password` columns.

## Security design

| Part | How |
| --- | --- |
| Key derivation | Argon2id, 64 MiB, 3 passes, random 16-byte salt (libsodium `crypto_pwhash`) |
| Encryption | XChaCha20-Poly1305 per entry, random 24-byte nonce, vault/entry id/revision bound as associated data |
| Key hierarchy | Master password → KEK → unwraps a random 256-bit vault key → seals each entry |
| At rest | `chrome.storage.local` holds ciphertext only; the unlocked key lives in memory-only `chrome.storage.session` |
| Auto-lock | After 5 idle minutes (configurable), when the computer locks, and when the browser closes |
| Brute force | After 5 wrong master passwords, waits 30 s, doubling up to 1 hour |
| Autofill | Exact origin only (subdomains opt-in per login), top frame only, only after a real click or shortcut |
| Page isolation | In-page UI is a closed shadow root; pages never see the account list or passwords before you pick one |
| Tampering | Any modified entry fails authentication and is hidden with a warning instead of decrypting garbage |
| Clipboard | Copied passwords are cleared after 30 s (configurable) |
| Code | Strict CSP, no remote code, one runtime dependency (`libsodium-wrappers-sumo`) |

**Not protected against:** malware already running on your computer, a compromised browser, or a keylogger.

## Development

```
npm install
npm run build       # → dist/
npm run watch       # rebuild on change
npm run typecheck
npm test            # unit + tamper tests (Vitest)
npm run e2e         # loads the extension in Chromium via Playwright and runs the browser tests
```

`e2e/` needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).

## Layout

```
src/shared/     crypto, vault, origin matching, generator, CSV, export/import (no Chrome APIs except kv.ts)
src/background/ service worker: the only place the vault is decrypted; message routing and checks
src/content/    login-field icon, account picker, save prompt
src/popup/      popup UI (also opens full-page via ?full=1)
src/offscreen/  clipboard write + clear
test/           Vitest unit tests
e2e/            Playwright browser tests
```

## Not in this version yet

Phone app and Wi-Fi sync (next phase), passphrase generator, 2FA codes (v2), breach check, cross-origin iframe logins.
