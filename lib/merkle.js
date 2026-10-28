import { Buffer } from '../assets/shim/buffer.js';
import { NODE_TAG, sha256 } from './leaf.js';
                                                     

/**
 * Binary Merkle tree, blueprint §6.
 *
 *   node(l, r) = SHA256( 0x01 || l || r )
 *
 * An odd node at any level is PROMOTED unchanged to the next level. It is never
 * duplicated: duplication and promotion produce different roots, so a verifier
 * that guesses will disagree with the published root. This is the whole reason
 * the test vector in §6 exists.
 */

// Uint8Array rather than Buffer: Buffer's generic parameter is invariant between
// `Buffer<ArrayBuffer>` and `Buffer<ArrayBufferLike>`, which makes plain
// Buffer-typed variables reject each other's values under strict mode.
                              
                              

export function buildLevels(leaves          )         {
  if (leaves.length === 0) throw new Error('merkle: empty leaf set');
  let level         = leaves.map((l) => Buffer.from(l, 'hex'));
  const levels         = [level];
  while (level.length > 1) {
    const next         = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(sha256(NODE_TAG, level[i], level[i + 1]));
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1]);
    level = next;
    levels.push(level);
  }
  return levels;
}

/** Hex of a hash. `Uint8Array#toString` takes no encoding, so go through Buffer. */
function toHex(h      )         {
  return Buffer.from(h).toString('hex');
}

export function rootOf(leaves          )         {
  const levels = buildLevels(leaves);
  return toHex(levels[levels.length - 1][0]);
}

export function proofFor(leaves          , index        )                       {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`merkle: index ${index} out of range`);
  }
  const levels = buildLevels(leaves);
  const out                       = [];
  let i = index;
  for (const level of levels.slice(0, -1)) {
    if (i % 2 === 0) {
      if (i + 1 < level.length) {
        out.push({ direction: 1, hash: toHex(level[i + 1]) });
      }
      // no sibling: node is promoted, no proof element
    } else {
      out.push({ direction: 0, hash: toHex(level[i - 1]) });
    }
    i = Math.floor(i / 2);
  }
  return out;
}

export function verifyProof(leaf        , path                      , root        )          {
  let cur       = Buffer.from(leaf, 'hex');
  for (const step of path) {
    const sib = Buffer.from(step.hash, 'hex');
    cur = step.direction === 0 ? sha256(NODE_TAG, sib, cur) : sha256(NODE_TAG, cur, sib);
  }
  return toHex(cur) === root;
}

/** Canonical leaf order: inclusion height, then txid, then action index. */
export function sortLeavesOrder                                                                  (
  items     ,
)      {
  return [...items].sort((a, b) => {
    if (a.height !== b.height) return a.height - b.height;
    if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
    return a.action_index - b.action_index;
  });
}
