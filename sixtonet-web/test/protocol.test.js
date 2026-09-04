import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import {createHash} from 'node:crypto';
import {Cipher, nonce, passwordResponse} from '../crypto.js';
import {pointerPosition} from '../viewer.js';
import {hbb} from '../protocol.js';

function handshake() {
  const sign = nacl.sign.keyPair(), box = nacl.box.keyPair();
  const id = '123456789';
  const signed = nacl.sign(hbb.IdPk.encode({id, pk:box.publicKey}).finish(), sign.secretKey);
  return {sign, box, id, signed, identity:{id, public_key:[...sign.publicKey]}};
}
test('encrypted browser/native handshake and independent monotonic counters', () => {
  const native = handshake(), c = new Cipher();
  const response = hbb.Message.decode(c.handshake(native.signed, native.identity)).publicKey;
  const key = nacl.box.open(response.symmetricValue, new Uint8Array(24), response.asymmetricValue, native.box.secretKey);
  const request = c.encode({keyEvent:{controlKey:hbb.ControlKey.Return, down:true}});
  assert.equal(hbb.Message.decode(nacl.secretbox.open(request, nonce(1), key)).keyEvent.controlKey, 27);
  const answer = nacl.secretbox(hbb.Message.encode({misc:{videoReceived:true}}).finish(), nonce(1), key);
  assert.equal(c.decode(answer).misc.videoReceived, true);
  assert.throws(() => c.decode(answer), /authentication/); // replay
  assert.throws(() => c.handshake(native.signed, native.identity), /Repeated/);
  c.close(); assert.equal(c.key, null);
});
test('wrong endpoint identity or signing key fails closed', () => {
  const n = handshake();
  assert.throws(() => new Cipher().handshake(n.signed, {...n.identity,id:'different'}), /did not match/);
  assert.throws(() => new Cipher().handshake(n.signed, {...n.identity,public_key:[...nacl.sign.keyPair().publicKey]}), /signature/);
  assert.throws(() => new Cipher().encode({misc:{videoReceived:true}}), /not established/);
});
test('challenge response matches RustDesk SHA256(SHA256(password+salt)+challenge)', async () => {
  const first = createHash('sha256').update('passsalt').digest();
  const expected = createHash('sha256').update(first).update('challenge').digest();
  assert.deepEqual(Buffer.from(await passwordResponse('pass','salt','challenge')), expected);
});
test('nonce is little endian 64 bits with remaining bytes zero', () => {
  assert.deepEqual([...nonce(258n)], [2,1,...Array(22).fill(0)]);
});
test('pointer mapping accounts for display origin, scaling and boundaries', () => {
  const r = {left:20,top:10,width:960,height:540}, d={x:-1920,y:0,width:1920,height:1080};
  assert.deepEqual(pointerPosition({clientX:500,clientY:280},r,d), {x:-960,y:540});
  assert.deepEqual(pointerPosition({clientX:10000,clientY:-40},r,d), {x:-1,y:0});
});
test('video fields and signed mouse coordinates survive protobuf', () => {
  const vf = {videoFrame:{display:1,vp9s:{frames:[{data:new Uint8Array([1,2]),key:true,pts:123}]}}};
  assert.equal(Number(hbb.Message.decode(hbb.Message.encode(vf).finish()).videoFrame.vp9s.frames[0].pts),123);
  assert.equal(hbb.Message.decode(hbb.Message.encode({mouseEvent:{x:-1920,y:10}}).finish()).mouseEvent.x,-1920);
});
