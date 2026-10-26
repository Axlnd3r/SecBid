import type { AuctionParams, BondView, NotePool, Reveal, ScanView, Settlement } from './model.ts';
import { sha256Hex } from './leaf.ts';
import { parseMemo } from './memo.ts';

/**
 * Quantum exposure report, blueprint §8.
 *
 * This is deliberately not a score. It lists what already exists: which pool
 * each received note sits in, which long-lived artifacts were published, and
 * which refund addresses were reused. The fixed disclaimer is part of the
 * output so a screenshot cannot cut it off.
 */

export const QUANTUM_DISCLAIMER =
  'Quantum-recoverable ≠ post-quantum. Privacy of revealed data is not protected against a future discrete-log-breaking adversary.';

export interface QuantumReport {
  spec: 2;
  auction_id: string;
  disclaimer: string;
  pool: { auction: string; warning: string | null };
  notes: {
    observed: boolean;
    total: number;
    by_pool: Record<NotePool, number>;
    recoverable: number;
  };
  published: Array<{ kind: string; value: string; note: string }>;
  refund_reuse: {
    duplicated_in_auction: number;
    reused_across_auctions: number;
    entries: Array<{
      /** Local CLI view only; redacted out of the publishable artifact. */
      address?: string;
      /** Stable hash so the public artifact can show reuse without naming the address. */
      address_fingerprint: string;
      leaves: string[];
      uses: number;
      cross_auction: boolean;
    }>;
  };
  exposed: string[];
}

export interface QuantumInput {
  params: AuctionParams;
  settlement?: Settlement | null;
  scan?: ScanView | null;
  reveal?: Reveal | null;
  bond?: BondView | null;
  /** Refund addresses used by earlier auctions known to this auctioneer. */
  history?: Iterable<string>;
}

/**
 * A stable fingerprint of a refund address for the published report. An address
 * is high-entropy, so no salt is needed to make this one-way; the fingerprint
 * still lets two published reports be compared for cross-auction reuse without
 * publishing the address itself.
 */
export function quantumAddressFingerprint(address: string): string {
  return sha256Hex(
    Buffer.from('secbid-quantum-address-v1', 'utf8'),
    Buffer.from(address, 'utf8'),
  );
}

/**
 * Strip the local address from a report before writing `quantum.json`.
 * Publishing a refund address would link a loser to their refund output and to
 * every other bid that used the same address — exactly the leak the one-time
 * refund rule exists to prevent.
 */
export function redactQuantumReport(report: QuantumReport): QuantumReport {
  return {
    ...report,
    refund_reuse: {
      ...report.refund_reuse,
      entries: report.refund_reuse.entries.map((entry) => {
        const { address: _address, ...rest } = entry;
        return rest;
      }),
    },
  };
}

export function buildQuantumReport(input: QuantumInput): QuantumReport {
  const { params, settlement, scan, reveal, bond } = input;
  const history = new Set(input.history ?? []);

  const byPool: Record<NotePool, number> = { ironwood: 0, orchard: 0, sapling: 0 };
  const uses = new Map<string, { leaves: string[]; cross: boolean }>();

  if (scan) {
    const byKey = new Map(
      (settlement?.entries ?? []).map((entry) => [`${entry.txid}:${entry.action_index}`, entry.leaf]),
    );
    for (const note of scan.notes) {
      byPool[note.pool] = (byPool[note.pool] ?? 0) + 1;
      const parsed = parseMemo(note.memo_raw);
      if (!parsed.ok) continue;
      const key = `${note.txid}:${note.action_index}`;
      const leaf = byKey.get(key) ?? key;
      const current = uses.get(parsed.memo.refund) ?? { leaves: [], cross: false };
      current.leaves.push(leaf);
      current.leaves.sort();
      if (history.has(parsed.memo.refund)) current.cross = true;
      uses.set(parsed.memo.refund, current);
    }
  }

  const reused = Array.from(uses.entries())
    .filter(([address, value]) => value.leaves.length > 1 || history.has(address) || value.cross)
    .map(([address, value]) => ({
      address,
      address_fingerprint: quantumAddressFingerprint(address),
      leaves: value.leaves,
      uses: value.leaves.length,
      cross_auction: history.has(address) || value.cross,
    }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  const published: QuantumReport['published'] = [
    {
      kind: 'auction_address',
      value: params.address,
      note: 'public for the lifetime of the auction; do not reuse it for anything else',
    },
  ];
  const ufvk = reveal?.ufvk ?? settlement?.ufvk ?? null;
  if (ufvk) {
    published.push({
      kind: 'revealed_ufvk',
      value: ufvk,
      note: 'reveals every received note and memo this account ever held',
    });
  }
  if (params.bond) {
    published.push({
      kind: 'bond_address',
      value: params.bond.address,
      note: `bond of ${params.bond.amount_zat} zat${bond ? `, funded at ${bond.funded_at_height}` : ''}`,
    });
  }

  const exposed: string[] = [
    'The auction account holds spending keys in one place: custody is auditable, not trustless.',
  ];
  if (scan) {
    const nonRecoverable = byPool.orchard + byPool.sapling;
    if (nonRecoverable > 0) {
      exposed.push(
        `${nonRecoverable} note(s) are not in the quantum-recoverable pool; a discrete-log break would expose their value and owner.`,
      );
    }
    if (byPool.ironwood > 0) {
      exposed.push(
        `${byPool.ironwood} note(s) are in the quantum-recoverable pool: recovery is possible, confidentiality is not post-quantum.`,
      );
    }
  } else {
    exposed.push('No viewing key was supplied, so note exposure could not be enumerated.');
  }
  if (ufvk) exposed.push('The published UFVK is long-lived and cannot be unpublished.');
  for (const reuse of reused) {
    exposed.push(
      `Refund address fingerprint ${reuse.address_fingerprint.slice(0, 16)}… is reused on ${reuse.uses} bid(s): those bids are linkable to each other.`,
    );
  }
  if (reused.length === 0 && scan) exposed.push('No refund address was reused within this auction.');

  return {
    spec: 2,
    auction_id: params.auction_id,
    disclaimer: QUANTUM_DISCLAIMER,
    pool: { auction: params.pool, warning: params.pool_warning ?? null },
    notes: {
      observed: !!scan,
      total: scan ? scan.notes.length : 0,
      by_pool: byPool,
      recoverable: byPool.ironwood,
    },
    published,
    refund_reuse: {
      duplicated_in_auction: reused.filter((r) => r.uses > 1).length,
      reused_across_auctions: reused.filter((r) => r.cross_auction).length,
      entries: reused,
    },
    exposed,
  };
}

export function renderQuantumReport(report: QuantumReport): string {
  const lines: string[] = [];
  lines.push(`quantum exposure  auction ${report.auction_id}`);
  lines.push('');
  lines.push(`  pool                ${report.pool.auction}`);
  if (report.pool.warning) lines.push(`  pool warning        ${report.pool.warning}`);
  lines.push(
    `  notes observed      ${report.notes.observed ? report.notes.total : 'no viewing key supplied'}`,
  );
  if (report.notes.observed) {
    lines.push(
      `  by pool             ironwood ${report.notes.by_pool.ironwood}, orchard ${report.notes.by_pool.orchard}, sapling ${report.notes.by_pool.sapling}`,
    );
    lines.push(`  recoverable notes   ${report.notes.recoverable}/${report.notes.total}`);
  }
  lines.push('');
  lines.push('  published long-lived items');
  for (const item of report.published) {
    lines.push(`    ${item.kind.padEnd(18)} ${item.value}`);
    lines.push(`    ${' '.repeat(19)}${item.note}`);
  }
  lines.push('');
  lines.push(
    `  reused refund addresses  ${report.refund_reuse.duplicated_in_auction} in-auction, ${report.refund_reuse.reused_across_auctions} across auctions`,
  );
  for (const reuse of report.refund_reuse.entries) {
    const label = reuse.address ?? `${reuse.address_fingerprint.slice(0, 16)}…`;
    lines.push(`    ${label}  x${reuse.uses}${reuse.cross_auction ? ' (earlier auction)' : ''}`);
  }
  lines.push('');
  for (const line of report.exposed) lines.push(`  - ${line}`);
  lines.push('');
  lines.push(`  ${report.disclaimer}`);
  return lines.join('\n');
}
