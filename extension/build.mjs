// Build script: bundles each extension entry point with esbuild and copies static files to dist/.
import * as esbuild from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Copy by rewriting file contents (works even where files cannot be deleted or replaced). */
function copy(src, dest) {
  if (statSync(src).isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) copy(join(src, name), join(dest, name));
  } else {
    writeFileSync(dest, readFileSync(src));
  }
}

const watch = process.argv.includes('--watch');
const e2e = process.argv.includes('--e2e');
const outdir = e2e ? 'dist-e2e' : 'dist';

try {
  rmSync(outdir, { recursive: true, force: true });
} catch {
  // Some sandboxes forbid deleting; files are simply overwritten below.
}
mkdirSync(outdir, { recursive: true });
copy('public', outdir);
copy('src/popup/popup.html', `${outdir}/popup.html`);
copy('src/popup/popup.css', `${outdir}/popup.css`);
copy('src/offscreen/offscreen.html', `${outdir}/offscreen.html`);

const options = {
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    popup: 'src/popup/popup.ts',
    offscreen: 'src/offscreen/offscreen.ts',
  },
  outdir,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'external',
  logLevel: 'warning',
  define: { __SHADOW_MODE__: e2e ? '"open"' : '"closed"' },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
  // The content script is injected as a classic script, so rebuild it as an IIFE.
  await esbuild.build({ ...options, entryPoints: { content: 'src/content/index.ts' }, format: 'iife' });
}
