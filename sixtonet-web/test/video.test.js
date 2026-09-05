import test from 'node:test';
import assert from 'node:assert/strict';
import {Viewer} from '../viewer.js';

function viewer() {
  const sent=[],decoded=[],drawn=[],callbacks=new Map(),cancelled=[];
  let counter=0;
  const win={requestAnimationFrame(fn){callbacks.set(++counter,fn);return counter;},
    cancelAnimationFrame(id){cancelled.push(id);callbacks.delete(id);}};
  const v=Object.create(Viewer.prototype);
  Object.assign(v,{closed:false,control:false,allowInput:true,needKey:false,
    decodeTimes:new Map(),targetFps:30,lastPressure:0,lastRateChange:-5000,recoveries:0,presented:0,frames:0,
    root:{ownerDocument:{defaultView:win}},status:{},controlButton:{setAttribute(){},classList:{remove(){}}},
    canvas:{getContext(){return {drawImage(frame){drawn.push(frame.id);}};}},
    releaseInput(){this.released=true;},send(message){sent.push(message);},
    decoder:{decodeQueueSize:0,resets:0,decode(frame){decoded.push(frame);this.decodeQueueSize++;},
      configure(){},reset(){this.resets++;this.decodeQueueSize=0;}}});
  return {v,sent,decoded,drawn,callbacks,cancelled};
}
const encoded=(i,key=false)=>({key,pts:i,data:new Uint8Array([1])});
const image=id=>({id,displayWidth:960,displayHeight:540,closed:0,close(){this.closed++;}});
globalThis.EncodedVideoChunk=class {constructor(options){Object.assign(this,options);}};

test('a short decode burst lowers FPS without discarding references or requesting a keyframe',()=>{
  const {v,decoded,sent}=viewer();
  for(let i=0;i<8;i++)v.decodeVideo(encoded(i));
  assert.equal(decoded.length,8);
  assert.equal(v.decoder.resets,0);
  assert.equal(v.targetFps,15);
  assert.deepEqual(sent,[{misc:{option:{customFps:15}}}]);
});

test('decoder queue is bounded; recovery suspends input and waits for a real keyframe',()=>{
  const {v,decoded,sent}=viewer();
  for(let i=0;i<25;i++)v.decodeVideo(encoded(i));
  assert.equal(decoded.length,20);
  assert.equal(v.decoder.resets,1);
  assert.equal(v.decodeTimes.size,0);
  assert.equal(v.needKey,true);
  assert.equal(v.released,true);
  assert.equal(v.controlButton.disabled,true);
  assert.equal(sent.filter(m=>m.misc.refreshVideo).length,1);
  v.decodeVideo(encoded(25,true));
  assert.equal(v.needKey,false);
  assert.equal(decoded.at(-1).type,'key');
});

test('a stuck in-flight decode is recovered even if the WebCodecs input queue is empty',()=>{
  const {v}=viewer();
  v.decodeTimes.set(0,performance.now()-600);
  v.decodeVideo(encoded(1));
  assert.equal(v.decoder.resets,1);
  assert.equal(v.needKey,true);
});

test('decoded bursts draw only the latest image on the next repaint and close every image',()=>{
  const {v,callbacks,drawn}=viewer();
  const first=image(1),second=image(2),third=image(3);
  v.queuePresentation(first);v.queuePresentation(second);v.queuePresentation(third);
  assert.equal(callbacks.size,1);
  assert.equal(first.closed,1);assert.equal(second.closed,1);
  assert.deepEqual(drawn,[]);
  [...callbacks.values()][0]();
  assert.deepEqual(drawn,[3]);assert.equal(third.closed,1);
  assert.equal(v.latestFrame,null);assert.equal(v.presented,1);
});

test('closing or moving windows cancels repaint and releases its pending image',()=>{
  const {v,callbacks,cancelled}=viewer();const frame=image(1);
  v.queuePresentation(frame);v.clearPresentation();
  assert.equal(callbacks.size,0);assert.equal(cancelled.length,1);assert.equal(frame.closed,1);
  assert.equal(v.latestFrame,null);
  let scheduled=0;
  v.root.ownerDocument.defaultView={requestAnimationFrame(){scheduled++;return 9;}};
  v.queuePresentation(image(2));assert.equal(scheduled,1);
});
