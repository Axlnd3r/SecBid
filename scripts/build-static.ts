/**
 * Build a static copy of the public auction page for GitHub Pages: `npm run build:static`.
 *
 * Every API answer the page can ask for is rendered by the real web server (so the whitelist in
 * buildPublicBundle still decides what is public) and written as a JSON file next to the page.
 * Absolute `/assets/` paths become relative so the site works under `/<repo>/`.
 *
 *   node scripts/build-static.ts [--out site]
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createWebServer } from './serve-web.ts';

const root = resolve(import.meta.dirname, '..');

export async function buildStatic(out: string): Promise<string[]> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // the page and its assets; the film's generated media is not part of the public site
  cpSync(join(root, 'web'), out, { recursive: true, filter: (src) => !/\/assets\/film(\/|$)/.test(src.replace(/\\/g, '/')) });

  const server = createWebServer({ cwd: root });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const written: string[] = [];
  const save = async (apiPath: string, file: string) => {
    const res = await fetch(base + apiPath);
    if (!res.ok) throw new Error(`${apiPath} → HTTP ${res.status}`);
    const target = join(out, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await res.text());
    written.push(file);
  };
  try {
    await save('/api/auctions', 'api/auctions.json');
    const { auctions } = JSON.parse(readFileSync(join(out, 'api/auctions.json'), 'utf8')) as { auctions: Array<{ slug: string }> };
    for (const { slug } of auctions) {
      await save(`/api/auction/${slug}`, `api/auction/${slug}.json`);
      for (const mode of ['fixture', 'audit']) {
        await save(`/api/auction/${slug}/report?mode=${mode}`, `api/auction/${slug}/report-${mode}.json`);
      }
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }

  for (const page of ['index.html', 'film.html']) {
    const p = join(out, page);
    let html = readFileSync(p, 'utf8').replaceAll('"/assets/', '"assets/');
    if (page === 'index.html') html = html.replace('<head>', '<head>\n<meta name="secbid-static" content="1">');
    writeFileSync(p, html);
  }
  writeFileSync(join(out, '.nojekyll'), ''); // serve files as-is (no Jekyll processing)
  return written;
}

if (import.meta.main) {
  const i = process.argv.indexOf('--out');
  const out = resolve(root, i > 0 ? process.argv[i + 1] : 'site');
  const files = await buildStatic(out);
  console.log(`static site in ${out}: ${files.length} API files`);
}
