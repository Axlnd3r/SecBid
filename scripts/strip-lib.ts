/**
 * Browser copies of Secbid's core modules, for the sandbox page: `src/<name>.ts` with its types
 * stripped (Node's own stripTypeScriptTypes, no build tool), `.ts` imports pointed at `.js`, and
 * the two Node globals the core uses replaced by web/assets/shim/ (Buffer, node:crypto).
 * Served at /lib/<name>.js by serve-web.ts and written to site/lib/ by build-static.ts.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const SRC = resolve(import.meta.dirname, '..', 'src');
const IMPORT = /from '\.\/([a-z0-9-]+)\.ts'/g;

/** The browser JS for src/<name>.ts. */
export function libModule(name: string): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad module name: ${name}`);
  let js = stripTypeScriptTypes(readFileSync(join(SRC, `${name}.ts`), 'utf8'), { mode: 'strip' });
  js = js.replace(IMPORT, "from './$1.js'").replace(/from 'node:crypto'/g, "from '../assets/shim/crypto.js'");
  if (/\bBuffer\b/.test(js)) js = `import { Buffer } from '../assets/shim/buffer.js';\n${js}`;
  return js;
}

/** Every module the entry needs at run time (type-only imports are gone after stripping). */
export function libClosure(entry = 'sandbox'): string[] {
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const m of libModule(name).matchAll(/from '\.\/([a-z0-9-]+)\.js'/g)) visit(m[1]);
  };
  visit(entry);
  return [...seen].sort();
}
