/*! SixtoNet Remote browser adapter — AGPL-3.0-only.
 * Corresponding source: https://github.com/hanvansolo/sixtonet-remote/tree/sixtonet */
import { Cipher, passwordResponse } from './crypto.js';
import { hbb } from './protocol.js';

const CK = hbb.ControlKey;
const keys = { Enter: CK.Return, ArrowLeft: CK.LeftArrow, ArrowRight: CK.RightArrow,
  ArrowUp: CK.UpArrow, ArrowDown: CK.DownArrow,
  ...Object.fromEntries(['Alt','Backspace','CapsLock','Control','Delete','End','Escape',
    'Home','Meta','PageDown','PageUp','Shift','Tab','Insert','Pause','NumLock',
    ...Array.from({length:12}, (_, i) => `F${i+1}`)].map(k => [k, CK[k]])) };

function element(tag, text, cls) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function modifiers(e) {
  return [e.altKey && CK.Alt, e.ctrlKey && CK.Control, e.shiftKey && CK.Shift,
    e.metaKey && CK.Meta].filter(Boolean);
}
export function pointerPosition(event, rect, display) {
  return {x: (display.x || 0) + Math.max(0, Math.min(display.width - 1,
    Math.floor((event.clientX - rect.left) / rect.width * display.width))),
  y: (display.y || 0) + Math.max(0, Math.min(display.height - 1,
    Math.floor((event.clientY - rect.top) / rect.height * display.height)))};
}

// Translate printable text exactly once. Legacy virtual keys remain for
// shortcuts/navigation, whose meaning is not a character to insert.
export function keyboardEvent(e, down) {
  const printable = [...e.key].length === 1;
  const altGraph = e.getModifierState?.('AltGraph');
  if (printable && (altGraph || !(e.ctrlKey || e.altKey || e.metaKey)))
    return down ? {unicode:e.key.codePointAt(0), down:true, mode:0, modifiers:[]} : null;
  const key = keys[e.key] !== undefined ? {controlKey:keys[e.key]} :
    printable ? {chr:e.key.toLowerCase().codePointAt(0)} : null;
  return key ? {...key, down, mode:0, modifiers:modifiers(e)} : null;
}
const MAX_CLIPBOARD = 1024 * 1024;

export class Viewer {
  constructor(root, {url, exec, input = false, clipboard = false, title = 'SixtoNet Remote Desktop'}) {
    this.root = root; this.url = url; this.exec = exec; this.allowInput = input;
    this.allowClipboard = clipboard; this.remoteClipboard = null; this.title = title;
    root.classList.add('desktop-viewer');
    this.cipher = new Cipher(); this.closed = false; this.control = false;
    this.held = new Map(); this.buttons = new Set(); this.lastFrame = 0; this.lastPacket = 0;
    this.displays = []; this.displayIndex = 0; this.frames = 0; this.bytes = 0;
    this.events = new AbortController(); this.pending = 0;
    const head = element('div', '', 'card-head');
    this.startButton = element('button', 'Start desktop', 'btn sm primary');
    this.controlButton = element('button', 'Take control', 'btn sm');
    this.controlButton.disabled = true;
    this.monitor = element('select', '', 'sel'); this.monitor.setAttribute('aria-label', 'Remote monitor');
    const full = element('button', 'Full screen', 'btn sm');
    const popout = element('button', 'Pop out', 'btn sm');
    const fit = element('button', 'Actual size', 'btn sm');
    const disconnect = element('button', 'Disconnect desktop', 'btn sm');
    const sas = element('button', 'Ctrl+Alt+Delete', 'btn sm');
    sas.disabled = !input;
    const quality = element('select', '', 'sel'); quality.setAttribute('aria-label', 'Stream quality');
    for (const [v,t] of [[2,'Low bandwidth'],[3,'Balanced'],[4,'Best quality']]) {
      const o = element('option',t); o.value = v; quality.append(o);
    }
    quality.value = '3';
    this.status = element('p', 'Ready to start an encrypted desktop stream.', 'sub');
    this.stats = element('span', '', 'sub');
    this.clipStatus = element('p', clipboard ? 'Text clipboard sharing is enabled. Paste here with Ctrl+V; copy remote text with the button.' :
      'Two-way clipboard is off. Enable it when opening the live session.', 'sub');
    const paste = element('button', 'Paste local clipboard', 'btn sm');
    this.copy = element('button', 'Copy remote clipboard', 'btn sm');
    paste.disabled = !clipboard || !input; this.copy.disabled = true;
    this.stage = element('div', '', 'desktop-stage');
    this.canvas = element('canvas'); this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Remote desktop. Take control to use mouse and keyboard.');
    this.canvas.hidden = true; this.stage.append(this.canvas);
    const source = element('a', 'Open-source licences');
    source.href = 'https://github.com/hanvansolo/sixtonet-remote/tree/sixtonet';
    source.target = '_blank'; source.rel = 'noopener noreferrer'; source.className = 'sub';
    head.append(this.startButton, this.controlButton, this.monitor, quality, popout, full, fit, sas, paste, this.copy, disconnect, this.stats);
    root.append(head, this.status, this.clipStatus, this.stage, source);
    const on = (el, name, fn) => el.addEventListener(name, fn, {signal:this.events.signal});
    on(this.startButton, 'click', () => this.start().catch(e => this.fail(e.message)));
    on(this.controlButton, 'click', () => {
      this.releaseInput(); this.control = !this.control;
      this.controlButton.textContent = this.control ? 'Give back control' : 'Take control';
      this.controlButton.classList.toggle('primary', this.control);
      if (this.control) this.canvas.focus();
    });
    on(full, 'click', () => {
      const doc = root.ownerDocument;
      (doc.fullscreenElement ? doc.exitFullscreen() : root.requestFullscreen()).catch(() => {});
    });
    on(popout, 'click', () => this.popOut());
    on(fit, 'click', () => {
      const actual = this.stage.classList.toggle('actual-size');
      fit.textContent = actual ? 'Fit to window' : 'Actual size';
    });
    on(disconnect, 'click', () => { this.status.textContent = 'Desktop disconnected.'; this.close(); });
    on(paste, 'click', () => this.pasteLocal());
    on(this.copy, 'click', () => this.copyRemote());
    on(sas, 'click', () => { if (this.canInput()) this.send({keyEvent:{controlKey:CK.CtrlAltDel, press:true}}); });
    on(quality, 'change', () => this.send({misc:{option:{imageQuality:Number(quality.value)}}}));
    on(this.monitor, 'change', () => {
      this.releaseInput(); this.lastFrame = 0; this.displayIndex = Number(this.monitor.value);
      this.decoder?.reset(); this.configureDecoder();
      this.send({misc:{switchDisplay:{display:this.displayIndex}}});
    });
    this.inputEvents(on);
    on(window, 'blur', () => this.releaseInput());
    on(window, 'pagehide', () => this.close());
    on(document, 'visibilitychange', () => { if (root.ownerDocument === document && document.hidden) this.releaseInput(); });
    this.timer = setInterval(() => {
      if (!root.isConnected) { this.close(); return; }
      this.stats.textContent = this.frames ? `${this.frames} fps · ${(this.bytes * 8 / 1e6).toFixed(1)} Mbps` : '';
      this.frames = 0; this.bytes = 0;
      // A still desktop legitimately produces no delta frames. Use RustDesk's
      // authenticated heartbeat for liveness, not changing pixels.
      if (this.lastFrame && Date.now() - this.lastPacket > 5000) {
        this.releaseInput(); this.control = false; this.controlButton.disabled = true;
        this.status.textContent = 'Waiting for the next desktop frame; control is suspended.';
      }
    }, 1000);
  }

  popOut() {
    if (this.closed) return;
    if (this.popup && !this.popup.closed) { this.popup.focus(); return; }
    const popup = window.open('', '', 'popup=yes,width=1400,height=900,resizable=yes,scrollbars=yes');
    if (!popup) { this.clipStatus.textContent = 'Allow pop-ups for this site, then try Pop out again.'; return; }
    this.releaseInput(); this.popup = popup;
    const doc = popup.document;
    doc.title = this.title;
    const base = doc.createElement('base'); base.href = document.baseURI; doc.head.append(base);
    for (const style of document.querySelectorAll('link[rel="stylesheet"],style')) doc.head.append(style.cloneNode(true));
    doc.body.className = 'desktop-popout';
    this.anchor = document.createComment('desktop pop-out return point');
    this.root.before(this.anchor);
    this.placeholder = element('button', 'Return desktop to this tab', 'btn');
    this.anchor.before(this.placeholder);
    this.placeholder.addEventListener('click', () => this.returnToTab(), {signal:this.events.signal});
    doc.body.append(this.root);
    popup.addEventListener('blur', () => this.releaseInput(), {signal:this.events.signal});
    popup.addEventListener('pagehide', () => this.returnToTab(), {signal:this.events.signal});
    doc.addEventListener('visibilitychange', () => { if (doc.hidden) this.releaseInput(); }, {signal:this.events.signal});
    this.canvas.focus();
  }
  returnToTab() {
    const popup = this.popup;
    if (!popup) return;
    this.popup = null; this.releaseInput();
    this.placeholder?.remove();
    if (this.anchor?.isConnected) this.anchor.replaceWith(this.root);
    else this.close();
    if (!popup.closed) popup.close();
  }
  pasteText(text) {
    if (!this.allowClipboard || !this.canInput()) {
      this.clipStatus.textContent = 'Take control before pasting, with two-way clipboard permission enabled.'; return;
    }
    const content = new TextEncoder().encode(text);
    if (content.length > MAX_CLIPBOARD) { this.clipStatus.textContent = 'Text clipboard is limited to 1 MiB.'; return; }
    this.releaseInput();
    this.send({clipboard:{content, compress:false, format:0}});
    this.send({keyEvent:{chr:118, press:true, modifiers:[CK.Control], mode:0}});
    this.clipStatus.textContent = 'Text sent to the remote clipboard and pasted.';
    this.canvas.focus();
  }
  async pasteLocal() {
    if (!this.allowClipboard || !this.canInput()) { this.pasteText(''); return; }
    try { this.pasteText(await this.root.ownerDocument.defaultView.navigator.clipboard.readText()); }
    catch { this.clipStatus.textContent = 'Browser clipboard access was blocked. Focus the desktop and press Ctrl+V to paste text.'; }
  }
  async copyRemote() {
    if (!this.allowClipboard || this.remoteClipboard === null || this.closed) return;
    try {
      await this.root.ownerDocument.defaultView.navigator.clipboard.writeText(this.remoteClipboard);
      this.clipStatus.textContent = 'Remote text copied to your local clipboard.';
    } catch { this.clipStatus.textContent = 'Allow clipboard writes for this site, then click Copy remote clipboard again.'; }
  }

  async start() {
    if (this.ws) return;
    if (!globalThis.VideoDecoder || !globalThis.EncodedVideoChunk)
      throw Error('This browser does not support WebCodecs. Use a current Chromium browser for this preview.');
    const support = await VideoDecoder.isConfigSupported({codec:'vp09.00.10.08'});
    if (!support.supported) throw Error('This browser cannot decode VP9 desktop video.');
    if (this.closed) return;
    this.startButton.disabled = true; this.status.textContent = 'Connecting to the endpoint desktop engine…';
    this.decoder = new VideoDecoder({output: frame => {
      if (this.closed) { frame.close(); return; }
      if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth;
      if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight;
      this.canvas.getContext('2d', {alpha:false}).drawImage(frame, 0, 0); frame.close();
      this.canvas.hidden = false; this.lastFrame = Date.now(); this.frames++;
      this.controlButton.disabled = !this.allowInput;
      this.status.textContent = this.control ? 'Live · you have mouse and keyboard control' : 'Live · view only';
    }, error: () => this.fail('The browser video decoder failed. End and reopen the desktop.')});
    this.configureDecoder();
    this.ws = new WebSocket(this.url); this.ws.binaryType = 'arraybuffer';
    let sequence = Promise.resolve();
    this.ws.onmessage = event => {
      // Preserve crypto counters across asynchronous password hashing. Bound
      // pending frames; silently dropping encrypted or delta frames is invalid.
      if (++this.pending > 32) { this.fail('The browser cannot keep up with the desktop stream.'); return; }
      sequence = sequence.then(() => this.receive(event.data)).catch(e => this.fail(e.message))
        .finally(() => this.pending--);
    };
    this.ws.onclose = () => { if (!this.closed) this.fail('The desktop connection ended. Reopen the Remote Desktop tab to retry.'); };
    this.ws.onerror = () => this.fail('Could not establish the authenticated desktop connection.');
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once:true});
      this.ws.addEventListener('close', () => reject(Error('Desktop channel was refused')), {once:true});
    });
    const r = await this.exec('desktop_open', '');
    if (!r.ok) throw Error(r.error || 'The endpoint could not start its desktop engine');
  }
  configureDecoder() {
    this.decoder.configure({codec:'vp09.00.10.08', optimizeForLatency:true, hardwareAcceleration:'no-preference'});
    this.needKey = true;
  }
  async receive(data) {
    if (this.closed) return;
    if (typeof data === 'string') {
      if (this.identity || this.cipher.key || data.length > 4096) throw Error('Unexpected desktop identity');
      const info = JSON.parse(data);
      if (!info.id || !Array.isArray(info.public_key) || info.public_key.length !== 32 || !/^[0-9a-f]{64}$/.test(info.password))
        throw Error('Invalid desktop identity');
      this.identity = info; return;
    }
    if (!this.identity || data.byteLength > 8*1024*1024) throw Error('Invalid desktop handshake order');
    this.bytes += data.byteLength;
    const message = this.cipher.decode(new Uint8Array(data));
    this.lastPacket = Date.now();
    if (message.signedId) {
      this.ws.send(this.cipher.handshake(message.signedId.id, this.identity)); return;
    }
    if (!this.cipher.key) throw Error('The endpoint did not establish desktop encryption');
    if (message.hash) {
      if (!this.identity.password) throw Error('Repeated desktop login challenge');
      const password = await passwordResponse(this.identity.password, message.hash.salt, message.hash.challenge);
      this.identity.password = '';
      this.send({loginRequest:{username:this.identity.id, password, myId:'sixtonet-browser',
        myName:'SixtoNet browser operator', version:'1.4.9', myPlatform:'Web', videoAckRequired:true,
        option:{imageQuality:3, customFps:30, disableAudio:2, disableClipboard:this.allowClipboard ? 1 : 2,
          enableFileTransfer:1, disableKeyboard:this.allowInput ? 1 : 2, showRemoteCursor:2,
          supportedDecoding:{abilityVp9:1, prefer:1}}}});
    }
    if (message.loginResponse) {
      if (message.loginResponse.error) throw Error(message.loginResponse.error);
      const peer = message.loginResponse.peerInfo;
      if (!peer?.displays?.length) throw Error('The endpoint reported no capturable displays');
      this.displays = peer.displays; this.displayIndex = peer.currentDisplay || 0;
      this.monitor.replaceChildren(...peer.displays.map((d, i) => {
        const o = element('option', `${d.name || `Monitor ${i+1}`} · ${d.width}×${d.height}`); o.value = i; return o;
      }));
      this.monitor.value = this.displayIndex;
      this.status.textContent = 'Authenticated · waiting for the first video frame…';
    }
    if (message.testDelay && !message.testDelay.fromClient) this.send({testDelay:message.testDelay});
    const clip = message.clipboard || message.multiClipboards?.clipboards?.find(c => c.format === 0);
    if (message.multiClipboards && !clip && this.allowClipboard) {
      this.remoteClipboard = null; this.copy.disabled = true;
    }
    if (clip && this.allowClipboard) {
      if (clip.compress || clip.format !== 0 || clip.content.length > MAX_CLIPBOARD) {
        this.remoteClipboard = null; this.copy.disabled = true;
        this.clipStatus.textContent = 'Remote clipboard format is not supported. Update the desktop preview engine.';
      } else {
        this.remoteClipboard = new TextDecoder('utf-8', {fatal:true}).decode(clip.content);
        this.copy.disabled = false;
        this.clipStatus.textContent = 'Remote text is ready. Click Copy remote clipboard to copy it to this computer.';
      }
    }
    if (message.misc?.closeReason) throw Error(message.misc.closeReason);
    if (message.misc?.switchDisplay) {
      const d = message.misc.switchDisplay;
      if (d.width > 0 && d.height > 0 && this.displays[d.display || 0]) {
        this.displays[d.display || 0] = {...this.displays[d.display || 0],
          x:d.x || 0, y:d.y || 0, width:d.width, height:d.height};
      }
    }
    if (message.misc?.permissionInfo?.permission === 0 && !message.misc.permissionInfo.enabled) {
      this.releaseInput(); this.allowInput = false; this.control = false; this.controlButton.disabled = true;
    }
    if (message.misc?.permissionInfo?.permission === 2 && !message.misc.permissionInfo.enabled) {
      this.allowClipboard = false; this.remoteClipboard = null; this.copy.disabled = true;
    }
    if (message.videoFrame) {
      const video = message.videoFrame;
      if ((video.display || 0) !== this.displayIndex) {
        this.send({misc:{videoReceived:true}}); return;
      }
      if (!video.vp9s) throw Error('The endpoint selected a codec this browser viewer did not negotiate');
      for (const frame of video.vp9s.frames) {
        if (this.needKey && !frame.key) continue;
        if (this.decoder.decodeQueueSize > 6) {
          // Decode backlog must recover at an actual key frame, never by
          // presenting dependent delta frames after dropping their references.
          this.decoder.reset(); this.configureDecoder();
          this.send({misc:{refreshVideo:true}}); break;
        }
        this.needKey = false;
        this.decoder.decode(new EncodedVideoChunk({type:frame.key ? 'key' : 'delta',
          timestamp:Number(frame.pts) * 1000, data:frame.data}));
      }
      this.send({misc:{videoReceived:true}});
    }
  }
  send(message) {
    if (this.closed || !this.cipher.key || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 1024*1024) { this.fail('Desktop input transport is congested.'); return; }
    this.ws.send(this.cipher.encode(message));
  }
  canInput() { return this.control && this.allowInput && this.lastFrame > 0 && Date.now() - this.lastPacket < 5000; }
  inputEvents(on) {
    const c = this.canvas;
    on(c, 'contextmenu', e => { if (this.canInput()) e.preventDefault(); });
    for (const type of ['pointerdown','pointerup','pointermove']) on(c, type, e => {
      if (!this.canInput() || !this.displays[this.displayIndex]) return;
      e.preventDefault();
      const p = pointerPosition(e, c.getBoundingClientRect(), this.displays[this.displayIndex]);
      const button = [1,4,2,8,16][e.button];
      this.send({mouseEvent:{mask:0, ...p, modifiers:modifiers(e)}});
      if (type === 'pointermove' || !button) return;
      const down = type === 'pointerdown';
      if (down) { c.focus(); c.setPointerCapture(e.pointerId); this.buttons.add(button); }
      else { this.buttons.delete(button); if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId); }
      this.send({mouseEvent:{mask:(button << 3) | (down ? 1 : 2), ...p, modifiers:modifiers(e)}});
    });
    on(c, 'pointercancel', () => this.releaseInput());
    on(c, 'blur', () => this.releaseInput());
    on(c, 'paste', e => {
      if (!this.allowClipboard || !this.canInput()) return;
      e.preventDefault(); this.pasteText(e.clipboardData.getData('text/plain'));
    });
    on(c, 'compositionend', e => {
      if (this.canInput() && e.data && e.data.length <= 4096) {
        this.releaseInput(); this.send({keyEvent:{seq:e.data, down:true, mode:0}});
      }
    });
    on(c, 'wheel', e => {
      if (!this.canInput()) return;
      e.preventDefault();
      this.send({mouseEvent:{mask:3, x:-Math.sign(e.deltaX), y:-Math.sign(e.deltaY), modifiers:modifiers(e)}});
    });
    for (const type of ['keydown','keyup']) on(c, type, e => {
      if (!this.canInput() || e.isComposing) return;
      // Leave the browser's paste gesture intact; its paste event carries text
      // without granting background clipboard reads.
      if (this.allowClipboard && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
      const down = type === 'keydown';
      const message = keyboardEvent(e, down);
      if (!message) { if ([...e.key].length === 1) e.preventDefault(); return; }
      e.preventDefault(); e.stopPropagation();
      if (message.unicode === undefined) {
        if (down) this.held.set(e.code, message); else this.held.delete(e.code);
      } else this.releaseInput();
      this.send({keyEvent:message});
    });
  }
  releaseInput() {
    for (const key of this.held.values()) this.send({keyEvent:{...key, down:false, modifiers:[]}});
    for (const button of this.buttons) this.send({mouseEvent:{mask:(button << 3) | 2}});
    this.held.clear(); this.buttons.clear();
  }
  fail(message) { this.status.textContent = message; this.close(); }
  close() {
    if (this.closed) return;
    this.releaseInput(); this.closed = true;
    this.remoteClipboard = null; this.copy.disabled = true;
    clearInterval(this.timer); this.events.abort();
    this.ws?.close(); if (this.decoder?.state !== 'closed') this.decoder?.close();
    this.cipher.close(); if (this.identity) this.identity.password = '';
    this.controlButton.disabled = true; this.startButton.disabled = true;
    if (this.ws) this.exec('desktop_close', '').catch(() => {});
    this.returnToTab();
  }
}
