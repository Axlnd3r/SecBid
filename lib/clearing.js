                                                                                   
import { noteKey } from './model.js';
import { classifyAll as classifyEligibility, REFUNDABLE } from './eligibility.js';
import { leafForNote } from './leaf.js';

/**
 * Clearing, blueprint §6.
 *
 *   first-price (units = 1): highest eligible bid >= reserve wins and pays its
 *   bid. Tie => earliest (height, txid, action_index).
 *
 *   uniform (units = N): valid bids sorted by unit price descending, ties by
 *   earliest. Units are allocated greedily; only the marginal bid may be
 *   partially filled. Every winner pays the lowest accepted unit price, and the
 *   winner's excess is refunded.
 *
 * All money is bigint zatoshi. Unit price is integer division: the remainder is
 * refunded, never rounded into someone's payment.
 */

                                                  
              
                  
              
                  
                                
                         
                       
                                                                       
                      
 

                                 
                            
                                                                          
                              
                           
                                 
                             
                                                           
                                 
                                                                   
                              
                                               
                              
                                            
                                
                                                           
                                                                   
                       
                                                              
                                  
 

export function classifyAll(notes                , params               )               {
  const classes = classifyEligibility(notes, params);
  const byKey = new Map(notes.map((note) => [noteKey(note), note]));
  return classes.map((c) => {
    const note = byKey.get(c.key);
    if (!note) throw new Error(`clearing: classification for unknown note ${c.key}`);
    return {
      ...note,
      key: c.key,
      pre: c.pre,
      qty: c.qty,
      ...(c.reason ? { reason: c.reason } : {}),
      refund_address: c.refund_address,
      refund_reused: c.refund_reused,
      memo_v: c.memo_v,
      leaf: c.leaf,
    };
  });
}

function unitPrice(note            )         {
  return note.value_zat / BigInt(note.qty);
}

/** Unit price descending, then earliest height, txid, action index. */
function beforeByPrice(a            , b            )          {
  const pa = unitPrice(a);
  const pb = unitPrice(b);
  if (pa !== pb) return pa > pb;
  if (a.height !== b.height) return a.height < b.height;
  if (a.txid !== b.txid) return a.txid < b.txid;
  return a.action_index < b.action_index;
}

/** Highest total bid, then earliest height, txid, action index (spec 1 tie-break). */
function beforeFirstPrice(a            , b            )          {
  if (a.value_zat !== b.value_zat) return a.value_zat > b.value_zat;
  if (a.height !== b.height) return a.height < b.height;
  if (a.txid !== b.txid) return a.txid < b.txid;
  return a.action_index < b.action_index;
}

function leafOf(params               , note            , outcome         )         {
  if (params.spec === 1) {
    if (!note.leaf) throw new Error(`clearing: spec 1 note ${note.key} has no leaf`);
    return note.leaf;
  }
  return leafForNote(params.auction_id, note, outcome);
}

export function clear(notes              , params               )                 {
  if (params.units < 1) throw new Error(`units must be positive: ${params.units}`);
  const eligible = notes.filter((n) => n.pre === 'bid');
  const outcomes = new Map                 ();
  const filled = new Map                ();
  const payments = new Map                ();

  let result                    = 'unsold';
  let winningLeaves           = [];
  let clearingPrice = 0n;
  let retained = 0n;
  let firstBidHeight                = null;

  for (const note of eligible) {
    firstBidHeight = firstBidHeight === null ? note.height : Math.min(firstBidHeight, note.height);
  }

  if (params.rule === 'first-price') {
    let winner                    = null;
    for (const note of eligible) {
      if (winner === null || beforeFirstPrice(note, winner)) winner = note;
    }
    const sold = winner !== null && winner.value_zat >= params.reserve_zat;
    for (const note of notes) {
      if (note.pre !== 'bid') {
        outcomes.set(note.key, note.pre);
        continue;
      }
      if (sold && note.key === winner .key) {
        outcomes.set(note.key, 'winner');
        filled.set(note.key, 1);
        payments.set(note.key, note.value_zat);
      } else {
        outcomes.set(note.key, 'refunded');
        filled.set(note.key, 0);
        payments.set(note.key, 0n);
      }
    }
    if (sold) {
      result = 'sold';
      clearingPrice = winner .value_zat;
      retained = winner .value_zat;
    }
  } else {
    const sorted = [...eligible].sort((a, b) => (beforeByPrice(a, b) ? -1 : beforeByPrice(b, a) ? 1 : 0));
    let remaining = params.units;
    const accepted                                            = [];
    for (const note of sorted) {
      if (remaining <= 0) break;
      if (unitPrice(note) < params.reserve_zat) break;
      const fill = Math.min(note.qty, remaining);
      if (fill <= 0) break;
      accepted.push({ note, fill });
      remaining -= fill;
    }

    if (accepted.length > 0) {
      result = 'sold';
      // The marginal (lowest accepted) price, floored at the reserve. With an
      // undersubscribed auction this is simply the lowest accepted bid.
      const marginal = unitPrice(accepted[accepted.length - 1].note);
      clearingPrice = marginal > params.reserve_zat ? marginal : params.reserve_zat;
    }

    const acceptedByKey = new Map(accepted.map((a) => [a.note.key, a.fill]));
    for (const note of notes) {
      if (note.pre !== 'bid') {
        outcomes.set(note.key, note.pre);
        filled.set(note.key, 0);
        payments.set(note.key, 0n);
        continue;
      }
      const fill = acceptedByKey.get(note.key) ?? 0;
      if (fill > 0) {
        outcomes.set(note.key, 'winner');
        filled.set(note.key, fill);
        const payment = clearingPrice * BigInt(fill);
        payments.set(note.key, payment);
        retained += payment;
      } else {
        outcomes.set(note.key, 'refunded');
        filled.set(note.key, 0);
        payments.set(note.key, 0n);
      }
    }
  }

  const leaves = new Map                ();
  for (const note of notes) {
    leaves.set(note.key, leafOf(params, note, outcomes.get(note.key) ));
  }

  // Winning leaves in allocation order. Spec 1 has at most one.
  if (result === 'sold') {
    if (params.rule === 'first-price') {
      const winner = notes.find((n) => outcomes.get(n.key) === 'winner');
      if (winner) winningLeaves = [leaves.get(winner.key) ];
    } else {
      const sortedAccepted = notes
        .filter((n) => outcomes.get(n.key) === 'winner')
        .sort((a, b) => (beforeByPrice(a, b) ? -1 : 1));
      winningLeaves = sortedAccepted.map((n) => leaves.get(n.key) );
    }
  }

  const refunds                                                          = [];
  for (const note of notes) {
    const outcome = outcomes.get(note.key) ;
    const payment = payments.get(note.key) ?? 0n;
    if (outcome === 'winner') {
      const excess = note.value_zat - payment;
      if (excess > 0n) refunds.push({ key: note.key, leaf: leaves.get(note.key) , value_zat: excess });
    } else if (outcome === 'refunded') {
      refunds.push({ key: note.key, leaf: leaves.get(note.key) , value_zat: note.value_zat });
    } else if (REFUNDABLE.has(note.pre)) {
      refunds.push({ key: note.key, leaf: leaves.get(note.key) , value_zat: note.value_zat });
    }
    // `stranded` is absent: there is nowhere safe to send it.
  }

  return {
    result,
    winning_leaf: winningLeaves[0] ?? null,
    winning_leaves: winningLeaves,
    clearing_price_zat: result === 'sold' ? clearingPrice : 0n,
    outcomes,
    leaves,
    filled,
    payments,
    refunds,
    retained_zat: retained,
    first_bid_height: firstBidHeight,
  };
}
