// Synthetic protocol peer: validates browser video/input, NOT native capture.
import nacl from 'tweetnacl';
import {Viewer} from '../viewer.js';
import {nonce} from '../crypto.js';
import {hbb} from '../protocol.js';

let ws, nativeKey, sent=0n, received=0n;
let waitingAck=false,ackRequired=false,quality=3,requestedFps=30,forceKey=false;
const lag=Number(new URL(location.href).searchParams.get('lag') || 0);
const sign = nacl.sign.keyPair(), box = nacl.box.keyPair();
const password = 'a'.repeat(64);
window.observed = {keys:[],mouse:[],clipboard:[],selectedSessions:[],closed:false,commands:[],codecErrors:[],localReads:0,localWrites:[],login:null,options:[],videoPackets:0};
Object.defineProperty(navigator,'clipboard',{value:{
  readText:async()=>{observed.localReads++;return 'Local £ clipboard';},
  writeText:async text=>{observed.localWrites.push(text);}
}});
window.sendRemoteClipboard = (text, extra={}) => send({clipboard:{format:0,content:new TextEncoder().encode(text),...extra}});
function deliver(data) {
  const event = new MessageEvent('message', {data:typeof data === 'string' ? data : data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)});
  ws.onmessage?.(event);
}
function send(message) {
  const packet=nacl.secretbox(hbb.Message.encode(message).finish(),nonce(++sent),nativeKey);
  if(lag)setTimeout(()=>{if(!observed.closed)deliver(packet);},lag);
  else deliver(packet);
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
      observed.login={videoAckRequired:msg.loginRequest.videoAckRequired,imageQuality:msg.loginRequest.option.imageQuality};
      ackRequired=msg.loginRequest.videoAckRequired; quality=msg.loginRequest.option.imageQuality;
      send({loginResponse:{peerInfo:{version:'1.4.9',platform:'Windows',
        displays:[{x:0,y:0,width:960,height:540,name:'Synthetic display'}],currentDisplay:0,
        windowsSessions:{currentSid:2,sessions:[{sid:1,name:'Console'},{sid:2,name:'Active user'}]}}}});
    }
    if(msg.misc?.videoReceived)setTimeout(()=>{waitingAck=false;},lag);
    if(msg.misc?.refreshVideo)forceKey=true;
    if(msg.misc?.option){observed.options.push({...msg.misc.option});requestedFps=msg.misc.option.customFps || requestedFps;}
    if (msg.misc && Object.hasOwn(msg.misc,'selectedSid')) {
      window.observed.selectedSessions.push(msg.misc.selectedSid);
      if (msg.misc.selectedSid === 2) video().catch(e=>window.observed.codecErrors.push(e.message));
    }
    if(msg.keyEvent) window.observed.keys.push({...msg.keyEvent, down:msg.keyEvent.down});
    if(msg.mouseEvent) window.observed.mouse.push({...msg.mouseEvent});
    if(msg.clipboard) window.observed.clipboard.push(new TextDecoder().decode(msg.clipboard.content));
  }
  close() {this.readyState=3; window.observed.closed=true;}
}
window.WebSocket=FakeSocket;
async function video() {
  const canvas=document.createElement('canvas'); canvas.width=960; canvas.height=540;
  const ctx=canvas.getContext('2d');
  const encoder=new VideoEncoder({output:chunk=> {
    observed.videoPackets++;
    const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);
    send({videoFrame:{display:0,vp9s:{frames:[{data,key:chunk.type==='key',pts:chunk.timestamp/1000}]}}});
  },error:e=>window.observed.codecErrors.push(e.message)});
  encoder.configure({codec:'vp09.00.10.08',width:960,height:540,bitrate:quality===4?3000000:1500000,framerate:30,latencyMode:'realtime'});
  let frame=0;
  let last=0;
  const timer=setInterval(()=>{
    if(window.observed.closed) {clearInterval(timer);encoder.close();return;}
    if((ackRequired&&waitingAck)||performance.now()-last<1000/requestedFps)return;
    waitingAck=true;last=performance.now();
    ctx.fillStyle='#1f2937';ctx.fillRect(0,0,960,540);
    ctx.fillStyle='#6c63ff';ctx.fillRect(30+frame%400,140,200,150);
    ctx.fillStyle='#fff';ctx.font='32px sans-serif';ctx.fillText('Synthetic VP9 stream — not an endpoint',30,70);
    const vf=new VideoFrame(canvas,{timestamp:frame*33333});
    encoder.encode(vf,{keyFrame:forceKey||frame++%60===0});forceKey=false;vf.close();
  },10);
}
window.viewer=new Viewer(document.querySelector('#viewer'),{url:'wss://localhost/test',input:true,
  clipboard:new URL(location.href).searchParams.has('clipboard'),
  exec:async kind=> {
    window.observed.commands.push(kind);
    if(kind==='desktop_open') {
      deliver(JSON.stringify({id:'123456789',public_key:[...sign.publicKey],password}));
      deliver(hbb.Message.encode({signedId:{id:nacl.sign(hbb.IdPk.encode({id:'123456789',pk:box.publicKey}).finish(),sign.secretKey)}}).finish());
    }
    return {ok:true};
  }});
