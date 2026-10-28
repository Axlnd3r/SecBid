import { Buffer } from '../assets/shim/buffer.js';
                                                                         
import { isShieldedAddress } from './memo.js';
import { sha256Hex } from './leaf.js';

/**
 * The chain boundary. This is the only interface that touches real Zcash, and
 * the only part that is not deterministic.
 *
 * Implementations:
 *   ZalletAdapter (`src/zallet.ts`)  live JSON-RPC: scan, send shielded batch
 *   zingo-cli / zingolib            same surface, older wallet (not built)
 *   librustzcash + Zaino            a UFVK-only scanner (not built)
 *
 * `SimulatedChain` implements the same port from a recorded scan view so the
 * whole pipeline, including refunds, runs offline in tests and in the demo.
 */

                               
                  
                    
                    
 

                              
                     
                  
 

                               
                                                                            
                                                                  
     
                                                                              
                                                                          
                                                                              
     
                                                                                 
     
                                                                              
                                                                               
     
                                                               
 

                             
             
                   
 

/**
 * Resolve `--pool auto|ironwood|orchard` against the connected wallet.
 * Unknown support is treated as unsupported: guessing that Ironwood works is
 * exactly the kind of claim this project does not make (OPEN-QUESTIONS.md).
 */
export async function choosePool(
  chain                                    ,
  requested               ,
)                      {
  if (requested === 'orchard') return { pool: 'orchard' };
  const ironwood = await chain.supportsPool('ironwood');
  if (requested === 'ironwood') {
    if (!ironwood.supported) {
      throw new Error(
        `the connected wallet cannot open an Ironwood account: ${ironwood.reason ?? 'not supported'}`,
      );
    }
    return { pool: 'ironwood' };
  }
  if (ironwood.supported) return { pool: 'ironwood' };
  return {
    pool: 'orchard',
    warning:
      `pool auto fell back to orchard: ${ironwood.reason ?? 'Ironwood support was not confirmed'}. ` +
      'Recorded in auction.json; see OPEN-QUESTIONS.md.',
  };
}

export class SimulatedChain                         {
          view          ;
          supportedPools        ;
  /** Txids already on this simulated chain, so two chunks cannot collide. */
          usedTxids             ;

  constructor(view          , opts                              = {}) {
    this.view = structuredClone(view);
    this.supportedPools = opts.supportedPools ?? ['orchard'];
    this.usedTxids = new Set(this.view.refund_outputs.map((output) => output.txid));
  }

  supportsPool(pool      )              {
    return this.supportedPools.includes(pool)
      ? { supported: true }
      : { supported: false, reason: `simulated wallet supports ${this.supportedPools.join(', ')}` };
  }

  async scan()                          {
    return structuredClone(this.view.notes);
  }

  async sendRefunds(outputs                , targetHeight         )                    {
    if (outputs.length === 0) throw new Error('refund batch is empty');
    for (const o of outputs) {
      if (!isShieldedAddress(o.address)) {
        throw new Error(`refund to a non-shielded address: ${o.address}`);
      }
      if (typeof o.value_zat !== 'bigint' || o.value_zat <= 0n) {
        throw new Error(`refund output has an invalid value: ${String(o.value_zat)}`);
      }
    }

    // Deterministic txid so the simulated demo is reproducible run to run. A
    // reused refund address can produce two chunks with the identical output
    // set; without the collision suffix they would both get the same txid and
    // the settlement would claim two batches paid by one transaction.
    const payload = outputs
      .map((o) => `${o.address}:${o.value_zat.toString(10)}`)
      .join('|');
    let txid = sha256Hex(Buffer.from(payload, 'utf8'));
    let nonce = 0;
    while (this.usedTxids.has(txid)) {
      nonce += 1;
      txid = sha256Hex(Buffer.from(`secbid-sim-refund-v1:${nonce}:`, 'utf8'), Buffer.from(payload, 'utf8'));
    }
    this.usedTxids.add(txid);
    const heights = this.view.refund_outputs.map((r) => r.height);
    const base =
      heights.length > 0
        ? Math.max(...heights)
        : Math.max(...this.view.notes.map((n) => n.height));
    const height = targetHeight ?? base + 1;

    for (const o of outputs) {
      this.view.refund_outputs.push({
        txid,
        height,
        address: o.address,
        value_zat: o.value_zat,
      });
    }
    return { txid, height };
  }

  /** The chain as it now stands, including refunds this adapter just "mined". */
  snapshot()           {
    return structuredClone(this.view);
  }
}
