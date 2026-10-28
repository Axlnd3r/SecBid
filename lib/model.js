/**
 * Domain types. Deliberately free of dependencies so the whole deterministic
 * core can run anywhere, including in a judge's browser-less sandbox.
 *
 * Amounts are integer zatoshis in a `bigint`. Zcash's total supply is
 * 21e14 zat, so a JS number would technically be exact, but "technically exact
 * until someone multiplies by a quantity" is not a property an auction should
 * rely on. Artifacts serialize them as decimal strings in spec 2 and as numbers
 * in spec 1 (see `serialize.ts`), never as floats.
 */

                         

                                             
                                          
                                        
                                               

                     
                                                     
            
                                  
                                      
                                           
                                     
                                                              
                          // funded from a transparent input: rejected

                                                                                     

                       
                  
                  
                                                               
                     
 

                                
                                                                       
              
                     
                                       
                                                                      
                   
                          
                                                                
                        
                   
             
                                                 
                
             
             
                    
                           
                                                          
                                                                               
                                                               
                        
 

                       
           
                                                           
                                                             
              
                 
 

/**
 * One note received at the auction address. In a real deployment this comes
 * from trial-decrypting with the auction UFVK; in fixtures it is the recorded
 * result of that scan. `value_zat`, `memo_raw` and `transparent_funded` are only
 * visible to a holder of the viewing key.
 */
                               
                         
                                     
                       
                 
                                       
                                                                   
                                                                       
                 
 

                        
                                                                        
              
                         
               
             
                 
                       
                   
                             
                                                  
              
                                                          
                     
                                                                      
                   
 

                           
               
                 
 

/**
 * Refunds as broadcast. One transaction per batch when it fits, several
 * broadcast together at one target height when it does not. `by_leaf` records
 * which transaction paid which entry, so the artifact never claims a refund
 * that a different tx actually carried.
 */
                              
                  
                                  
 

                             
              
                     
                      
                         
                                                             
                      
                          
                        
                   
                      
                            
                                                                                 
                          
                              
                                                                               
                           
             
                
                         
                                                                                     
                              
     
                                                                            
                                                                               
                                                                        
                                                       
     
               
                      
                      
                  
    
 

/** Simulated chain view that a verifier obtains independently (public rescan). */
                           
                                                                         
                                                                              
                        
                                                                                                            
                                                    
 

/** `account.json` is written by `open --rpc`; never public in private mode. */
                              
                       
                  
               
             
                 
 

/** `reveal.json` exists only in public-tender mode. */
                         
               
                        
 

/**
 * Public record of the auctioneer's bond. `bond.json` is the chain/bond view
 * C13 consumes; it is deliberately not part of the hashed params.
 */
                           
               
                  
                  
                     
                           
                                 
                            
 

/** Auditor transcript shape published alongside a settlement. */
                                 
          
                     
                                                                     
                       
                                                                                   
                       
 

                                     
                                                          
                   
               
 

                                                            

                              
                      
                          
 

export const ZAT_PER_ZEC = 100_000_000n;

export function zat(n        )         {
  if (typeof n !== 'bigint' || n < 0n) {
    throw new Error(`not a valid zat amount: ${String(n)}`);
  }
  return n;
}

export function noteKey(note                                        )         {
  return `${note.txid}:${note.action_index}`;
}

export function entryKey(entry                                        )         {
  return `${entry.txid}:${entry.action_index}`;
}
