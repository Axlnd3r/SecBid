/**
 * The verifier transcript painted in the terminal panel, as plain data.
 *
 * No DOM here so tests/web.test.ts can import it from Node. The panel has to
 * describe the artifact set that was verified last: a tampered set must never
 * sit under a PASS transcript left over from the honest one.
 */

/**
 * @param {{ slug: string, kind: 'honest' | 'tamper', auction_id: string, entries: number,
 *           report: { mode: string, status?: string, ok: boolean,
 *                     checks: Array<{ code: string, status: string, description?: string }>,
 *                     failures: Array<{ code: string, message: string }> } }} view
 * @param {Record<string, string>} labels check code -> short label
 * @returns {{ status: 'PASS' | 'FAIL' | 'PARTIAL', lines: Array<Array<[string, string]>> }}
 */
export function verifyTranscript(view, labels = {}) {
  const { slug, kind, auction_id, entries, report } = view;
  const dir = kind === 'honest' ? `fixtures/${slug}` : `fixtures/tamper/${slug}`;
  const passes = report.checks.filter((c) => c.status === 'pass').length;
  const skips = report.checks.filter((c) => c.status === 'skip').length;
  const status = report.status ?? (report.ok ? 'PASS' : 'FAIL');

  const lines = [
    [['$ ', 'term-accent'], [`node src/cli.ts verify ${dir}`, 'term-key']],
    [
      [`auction ${auction_id}`, 'term-dim'],
      ['  ·  ', 'term-dim'],
      [`${report.mode} mode`, 'term-dim'],
      ['  ·  ', 'term-dim'],
      [`${entries} entries`, 'term-dim'],
    ],
  ];

  for (const check of report.checks) {
    const word = check.status === 'pass' ? 'pass' : check.status === 'fail' ? 'FAIL' : 'skip';
    const cls = check.status === 'pass' ? 'term-pass' : check.status === 'fail' ? 'term-fail' : 'term-dim';
    lines.push([
      [`  ${check.code.padEnd(4)}`, 'term-dim'],
      [word.padEnd(5), cls],
      [labels[check.code] ?? check.description ?? '', 'term-key'],
    ]);
  }

  lines.push([['', '']]);
  lines.push(
    status === 'FAIL'
      ? [[`RESULT: FAIL ${report.failures[0]?.code ?? ''}: ${report.failures[0]?.message ?? ''}`, 'term-fail']]
      : status === 'PARTIAL'
        ? [[`RESULT: PARTIAL (${passes}/${report.checks.length} checks; ${skips} skipped)`, 'term-dim']]
        : [[`RESULT: PASS (${passes}/${report.checks.length} checks)`, 'term-pass']],
  );

  return { status, lines };
}
