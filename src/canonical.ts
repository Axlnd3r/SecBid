import { createHash } from 'node:crypto';

/**
 * Canonical JSON for hashing artifacts.
 *
 * Rules: object keys sorted by code unit, no insignificant whitespace, integers
 * only (no floats, no -0, no Infinity), no undefined. This is close to RFC 8785
 * for the subset we produce, and deliberately strict: a float in a settlement
 * artifact is a bug, not a formatting choice.
 */

export type Json = null | boolean | number | bigint | string | Json[] | { [k: string]: Json };

export function canonicalJson(value: unknown): string {
  const out = encode(value, '$');
  return out;
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonical: non-finite number at ${path}`);
    if (Number.isInteger(value) && Object.is(value, -0)) return '0';
    if (Number.isInteger(value)) return String(value);
    throw new Error(`canonical: non-integer number at ${path}`);
  }

  // A bigint is emitted as a bare decimal literal, never a quoted string. It is
  // still an integer token, so the canonical form stays machine-parseable; but
  // artifacts that cross the wire encode zatoshi as decimal strings explicitly
  // (`serialize.ts`), because JSON has no bigint.
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`canonical: negative bigint at ${path}`);
    return value.toString(10);
  }

  if (typeof value === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    const body = keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`)}`);
    return `{${body.join(',')}}`;
  }

  throw new Error(`canonical: unsupported type ${typeof value} at ${path}`);
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Hash of an object excluding one field, for self-referential hashes like params_hash. */
export function hashWithout(value: Record<string, unknown>, field: string): string {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (k !== field) copy[k] = v;
  return canonicalHash(copy);
}
