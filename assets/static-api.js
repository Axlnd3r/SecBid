/*
 * Static hosting (GitHub Pages) has no /api: `npm run build:static` renders every API answer the
 * page can ask for into JSON files, and marks the built index.html with
 * <meta name="secbid-static">. This maps an API path onto those files. Query parameters the
 * static build cannot honour (`?tip=`) are dropped; `?mode=` picks the pre-rendered report.
 */

/** @param {string} path an API path as the page requests it, e.g. `/api/auction/a1/report?mode=audit` */
export function staticPath(path) {
  const url = new URL(path, 'http://static.invalid');
  if (url.pathname === '/api/auctions') return 'api/auctions.json';
  const m = /^\/api\/auction\/([a-z0-9-]+)(\/report)?$/.exec(url.pathname);
  if (m && m[2]) {
    const mode = url.searchParams.get('mode') === 'audit' ? 'audit' : 'fixture';
    return `api/auction/${m[1]}/report-${mode}.json`;
  }
  if (m) return `api/auction/${m[1]}.json`;
  return path;
}

/** True when this page was built for static hosting. */
export function isStatic(doc = globalThis.document) {
  return Boolean(doc?.querySelector?.('meta[name="secbid-static"]'));
}
