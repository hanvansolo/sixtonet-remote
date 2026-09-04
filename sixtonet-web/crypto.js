/*! SixtoNet Remote browser adapter, AGPL-3.0-only.
 * Source: https://github.com/hanvansolo/sixtonet-remote/tree/sixtonet/sixtonet-web
 * Protocol: RustDesk / hbb_common; upstream copyright and LICENCE retained. */
import nacl from 'tweetnacl';
import { hbb } from './protocol.js';

export function nonce(counter) {
  const n = new Uint8Array(24);
  new DataView(n.buffer).setBigUint64(0, BigInt(counter), true);
  return n;
}

export class Cipher {
  constructor() { this.key = null; this.sent = 0n; this.received = 0n; }
  handshake(signed, expected) {
    if (this.key) throw Error('Repeated desktop handshake');
    const verified = nacl.sign.open(signed, new Uint8Array(expected.public_key));
    if (!verified) throw Error('Desktop identity signature was not valid');
    const peer = hbb.IdPk.decode(verified);
    if (peer.id !== expected.id || peer.pk.length !== 32) throw Error('Desktop identity did not match this endpoint');
    const pair = nacl.box.keyPair();
    this.key = nacl.randomBytes(32);
    const boxed = nacl.box(this.key, new Uint8Array(24), peer.pk, pair.secretKey);
    pair.secretKey.fill(0);
    return hbb.Message.encode({ publicKey: { asymmetricValue: pair.publicKey, symmetricValue: boxed } }).finish();
  }
  encode(message) {
    if (!this.key) throw Error('Desktop encryption is not established');
    return nacl.secretbox(hbb.Message.encode(message).finish(), nonce(++this.sent), this.key);
  }
  decode(bytes) {
    if (!this.key) return hbb.Message.decode(bytes);
    if (bytes.length <= 1) return {};
    const opened = nacl.secretbox.open(bytes, nonce(++this.received), this.key);
    if (!opened) throw Error('Desktop message authentication failed');
    return hbb.Message.decode(opened);
  }
  close() { if (this.key) this.key.fill(0); this.key = null; }
}

export async function passwordResponse(password, salt, challenge) {
  const enc = new TextEncoder();
  const first = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(password + salt)));
  const second = new Uint8Array([...first, ...enc.encode(challenge)]);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', second));
}
