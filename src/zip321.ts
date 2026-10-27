import { ZAT_PER_ZEC } from './model.ts';
import { isShieldedAddress } from './memo.ts';

/**
 * ZIP-321 payment request.
 *
 *   zcash:<address>?amount=<zec>&memo=<base64>
 *
 * The auction publishes one URI per auction. The bidder's wallet fills the
 * amount (their bid) and carries the memo through unchanged. That is the whole
 * "no app to install" claim: the bid is a payment, and the payment is the bid.
 *
 * `memo` is base64url over the raw memo bytes with `=` padding omitted, as
 * ZIP-321 requires; wallets MUST reject `+`, `/` and `=`. The parser also
 * accepts the standard alphabet so URIs printed by older builds still decode.
 * Wallets that do not implement the memo parameter are listed as a Day-1 spike
 * risk: a dropped memo produces a `stranded` note.
 */

export interface PaymentUri {
  address: string;
  amount_zat?: bigint;
  memo?: Uint8Array;
  message?: string;
}

export function zatToZec(zat: bigint): string {
  if (typeof zat !== 'bigint' || zat < 0n) throw new Error(`invalid zat amount: ${String(zat)}`);
  const whole = zat / ZAT_PER_ZEC;
  const frac = (zat % ZAT_PER_ZEC).toString(10).padStart(8, '0').replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

export function zecToZat(zec: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(zec)) throw new Error(`invalid ZEC amount: ${zec}`);
  const [whole, frac = ''] = zec.split('.');
  return BigInt(whole) * ZAT_PER_ZEC + BigInt(frac.padEnd(8, '0') || '0');
}

export function buildPaymentUri(req: PaymentUri): string {
  if (!/^[0-9a-z]+$/.test(req.address) || !isShieldedAddress(req.address)) {
    throw new Error(`not a shielded address: ${req.address}`);
  }
  const params = new URLSearchParams();
  if (req.amount_zat !== undefined) params.set('amount', zatToZec(req.amount_zat));
  if (req.memo && req.memo.length > 0) {
    if (req.memo.length > 512) throw new Error(`memo is ${req.memo.length} bytes, max 512`);
    params.set('memo', Buffer.from(req.memo).toString('base64url'));
  }
  if (req.message) params.set('message', req.message);
  const qs = params.toString();
  return qs ? `zcash:${req.address}?${qs}` : `zcash:${req.address}`;
}

export function parsePaymentUri(uri: string): PaymentUri {
  if (!uri.startsWith('zcash:')) throw new Error('not a zcash: URI');
  const body = uri.slice('zcash:'.length);
  const qIndex = body.indexOf('?');
  const address = qIndex === -1 ? body : body.slice(0, qIndex);
  const params = new URLSearchParams(qIndex === -1 ? '' : body.slice(qIndex + 1));

  const out: PaymentUri = { address };
  const amount = params.get('amount');
  if (amount !== null) out.amount_zat = zecToZat(amount);
  const memo = params.get('memo');
  // Node's base64url decoder also accepts `+`, `/` and padding.
  if (memo !== null) out.memo = new Uint8Array(Buffer.from(memo, 'base64url'));
  const message = params.get('message');
  if (message !== null) out.message = message;
  return out;
}
