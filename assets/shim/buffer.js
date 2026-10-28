/*
 * The subset of Node's Buffer that Secbid's core modules use, for the browser build of the sandbox
 * (scripts/strip-lib.ts injects `import { Buffer } from ...` into modules that reference it).
 * tests/browser-lib.test.ts checks it against Node's Buffer.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

function fromBase64(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Buffer(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class Buffer extends Uint8Array {
  static from(value, encoding = 'utf8') {
    if (typeof value === 'string') {
      if (encoding === 'hex') {
        const out = new Buffer(value.length >> 1);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(value.substr(i * 2, 2), 16);
        return out;
      }
      if (encoding === 'base64' || encoding === 'base64url') return fromBase64(value);
      const u = enc.encode(value);
      return new Buffer(u.buffer, u.byteOffset, u.length);
    }
    if (value instanceof ArrayBuffer) return new Buffer(value);
    const out = new Buffer(value.length);
    out.set(value);
    return out;
  }

  static alloc(size) {
    return new Buffer(size);
  }

  static byteLength(text) {
    return enc.encode(text).length;
  }

  static isBuffer(value) {
    return value instanceof Buffer;
  }

  static concat(list) {
    const out = new Buffer(list.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
  }

  toString(encoding = 'utf8') {
    if (encoding === 'hex') {
      let s = '';
      for (const byte of this) s += byte.toString(16).padStart(2, '0');
      return s;
    }
    if (encoding === 'base64' || encoding === 'base64url') {
      let bin = '';
      for (const byte of this) bin += String.fromCharCode(byte);
      const b64 = btoa(bin);
      return encoding === 'base64' ? b64 : b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return dec.decode(this);
  }

  equals(other) {
    if (other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }

  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    target.set(this.subarray(sourceStart, sourceEnd), targetStart);
    return sourceEnd - sourceStart;
  }

  readUInt8(offset) {
    return this[offset];
  }

  writeUInt8(value, offset) {
    this[offset] = value;
    return offset + 1;
  }

  readBigUInt64LE(offset) {
    return new DataView(this.buffer, this.byteOffset, this.length).getBigUint64(offset, true);
  }

  writeBigUInt64LE(value, offset) {
    new DataView(this.buffer, this.byteOffset, this.length).setBigUint64(offset, BigInt(value), true);
    return offset + 8;
  }
}
