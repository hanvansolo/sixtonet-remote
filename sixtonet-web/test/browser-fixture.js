// Synthetic protocol peer: validates browser video/input, NOT native capture.
import nacl from 'tweetnacl';
import {Viewer} from '../viewer.js';
import {nonce} from '../crypto.js';
import {hbb} from '../protocol.js';

let ws, nativeKey, sent=0n, received=0n;
const sign = nacl.sign.keyPair(), box = nacl.box.keyPair();
const password = 'a'.repeat(64);
window.observed = {keys:[],mouse:[],closed:false,commands:[],codecErrors:[]};
function deliver(data) {
  const event = new MessageEvent('message', {data:typeof data === 'string' ? data : data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)});
  ws.onmessage?.(event);
}
function send(message) {
  deliver(nacl.secretbox(hbb.Message.encode(message).finish(),nonce(++sent),nativeKey));
}
class FakeSocket extends EventTarget {
  static OPEN=1;
  readyState=0; bufferedAmount=0;
  constructor() {
    super(); ws=this;
    setTimeout(() => {this.readyState=1; this.dispatchEvent(new Event('open'));},0);
  }
  send(data) {
    if (!nativeKey) {
      const pk=hbb.Message.decode(data).publicKey;
      nativeKey=nacl.box.open(pk.symmetricValue,new Uint8Array(24),pk.asymmetricValue,box.secretKey);
      send({hash:{salt:'salt',challenge:'challenge'}}); return;
    }
    const msg=hbb.Message.decode(nacl.secretbox.open(data,nonce(++received),nativeKey));
    if(msg.loginRequest) {
      send({loginResponse:{peerInfo:{version:'1.4.9',platform:'Windows',
        displays:[{x:0,y:0,width:960,height:540,name:'Synthetic display'}],currentDisplay:0}}});
      video().catch(e=>window.observed.codecErrors.push(e.message));
    }
    if(msg.keyEvent) window.observed.keys.push({...msg.keyEvent, down:msg.keyEvent.down});
    if(msg.mouseEvent) window.observed.mouse.push({...msg.mouseEvent});
  }
  close() {this.readyState=3; window.observed.closed=true;}
}
window.WebSocket=FakeSocket;
async function video() {
  const canvas=document.createElement('canvas'); canvas.width=960; canvas.height=540;
  const ctx=canvas.getContext('2d');
  const encoder=new VideoEncoder({output:chunk=> {
    const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);
    send({videoFrame:{display:0,vp9s:{frames:[{data,key:chunk.type==='key',pts:chunk.timestamp/1000}]}}});
  },error:e=>window.observed.codecErrors.push(e.message)});
  encoder.configure({codec:'vp09.00.10.08',width:960,height:540,bitrate:1500000,framerate:15,latencyMode:'realtime'});
  let frame=0;
  const timer=setInterval(()=>{
    if(window.observed.closed) {clearInterval(timer);encoder.close();return;}
    ctx.fillStyle='#1f2937';ctx.fillRect(0,0,960,540);
    ctx.fillStyle='#6c63ff';ctx.fillRect(30+frame%400,140,200,150);
    ctx.fillStyle='#fff';ctx.font='32px sans-serif';ctx.fillText('Synthetic VP9 stream — not an endpoint',30,70);
    const vf=new VideoFrame(canvas,{timestamp:frame*66667});
    encoder.encode(vf,{keyFrame:frame++%60===0});vf.close();
  },67);
}
window.viewer=new Viewer(document.querySelector('#viewer'),{url:'wss://localhost/test',input:true,
  exec:async kind=> {
    window.observed.commands.push(kind);
    if(kind==='desktop_open') {
      deliver(JSON.stringify({id:'123456789',public_key:[...sign.publicKey],password}));
      deliver(hbb.Message.encode({signedId:{id:nacl.sign(hbb.IdPk.encode({id:'123456789',pk:box.publicKey}).finish(),sign.secretKey)}}).finish());
    }
    return {ok:true};
  }});
