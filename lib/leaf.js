import { Buffer } from '../assets/shim/buffer.js';
import { createHash } from '../assets/shim/crypto.js';
import { canonicalJson } from './canonical.js';
                                          

/**
 * Leaf construction.
 *
 * Spec 1 (`leafHex`) commits only txid + note commitment, so the tree proves a
 * note exists but says nothing about how it was resolved.
 *
 * Spec 2 (`leafV2Hex`) commits the auction, the note, the amount, the requested
 * quantity, the refund commitment and the final outcome. That lets a bidder
 * prove "this exact note was resolved this exact way" without publishing anyone
 * else's amount.
 *
 * The salt behind `refund_commit` is derived, not random. The blueprint says
 * "per-leaf random from settle", but randomness would make settlement.json
 * differ between two runs over the same bids, which hard rule 2 forbids. A
 * domain-separated derivation gives the same unlinkability against a party
 * without the memo and keeps the artifact byte-identical.
 */

export const LEAF_TAG = Buffer.from('secbid:leaf:v1', 'utf8');
export const LEAF_V2_TAG = Buffer.from('secbid-leaf-v2', 'utf8');
export const SALT_V2_TAG = Buffer.from('secbid-salt-v2', 'utf8');
export const NODE_TAG = Buffer.from([0x01]);
export const OVK_TAG = Buffer.from('secbid:ovk:v1', 'utf8');

export function sha256(...parts              )         {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

export function sha256Hex(...parts              )         {
  return sha256(...parts).toString('hex');
}

export function hexToBytes(hex        , field        )         {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error(`${field}: not valid hex`);
  }
  return Buffer.from(hex, 'hex');
}

/** 32-byte field, upper or lower case hex accepted, normalized to lower case. */
export function field32(hex        , field        )         {
  const b = hexToBytes(hex, field);
  if (b.length !== 32) throw new Error(`${field}: expected 32 bytes, got ${b.length}`);
  return b;
}

/** Legacy spec-1 leaf: SHA256("secbid:leaf:v1" || txid || cm). */
export function leafHex(txid        , cm        )         {
  return sha256Hex(LEAF_TAG, field32(txid, 'txid'), field32(cm, 'cm'));
}

export function ovkCommitment(auctionId        , ovkHex        )         {
  return sha256Hex(OVK_TAG, Buffer.from(auctionId, 'utf8'), hexToBytes(ovkHex, 'ovk'));
}

/** Deterministic salt for a spec-2 leaf's refund commitment. */
export function refundSalt(auctionId        , txid        , actionIndex        )         {
  return sha256Hex(
    SALT_V2_TAG,
    Buffer.from(auctionId, 'utf8'),
    Buffer.from(txid, 'hex'),
    Buffer.from(String(actionIndex), 'utf8'),
  );
}

export function refundCommit(refundAddress               , saltHex        )         {
  return sha256Hex(
    Buffer.from(refundAddress ?? '', 'utf8'),
    hexToBytes(saltHex, 'salt'),
  );
}

                              
                     
               
                       
                     
              
                        
                   
 

/** Spec-2 leaf: SHA256("secbid-leaf-v2" || canonical(fields)). */
export function leafV2Hex(input             )         {
  const preimage = canonicalJson({
    auction_id: input.auction_id,
    txid: input.txid.toLowerCase(),
    action_index: input.action_index,
    amount_zat: input.amount_zat.toString(10),
    qty: String(input.qty),
    refund_commit: input.refund_commit,
    outcome: input.outcome,
  });
  return sha256Hex(LEAF_V2_TAG, Buffer.from(preimage, 'utf8'));
}

/** Convenience: leaf for one note under one outcome. */
export function leafForNote(
  auctionId        ,
  note                                                                                                       ,
  outcome         ,
)         {
  const salt = refundSalt(auctionId, note.txid, note.action_index);
  return leafV2Hex({
    auction_id: auctionId,
    txid: note.txid,
    action_index: note.action_index,
    amount_zat: note.value_zat,
    qty: note.qty,
    refund_commit: refundCommit(note.refund_address, salt),
    outcome,
  });
}
