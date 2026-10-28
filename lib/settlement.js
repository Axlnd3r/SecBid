                                                                                                        
import { classifyAll, clear } from './clearing.js';
import { proofFor, rootOf, sortLeavesOrder } from './merkle.js';
import { settlementHash as hashSettlement } from './serialize.js';

export { paramsHash } from './serialize.js';

/**
 * Settlement artifact builder, blueprint §4–§5.
 *
 * Entry order is the canonical leaf order (height, txid, action index), and the
 * Merkle leaves are the entries in that same order. `leaves[i]` therefore needs
 * no separate array: the entry carries it, and one list cannot drift from the
 * other.
 *
 * Per-bid amounts are never written. A uniform winner's total payment is public
 * (price × filled units); the amount it bid is not.
 */

                               
                                                             
                      
                        
     
                                                                               
                                                                                
                                                                          
     
                       
                                                
                              
 

export function buildSettlement(
  params               ,
  notes                ,
  opts              ,
)                                               {
  const classified = classifyAll(notes, params);
  const clearing = clear(classified, params);

  const ordered = sortLeavesOrder(classified);
  const leaves = ordered.map((n) => clearing.leaves.get(n.key) );

  // A note commitment appears once on chain. If the scan returns a duplicate,
  // the leaf space collapses and clearing silently under-counts: refuse to emit
  // an artifact rather than publish a wrong one.
  if (new Set(leaves).size !== leaves.length) {
    throw new Error('settlement: duplicate note commitment in scan (same txid/cm twice)');
  }
  if (leaves.length === 0) throw new Error('settlement: no notes to settle');

  const root = rootOf(leaves);
  const refundByKey = new Map(clearing.refunds.map((r) => [r.key, r.value_zat]));
  const publishedTxids = new Set(opts.refunds.txs.map((t) => t.txid));

  const entries          = ordered.map((n) => {
    const outcome = clearing.outcomes.get(n.key) ;
    const leaf = clearing.leaves.get(n.key) ;
    const refund = refundByKey.get(n.key) ?? 0n;
    const refundTxid = refund > 0n ? (opts.refunds.by_leaf[leaf] ?? null) : null;
    if (refund > 0n && refundTxid === null) {
      throw new Error(`settlement: leaf ${leaf} is refundable but no refund tx was assigned`);
    }
    if (refundTxid !== null && !publishedTxids.has(refundTxid)) {
      throw new Error(`settlement: leaf ${leaf} points at unpublished refund tx ${refundTxid}`);
    }
    return {
      key: n.key,
      leaf,
      txid: n.txid,
      cm: n.cm,
      height: n.height,
      action_index: n.action_index,
      outcome,
      refund_txid: refundTxid,
      qty: n.qty,
      filled_qty: clearing.filled.get(n.key) ?? 0,
      payment_zat: clearing.payments.get(n.key) ?? 0n,
    };
  });

  const refunded_zat = clearing.refunds.reduce((sum, r) => sum + r.value_zat, 0n);

  const settlement             = {
    spec: params.spec,
    auction_id: params.auction_id,
    params_hash: params.params_hash,
    ovk_commitment: params.ovk_commitment,
    ufvk: opts.ufvk,
    deadline_height: params.deadline_height,
    settle_height: opts.settle_height,
    entries,
    merkle_root: root,
    result: clearing.result,
    clearing_price_zat: clearing.clearing_price_zat,
    winning_leaf: clearing.winning_leaf,
    winning_leaves: clearing.winning_leaves,
    rule: params.rule,
    units: params.units,
    refund_txs: opts.refunds.txs,
    ...(opts.refunds_commitment ? { refunds_commitment: opts.refunds_commitment } : {}),
    accounting: {
      refunded_zat,
      retained_zat: clearing.retained_zat,
      fees_zat: 0n,
    },
  };

  const proofs           = {};
  leaves.forEach((leaf, i) => {
    proofs[leaf] = proofFor(leaves, i);
  });

  return { settlement, proofs };
}

export function settlementHash(settlement            )         {
  return hashSettlement(settlement);
}

/**
 * The identity every settlement must satisfy: nothing appears or disappears.
 * Computed from the chain view, never from the published aggregates, because
 * the published artifact intentionally omits total inflow.
 */
export function accountingHolds(x   
                 
                       
                       
                       
                   
 )          {
  return x.in_zat === x.refunded_zat + x.retained_zat + x.stranded_zat + x.fees_zat;
}
