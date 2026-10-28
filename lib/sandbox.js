                                                                                                              
import { SimulatedChain } from './adapter.js';
import { broadcastRefunds, checkProofMemo, openAuction, planRefunds, settleAuction } from './auction.js';
import { sha256Hex } from './leaf.js';
import { buildMemoV2, memoJson } from './memo.js';
import { proofFor, rootOf } from './merkle.js';
import { buildRefundArtifact } from './refunds.js';
import { settlementHash } from './serialize.js';
import { verify,                   } from './verify.js';
import { buildPaymentUri, zecToZat } from './zip321.js';

/**
 * The sandbox behind web/sandbox.html: anyone opens an auction and places bids, and it runs through
 * the same open → settle → refund → verify path as the CLI. Only the chain is simulated
 * (SimulatedChain); clearing, leaves, proofs, refunds and the 14 checks are the real code.
 * The browser gets this module type-stripped (scripts/strip-lib.ts).
 */

                             
                                                          
               
                             
                 
               
                                                                      
                  
                                  
                 
                                         
                        
                                      
                   
 

                               
             
                
                              
                  
                 
                     
                                                          
                
 

                                                          

                             
                        
              
                        
                                                        
                             
                         
                   
                                 
                        
                 
                       
 

const OPENED_AT = 3_500_000;
const DEADLINE = OPENED_AT + 96; // ≈ 2 h of 75 s blocks
const CONFIRMATIONS = 3;

const fakeAddress = (prefix        , tag        ) => `${prefix}${sha256Hex(new TextEncoder().encode(tag)).slice(0, 58)}`;

/** Fresh shielded refund address for bidder i (test network). */
export function sandboxRefund(seed        , i        )         {
  return fakeAddress('utest1', `secbid-sandbox-refund:${seed}:${i}`);
}

/** Step one alone: the committed parameters and the bid URI, before any bid exists. */
export function openSandbox(input                            )                                                      {
  const seed = input.seed ?? 'sandbox';
  const tag = (s        ) => new TextEncoder().encode(`secbid-sandbox:${seed}:${s}`);
  const ovk = sha256Hex(tag('ovk'));
  const params = openAuction({
    auction_id: sha256Hex(tag('id')).slice(0, 32),
    network: 'test',
    address: fakeAddress('utest1', `secbid-sandbox-auction:${seed}`),
    reserve_zat: zecToZat(input.reserve),
    min_bid_zat: zecToZat(input.minBid),
    deadline_height: DEADLINE,
    confirmations: CONFIRMATIONS,
    rule: input.rule,
    units: input.rule === 'first-price' ? 1 : input.units,
    pool: 'orchard',
    mode: 'public-tender',
    bond: null,
    opened_at_height: OPENED_AT,
    ovk,
  });
  const uri = buildPaymentUri({
    address: params.address,
    amount_zat: params.min_bid_zat,
    memo: new TextEncoder().encode(memoJson(buildMemoV2(fakeAddress('utest1', 'your-fresh-shielded-address'), 1))),
  });
  return { params, uri, ovk };
}

export async function runSandbox(input              , tamper         = 'none')                      {
  const seed = input.seed ?? 'sandbox';
  const tag = (s        ) => new TextEncoder().encode(`secbid-sandbox:${seed}:${s}`);
  const { params, uri, ovk } = openSandbox(input);

  const bidOf = new Map                ();
  const notes                 = input.bids.map((bid, i) => {
    const txid = sha256Hex(tag(`bid-tx:${i}`));
    bidOf.set(`${txid}:0`, i);
    const refund = bid.refund?.trim() || sandboxRefund(seed, i);
    return {
      txid,
      height: bid.late ? DEADLINE + 1 : OPENED_AT + 10 + i,
      action_index: 0,
      value_zat: zecToZat(bid.amount),
      cm: sha256Hex(tag(`bid-cm:${i}`)),
      memo_raw: bid.noMemo ? null : memoJson(buildMemoV2(refund, bid.qty ?? 1)),
      transparent_funded: Boolean(bid.transparent),
      pool: 'orchard',
    };
  });
  const view           = { chain_tx_count: notes.length, chain_note_count: notes.length, notes, refund_outputs: [], ovk };

  // the same path as `secbid demo` / `settle`: scan, plan refunds, broadcast, settle
  const chain = new SimulatedChain(view, { supportedPools: ['orchard', 'ironwood'] });
  const scanned = await chain.scan();
  const plan = planRefunds(params, scanned);
  const batch = await broadcastRefunds(chain, plan);
  const scan = chain.snapshot();
  const refundsArtifact = buildRefundArtifact(params.auction_id, plan, batch);
  const ufvk = fakeAddress('uviewtest1', `secbid-sandbox-ufvk:${seed}`);
  const settleHeight = params.deadline_height + params.confirmations;
  const out = settleAuction({
    params,
    notes: scanned,
    ufvk,
    settle_height: settleHeight,
    refunds: batch,
    refunds_commitment: refundsArtifact.outputs_hash,
  });

  let settlement = out.settlement;
  let proofs = out.proofs;
  if (tamper !== 'none') ({ settlement, proofs } = tampered(settlement, proofs, tamper));

  const report = verify({
    params,
    settlement,
    scan,
    proofs,
    commitments: { params_hash: params.params_hash, settlement_hash: settlementHash(settlement) },
    reveal: { ufvk, reveal_height: settleHeight },
    bond: null,
    refunds: refundsArtifact,
    mode: 'fixture',
    fullView: true,
  });

  return { params, uri, notes, bidOf, settlement, proofs, memos: out.memos, refundTxs: batch.txs, scan, report };
}

/**
 * A dishonest auctioneer, as in fixtures/tamper: the published settlement is edited and its
 * commitment recomputed, so only the chain-backed checks can catch it.
 */
function tampered(original            , originalProofs          , kind        )                                               {
  const settlement = structuredClone(original);
  let proofs = originalProofs;
  if (kind === 'price') {
    settlement.clearing_price_zat = settlement.clearing_price_zat - 1n;
  } else if (kind === 'drop') {
    const victim = settlement.entries.findIndex((e) => !settlement.winning_leaves.includes(e.leaf));
    settlement.entries.splice(victim >= 0 ? victim : settlement.entries.length - 1, 1);
    const leaves = settlement.entries.map((e) => e.leaf);
    settlement.merkle_root = rootOf(leaves);
    proofs = {};
    leaves.forEach((leaf, i) => { proofs[leaf] = proofFor(leaves, i); });
  } else if (kind === 'refund') {
    settlement.refund_txs = [];
    for (const entry of settlement.entries) entry.refund_txid = null;
  }
  return { settlement, proofs };
}

/** The bidder's own check of their refund memo against the published settlement. */
export { checkProofMemo };
