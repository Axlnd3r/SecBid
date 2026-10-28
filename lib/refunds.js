                                                                       
                                                    
                                              
import { canonicalHash } from './canonical.js';

/**
 * Refund transcript (blueprint §4, check C14).
 *
 * `refunds.json` publishes txids, heights and output counts, plus one hash over
 * the full outgoing flow set (txid, height, address, amount). The addresses and
 * amounts themselves stay encrypted to the auditor's OVK: publishing them would
 * deanonymise every loser and undo the auction.
 *
 * The commitment is built from the *plan* that was broadcast, not from a scan
 * the auctioneer controls, so the auditor can compare it against what the chain
 * actually shows with the OVK.
 */

                             
               
                 
                  
                    
 

function sortFlows(flows              )               {
  return [...flows].sort((a, b) => {
    if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
    if (a.height !== b.height) return a.height - b.height;
    if (a.address !== b.address) return a.address < b.address ? -1 : 1;
    const av = BigInt(a.value_zat);
    const bv = BigInt(b.value_zat);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}

export function plannedFlows(plan                   , batch             )               {
  const heights = new Map(batch.txs.map((tx) => [tx.txid, tx.height]));
  const flows = plan.map((entry) => {
    const txid = batch.by_leaf[entry.leaf];
    if (!txid) throw new Error(`refund transcript: leaf ${entry.leaf} has no txid`);
    const height = heights.get(txid);
    if (height === undefined) throw new Error(`refund transcript: tx ${txid} has no height`);
    return {
      txid,
      height,
      address: entry.address,
      value_zat: entry.value_zat.toString(10),
    };
  });
  return sortFlows(flows);
}

export function scanFlows(scan          )               {
  return sortFlows(
    scan.refund_outputs.map((output) => ({
      txid: output.txid,
      height: output.height,
      address: output.address,
      value_zat: output.value_zat.toString(10),
    })),
  );
}

export function flowsHash(flows              )         {
  return canonicalHash(flows                                        );
}

export function buildRefundArtifact(
  auctionId        ,
  plan                   ,
  batch             ,
)                 {
  const flows = plannedFlows(plan, batch);
  const txs = batch.txs.map((tx) => ({
    txid: tx.txid,
    height: tx.height,
    output_count: flows.filter((f) => f.txid === tx.txid).length,
  }));
  return {
    spec: 2,
    auction_id: auctionId,
    txs,
    output_count: flows.length,
    outputs_hash: flowsHash(flows),
  };
}

/** C14: does the auditor's chain view match the published transcript? */
export function checkAuditorTranscript(
  artifact                ,
  scan          ,
  settlement            ,
)                                      {
  const problems           = [];
  const flows = scanFlows(scan);

  if (artifact.auction_id !== settlement.auction_id) {
    problems.push('refunds.json belongs to a different auction');
  }
  if (artifact.output_count !== flows.length) {
    problems.push(`refunds.json claims ${artifact.output_count} outputs, the OVK shows ${flows.length}`);
  }
  if (artifact.outputs_hash !== flowsHash(flows)) {
    problems.push('refund flow commitment does not match the OVK transcript');
  }

  const expected = new Map(settlement.refund_txs.map((tx) => [tx.txid, tx.height]));
  const published = new Map(artifact.txs.map((tx) => [tx.txid, tx]));
  if (expected.size !== published.size) {
    problems.push(`refunds.json lists ${published.size} transactions, settlement lists ${expected.size}`);
  }
  for (const [txid, height] of expected) {
    const entry = published.get(txid);
    if (!entry) {
      problems.push(`refund tx ${txid} is missing from refunds.json`);
      continue;
    }
    if (entry.height !== height) {
      problems.push(`refund tx ${txid} height ${entry.height} != settlement ${height}`);
    }
    const actual = flows.filter((f) => f.txid === txid).length;
    if (entry.output_count !== actual) {
      problems.push(`refund tx ${txid} claims ${entry.output_count} outputs, the OVK shows ${actual}`);
    }
  }
  for (const txid of published.keys()) {
    if (!expected.has(txid)) problems.push(`refunds.json lists tx ${txid}, settlement does not`);
  }
  return { ok: problems.length === 0, problems };
}
