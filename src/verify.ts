import type {
  AccountFile,
  AuctionParams,
  BondView,
  Commitments,
  ProofMap,
  RefundArtifact,
  Reveal,
  ScanView,
  Settlement,
} from './model.ts';
import { classifyAll, clear } from './clearing.ts';
import { isShieldedAddress } from './memo.ts';
import { accountingHolds } from './settlement.ts';
import { ovkCommitment } from './leaf.ts';
import { rootOf, verifyProof } from './merkle.ts';
import { paramsHash, settlementHash } from './serialize.ts';
import { checkBond } from './bond.ts';
import { checkAuditorTranscript } from './refunds.ts';

/**
 * Verifier, blueprint §7.
 *
 * The checks are ordered so that the most specific failure is reported first:
 * a truncation attack reports C5, not "root mismatch". Every check returns a
 * stable code that a demo can print and a regression test can assert on.
 *
 *   C1  commitments (params hash, settlement hash)
 *   C2  merkle root recomputes from entries
 *   C3  every inclusion proof reconstructs to the root
 *   C4  every entry is inside the bidding window
 *   C5  completeness: entries == notes actually at the auction address
 *   C6  no transparent-funded note was admitted as a bid
 *   C7  clearing recomputes to the same winner, price, outcomes, leaves
 *   C8  every refundable note was refunded, right amount, right address
 *   C9  accounting identity: in == refunded + retained + stranded + fees
 *   C10 revealed OVK hashes to the commitment published at open
 *   C11 uniform: every winner pays the same price; only the marginal bid is partial
 *   C12 pool recorded in account.json matches the pool of received notes
 *   C13 bond funded before the first bid and unspent through reveal + grace
 *   C14 private mode: the auditor transcript matches the OVK-derived flows
 *
 * Modes:
 *   fixture  all checks the artifacts support
 *   audit    no chain view: C5–C10, C12, C13 skip; the verdict is PARTIAL
 *
 * A check that does not apply (e.g. C11 on a first-price auction) is recorded as
 * a pass with an `n/a` detail, not as a skip: "does not apply" is a fact, while
 * "could not run" is a limitation, and only the latter makes the verdict PARTIAL.
 */

export type Mode = 'fixture' | 'audit';

export interface VerifyInput {
  params: AuctionParams;
  settlement: Settlement;
  scan?: ScanView;
  proofs?: ProofMap;
  commitments?: Commitments;
  account?: AccountFile;
  reveal?: Reveal;
  bond?: BondView | null;
  refunds?: RefundArtifact;
  auditor?: { ovk: string };
  mode?: Mode;
  /**
   * The auctioneer's local view (it holds the UFVK). Never set by the `verify`
   * command on a published bundle: a public reader with an OVK gets C14 only,
   * and the honest verdict for that reader is PARTIAL.
   */
  fullView?: boolean;
}

export interface Failure {
  code: string;
  message: string;
}

export interface CheckResult {
  code: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  mode: Mode;
  /** PASS, FAIL, or PARTIAL when a check that should have run was skipped. */
  status: 'PASS' | 'FAIL' | 'PARTIAL';
  checks: CheckResult[];
  failures: Failure[];
  warnings: string[];
}

export function verify(input: VerifyInput): VerifyReport {
  const mode: Mode = input.mode ?? (input.scan ? 'fixture' : 'audit');
  const { params, settlement, scan, proofs, commitments, account, reveal, bond, refunds } = input;
  const auditor = input.auditor;
  const checks: CheckResult[] = [];
  const failures: Failure[] = [];
  const warnings: string[] = [];

  const record = (code: string, detail: string, ok: boolean) => {
    checks.push({ code, status: ok ? 'pass' : 'fail', detail });
    if (!ok) failures.push({ code, message: detail });
    return ok;
  };
  const notApplicable = (code: string, why: string) => {
    checks.push({ code, status: 'pass', detail: `n/a: ${why}` });
  };
  const skip = (code: string, why: string) => {
    checks.push({ code, status: 'skip', detail: why });
    warnings.push(`${code} skipped: ${why}`);
  };

  const auditMode = mode === 'audit';
  // Private mode publishes no UFVK. Even if a local scan.json exists, a public
  // verifier (or an auditor holding only the OVK) has no basis to recompute
  // incoming amounts; only the auctioneer's own local view may do that.
  const chainVisible =
    !!scan &&
    !auditMode &&
    (params.mode === 'public-tender' || settlement.ufvk !== null || input.fullView === true);

  // C1 — commitments
  {
    let paramsOk = false;
    let paramsWhy = 'params_hash does not match the committed params';
    try {
      paramsOk = paramsHash(params) === params.params_hash;
      if (paramsOk) paramsWhy = 'params_hash matches the committed params';
    } catch (err) {
      paramsWhy = `params cannot be re-encoded: ${(err as Error).message}`;
    }
    if (settlement.params_hash !== params.params_hash) {
      paramsOk = false;
      paramsWhy = 'settlement.params_hash does not match auction.json';
    }
    if (settlement.ovk_commitment !== params.ovk_commitment) {
      paramsOk = false;
      paramsWhy = 'settlement.ovk_commitment does not match auction.json';
    }
    let settlementOk = true;
    if (commitments) {
      settlementOk = settlementHash(settlement) === commitments.settlement_hash;
      if (!settlementOk) paramsWhy = 'settlement_hash does not match the committed settlement';
    } else {
      warnings.push('C1: no settlement commitment supplied, params only');
    }
    record('C1', paramsOk && settlementOk ? 'params_hash and settlement_hash match published commitments' : paramsWhy, paramsOk && settlementOk);
  }

  // C2 — merkle root
  {
    const leaves = settlement.entries.map((e) => e.leaf);
    let ok = false;
    let detail = 'entries are empty';
    if (leaves.length > 0) {
      const root = rootOf(leaves);
      ok = root === settlement.merkle_root;
      detail = ok ? 'merkle_root recomputes from entries' : `root mismatch: entries give ${root}`;
      if (new Set(leaves).size !== leaves.length) {
        ok = false;
        detail = 'duplicate leaf in entries: a note commitment appears twice';
      }
    }
    record('C2', detail, ok);
  }

  // C3 — inclusion proofs
  {
    if (!proofs) {
      skip('C3', 'no proofs supplied');
    } else {
      const known = new Set(settlement.entries.map((e) => e.leaf));
      let bad: string | null = null;
      let count = 0;
      for (const [leaf, path] of Object.entries(proofs)) {
        if (!known.has(leaf)) {
          bad = `proof for unknown leaf ${leaf}`;
          break;
        }
        count++;
        if (!verifyProof(leaf, path, settlement.merkle_root)) {
          bad = `proof does not reconstruct to root for ${leaf}`;
          break;
        }
      }
      record('C3', bad ?? `${count} inclusion proof(s) verified`, bad === null);
    }
  }

  // C4 — bidding window. Only notes ADMITTED to the auction must be inside it.
  {
    const admitted = new Set(['bid', 'winner', 'refunded']);
    const outside = settlement.entries.filter(
      (e) => admitted.has(e.outcome) && e.height > params.deadline_height,
    );
    record(
      'C4',
      outside.length === 0
        ? 'every admitted bid is inside the bidding window'
        : `${outside.length} late note(s) counted as bids, deadline ${params.deadline_height}: ${outside[0].leaf}`,
      outside.length === 0,
    );
  }

  // C5 — completeness
  if (!chainVisible) {
    skip('C5', auditMode ? 'audit mode has no chain view' : 'private mode publishes no UFVK');
  } else {
    const expected = scan!.chain_note_count;
    const seen = settlement.entries.length;
    const ok = seen === expected;
    record(
      'C5',
      ok
        ? `${seen} entries match the ${expected} observed at the auction address`
        : `truncation: ${expected} observed at the auction address, ${seen} committed`,
      ok,
    );
  }

  // C6 — no transparent-funded note admitted
  if (!chainVisible) {
    skip('C6', auditMode ? 'audit mode has no chain view' : 'private mode publishes no UFVK');
  } else {
    const funded = new Set(scan!.notes.filter((n) => n.transparent_funded).map((n) => `${n.txid}:${n.action_index}`));
    const admitted = settlement.entries.filter(
      (e) =>
        (e.outcome === 'bid' || e.outcome === 'winner' || e.outcome === 'refunded') &&
        funded.has(`${e.txid}:${e.action_index}`),
    );
    record(
      'C6',
      admitted.length === 0
        ? 'no transparent-funded note admitted as a bid'
        : `transparent-funded bid admitted: ${admitted[0].leaf}`,
      admitted.length === 0,
    );
  }

  // C7 — clearing recomputation (also re-derives every spec-2 leaf)
  let recomputedClear: ReturnType<typeof clear> | null = null;
  let recomputedClassified: ReturnType<typeof classifyAll> | null = null;
  if (!chainVisible) {
    skip('C7', auditMode ? 'audit mode has no amounts' : 'private mode: clearing runs on the auditor side');
  } else {
    const classified = classifyAll(scan!.notes, params);
    recomputedClassified = classified;
    const recomputed = clear(classified, params);
    recomputedClear = recomputed;
    const problems: string[] = [];
    if (settlement.spec !== params.spec) problems.push(`settlement spec ${settlement.spec} != params spec ${params.spec}`);
    if (settlement.auction_id !== params.auction_id) problems.push('settlement belongs to a different auction_id');
    if (settlement.rule !== params.rule) problems.push(`settlement rule ${settlement.rule} != params rule ${params.rule}`);
    if (settlement.units !== params.units) problems.push(`settlement units ${settlement.units} != params units ${params.units}`);
    if (settlement.deadline_height !== params.deadline_height) {
      problems.push(`settlement deadline ${settlement.deadline_height} != params deadline ${params.deadline_height}`);
    }
    if (recomputed.result !== settlement.result) problems.push(`result ${settlement.result} != ${recomputed.result}`);
    if (recomputed.clearing_price_zat !== settlement.clearing_price_zat) {
      problems.push(`clearing price ${settlement.clearing_price_zat} != ${recomputed.clearing_price_zat}`);
    }
    if (recomputed.winning_leaf !== settlement.winning_leaf) problems.push('winning leaf differs');
    const wantWinning = recomputed.winning_leaves.join(',');
    const gotWinning = settlement.winning_leaves.join(',');
    if (wantWinning !== gotWinning) problems.push('winning leaf set differs');
    for (const e of settlement.entries) {
      const want = recomputed.outcomes.get(e.key);
      if (want !== undefined && want !== e.outcome) {
        problems.push(`outcome for ${e.leaf} is ${e.outcome}, recomputed ${want}`);
        break;
      }
      const wantFilled = recomputed.filled.get(e.key) ?? 0;
      if (wantFilled !== e.filled_qty) {
        problems.push(`filled units for ${e.leaf} is ${e.filled_qty}, recomputed ${wantFilled}`);
        break;
      }
      // A spec-1 entry has no payment field, and uniform payments are C11's
      // job. Check the first-price winner here, where no other check covers it.
      if (params.spec === 2 && params.rule === 'first-price') {
        const wantPayment = recomputed.payments.get(e.key) ?? 0n;
        if (wantPayment !== e.payment_zat) {
          problems.push(`payment for ${e.leaf} is ${e.payment_zat}, recomputed ${wantPayment}`);
          break;
        }
      }
      const wantLeaf = recomputed.leaves.get(e.key);
      if (wantLeaf && wantLeaf !== e.leaf) {
        problems.push(`leaf for note ${e.txid}:${e.action_index} does not recompute`);
        break;
      }
    }
    record('C7', problems.length === 0 ? 'clearing recomputes to the published result' : problems.join('; '), problems.length === 0);
  }

  // C8 — refunds
  if (!chainVisible || !recomputedClear || !recomputedClassified) {
    skip('C8', auditMode ? 'audit mode has no refund outputs' : 'private mode: refund flows are checked by C14');
  } else {
    const problems: string[] = [];
    const byKey = new Map(recomputedClassified.map((n) => [n.key, n]));
    const expectedRefund = new Map(recomputedClear.refunds.map((r) => [r.leaf, r.value_zat]));
    const outputs = scan!.refund_outputs;
    const claimed = new Array<boolean>(outputs.length).fill(false);

    const heights = new Set(settlement.refund_txs.map((t) => t.height));
    if (heights.size > 1) {
      problems.push(`refund batch spans ${heights.size} heights, timing correlation is back`);
    }
    if (new Set(settlement.refund_txs.map((t) => t.txid)).size !== settlement.refund_txs.length) {
      problems.push('the same refund txid is published twice');
    }
    const unshielded = outputs.findIndex((o) => !isShieldedAddress(o.address));
    if (unshielded >= 0) problems.push(`refund output ${unshielded} goes to a non-shielded address`);

    const takeOutput = (txid: string, value: bigint, address: string): boolean => {
      const i = outputs.findIndex(
        (o, idx) => !claimed[idx] && o.txid === txid && o.value_zat === value && o.address === address,
      );
      if (i < 0) return false;
      claimed[i] = true;
      return true;
    };

    for (const e of settlement.entries) {
      if (problems.length > 0) break;
      const note = byKey.get(e.key);
      if (!note) {
        problems.push(`entry ${e.leaf} has no matching note`);
        break;
      }
      const expected = expectedRefund.get(e.leaf) ?? 0n;
      if (expected === 0n) {
        if (e.refund_txid !== null) problems.push(`leaf ${e.leaf} has a refund txid but nothing to refund`);
        continue;
      }
      if (!note.refund_address) {
        problems.push(`leaf ${e.leaf} must be refunded but its memo has no address`);
        break;
      }
      if (!e.refund_txid) {
        problems.push(`leaf ${e.leaf} is refundable but has no refund txid`);
        break;
      }
      if (!settlement.refund_txs.some((t) => t.txid === e.refund_txid)) {
        problems.push(`leaf ${e.leaf} points at refund tx ${e.refund_txid} which is not published`);
        break;
      }
      if (!takeOutput(e.refund_txid, expected, note.refund_address)) {
        problems.push(
          `leaf ${e.leaf} marked refunded, no matching output of ${expected} to ${note.refund_address}`,
        );
        break;
      }
    }

    const leftover = outputs.filter((_, i) => !claimed[i]);
    if (problems.length === 0 && leftover.length > 0) {
      problems.push(`${leftover.length} refund output(s) are not claimed by any entry`);
    }
    const outputTotal = outputs.reduce((s, o) => s + o.value_zat, 0n);
    if (problems.length === 0 && outputTotal !== settlement.accounting.refunded_zat) {
      problems.push(`refund outputs total ${outputTotal}, published ${settlement.accounting.refunded_zat}`);
    }
    record('C8', problems.length === 0 ? 'every refundable note refunded exactly once' : problems.join('; '), problems.length === 0);
  }

  // C9 — accounting identity
  if (!chainVisible || !recomputedClear || !recomputedClassified) {
    skip('C9', auditMode ? 'audit mode has no amounts' : 'private mode publishes no inflow figures');
  } else {
    const inZat = scan!.notes.reduce((s, n) => s + n.value_zat, 0n);
    const refunded = recomputedClear.refunds.reduce((s, r) => s + r.value_zat, 0n);
    const stranded = recomputedClassified
      .filter((n) => n.pre === 'stranded')
      .reduce((s, n) => s + n.value_zat, 0n);
    const a = settlement.accounting;
    const identity = accountingHolds({
      in_zat: inZat,
      refunded_zat: refunded,
      retained_zat: recomputedClear.retained_zat,
      stranded_zat: stranded,
      fees_zat: a.fees_zat,
    });
    const published =
      a.refunded_zat === refunded &&
      a.retained_zat === recomputedClear.retained_zat &&
      a.fees_zat === 0n;
    record(
      'C9',
      identity && published
        ? 'accounting balances: in == refunded + retained + stranded + fees'
        : `accounting mismatch: computed refunded ${refunded}, published ${a.refunded_zat}; computed retained ${recomputedClear.retained_zat}, published ${a.retained_zat}; identity ${identity}`,
      identity && published,
    );
  }

  // C10 — viewing key commitment
  if (!chainVisible) {
    skip('C10', auditMode ? 'audit mode has no OVK' : 'private mode publishes no UFVK');
  } else {
    const ok = !!scan!.ovk && ovkCommitment(params.auction_id, scan!.ovk) === params.ovk_commitment;
    record('C10', ok ? 'revealed OVK matches the commitment' : 'revealed OVK does not match the commitment', ok);
  }

  // C11 — uniform price and partial fill
  if (params.rule !== 'uniform') {
    notApplicable('C11', 'first-price clearing has a single winner');
  } else {
    const problems: string[] = [];
    if (settlement.rule !== 'uniform') problems.push(`settlement rule ${settlement.rule} != uniform`);
    const winners = settlement.entries.filter((e) => e.outcome === 'winner');
    const price = settlement.clearing_price_zat;
    if (settlement.result === 'unsold') {
      if (winners.length > 0) problems.push('unsold settlement has winners');
      if (price !== 0n) problems.push('unsold settlement has a non-zero price');
    } else {
      if (winners.length === 0) problems.push('sold settlement has no winners');
      if (price < params.reserve_zat) problems.push(`clearing price ${price} is below reserve ${params.reserve_zat}`);
      let partial = 0;
      let filledTotal = 0;
      for (const winner of winners) {
        if (winner.filled_qty < 1) problems.push(`winner ${winner.leaf} has no filled units`);
        if (winner.filled_qty > winner.qty) problems.push(`winner ${winner.leaf} is over-filled`);
        const expected = price * BigInt(winner.filled_qty);
        if (winner.payment_zat !== expected) {
          problems.push(
            `winner ${winner.leaf} pays ${winner.payment_zat}, uniform price gives ${expected}`,
          );
        }
        if (winner.filled_qty < winner.qty) partial++;
        filledTotal += winner.filled_qty;
      }
      if (partial > 1) problems.push(`${partial} partially filled bids; only the marginal bid may be partial`);
      if (filledTotal > params.units) problems.push(`filled ${filledTotal} units, only ${params.units} for sale`);
      const published = new Set(settlement.winning_leaves);
      if (published.size !== winners.length) problems.push('winning_leaves does not list every winner');
      for (const w of winners) if (!published.has(w.leaf)) problems.push(`winner ${w.leaf} is missing from winning_leaves`);
      if (partial === 1) {
        const last = settlement.winning_leaves[settlement.winning_leaves.length - 1];
        const marginal = winners.find((w) => w.filled_qty < w.qty);
        if (!marginal || marginal.leaf !== last) problems.push('the partially filled bid is not the marginal one');
      }
    }
    for (const entry of settlement.entries) {
      if (entry.outcome !== 'winner' && entry.payment_zat !== 0n) {
        problems.push(`non-winner ${entry.leaf} has a payment`);
        break;
      }
    }
    record('C11', problems.length === 0 ? 'all winners pay one clearing price; only the marginal bid is partial' : problems.join('; '), problems.length === 0);
  }

  // C12 — pool consistency
  if (params.spec === 1) {
    notApplicable('C12', 'spec 1 predates the pool field');
  } else if (auditMode) {
    skip('C12', 'audit mode has no chain view');
  } else if (params.mode === 'private' && !chainVisible) {
    skip('C12', 'private mode does not publish account.json');
  } else if (!account) {
    notApplicable('C12', 'no account.json supplied');
  } else {
    const problems: string[] = [];
    if (account.address !== params.address) problems.push('account.json address differs from auction.json');
    if (account.pool !== params.pool) {
      problems.push(`account pool ${account.pool} != committed pool ${params.pool}`);
    }
    if (scan) {
      const admitted = new Set(['bid', 'winner', 'refunded']);
      for (const entry of settlement.entries) {
        if (!admitted.has(entry.outcome)) continue;
        const note = scan.notes.find((n) => n.txid === entry.txid && n.action_index === entry.action_index);
        if (note && note.pool !== account.pool) {
          problems.push(`admitted note ${entry.leaf} came from the ${note.pool} pool, account is ${account.pool}`);
          break;
        }
      }
    }
    record('C12', problems.length === 0 ? `account and admitted notes agree on the ${params.pool} pool` : problems.join('; '), problems.length === 0);
  }

  // C13 — bond
  if (!params.bond) {
    notApplicable('C13', 'no bond posted');
  } else if (auditMode) {
    skip('C13', 'audit mode has no chain/bond view');
  } else {
    const releaseHeight = reveal?.reveal_height ?? settlement.settle_height;
    const firstBid =
      settlement.entries
        .filter((e) => e.outcome === 'winner' || e.outcome === 'refunded')
        .reduce<number | null>((min, e) => (min === null ? e.height : Math.min(min, e.height)), null);
    const result = checkBond(params, bond, { firstBidHeight: firstBid, releaseHeight });
    record('C13', result.detail, result.ok);
  }

  // C14 — private-mode auditor transcript
  if (params.mode !== 'private') {
    notApplicable('C14', 'public-tender mode publishes the UFVK; the audit runs as C5–C10');
  } else if (!auditor) {
    skip('C14', 'private mode needs --auditor --ovk to decrypt the refund flows');
  } else if (!scan) {
    record('C14', 'auditor supplied an OVK but no transcript to check', false);
  } else if (!refunds) {
    record('C14', 'refunds.json is missing: there is no published transcript to compare', false);
  } else {
    const problems: string[] = [];      if (ovkCommitment(params.auction_id, auditor.ovk) !== params.ovk_commitment) {
        problems.push('the supplied OVK does not match the commitment published at open');
      }
      if (scan.ovk && scan.ovk !== auditor.ovk) {
        problems.push('the transcript was produced with a different OVK');
      }
    if (settlement.refunds_commitment && settlement.refunds_commitment !== refunds.outputs_hash) {
      problems.push('refunds.json does not match the commitment inside settlement.json');
    }
    if (problems.length === 0) {
      const check = checkAuditorTranscript(refunds, scan, settlement);
      problems.push(...check.problems);
    }
    record('C14', problems.length === 0 ? 'auditor transcript matches the refunds.json commitment' : problems.join('; '), problems.length === 0);
  }

  const failed = failures.length > 0;
  const skipped = checks.some((c) => c.status === 'skip');
  return {
    ok: !failed,
    mode,
    status: failed ? 'FAIL' : skipped ? 'PARTIAL' : 'PASS',
    checks,
    failures,
    warnings,
  };
}
