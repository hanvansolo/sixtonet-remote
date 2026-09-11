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
function buttonLabel(button, label) {
  button.title = label;
  button.setAttribute('aria-label', label);
  const caption = button.querySelector('.desktop-button-label');
  if (caption) caption.textContent = label;
}
function iconButton(label, path, cls = '') {
  const button = element('button', '', `btn sm desktop-icon ${cls}`.trim());
  button.type = 'button';
  buttonLabel(button, label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({viewBox:'0 0 24 24', width:20, height:20,
    fill:'none', stroke:'currentColor', 'stroke-width':1.8, 'stroke-linecap':'round',
    'stroke-linejoin':'round', 'aria-hidden':'true', focusable:'false'})) svg.setAttribute(key, value);
  const shape = document.createElementNS(svg.namespaceURI, 'path');
  shape.setAttribute('d', path); svg.append(shape); button.append(svg);
  button.append(element('span', label, 'desktop-button-label'));
  return button;
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
  constructor(root, {url, exec, input = false, clipboard = false, controlOnConnect = false, title = 'SixtoNet Remote Desktop', returnHost = null, onDisconnect = null}) {
    this.returnHost = returnHost; this.onDisconnect = onDisconnect;
    this.root = root; this.url = url; this.exec = exec; this.allowInput = input;
    this.allowClipboard = clipboard; this.remoteClipboard = null; this.title = title;
    root.classList.add('desktop-viewer');
    this.cipher = new Cipher(); this.closed = false; this.control = input && controlOnConnect;
    this.held = new Map(); this.buttons = new Set(); this.lastFrame = 0; this.lastPacket = 0;
    this.displays = []; this.displayIndex = 0; this.frames = 0; this.bytes = 0;
    this.events = new AbortController(); this.pending = 0;
    this.decodeTimes = new Map(); this.targetFps = 30; this.lastPressure = 0;
    this.lastRateChange = 0; this.recoveries = 0; this.presented = 0;
    const head = element('header', '', 'desktop-session-head');
    const identity = element('div', '', 'desktop-session-identity');
    identity.append(element('span', 'REMOTE RESPONSE', 'desktop-eyebrow'), element('h2', title));
    this.phaseBadge = element('span', 'Ready', 'desktop-phase');
    this.phaseBadge.setAttribute('role', 'status');
    this.phaseBadge.setAttribute('aria-live', 'polite');
    head.append(identity, this.phaseBadge);
    this.startButton = iconButton('Start desktop', 'M8 5l11 7-11 7Z', 'primary');
    this.controlButton = iconButton('Take control', 'M4 3l6 17 3-7 7-3Z M13 13l6 6');
    this.controlButton.setAttribute('aria-pressed', String(this.control));
    buttonLabel(this.controlButton, this.control ? 'Give back control' : 'Take control');
    this.controlButton.classList.toggle('primary', this.control);
    this.controlButton.disabled = true;
    this.monitor = element('select', '', 'sel'); this.monitor.setAttribute('aria-label', 'Remote monitor');
    const full = iconButton('Full screen', 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5');
    const popout = this.popoutButton = iconButton('Pop out', 'M14 3h7v7 M21 3l-9 9 M10 5H4v15h15v-6');
    const scale = this.scale = element('select', '', 'sel');
    scale.setAttribute('aria-label', 'Desktop zoom');
    for (const [value, label] of [['fit','Fit to window'],['100','100% - actual size'],['125','125%'],['150','150%'],['200','200%']]) {
      const option = element('option', label); option.value = value; scale.append(option);
    }
    const focus = iconButton('Focus on screen', 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5');
    focus.setAttribute('aria-pressed', 'false');
    const disconnect = iconButton('Disconnect desktop', 'M12 3v9 M6 5a9 9 0 1 0 12 0', 'danger');
    const sas = this.sasButton = iconButton('Ctrl+Alt+Delete', 'M3 5h18v14H3Z M7 9h.01 M11 9h.01 M15 9h.01 M7 13h.01 M11 13h.01 M15 13h2 M7 16h10');
    sas.disabled = !input;
    const quality = this.quality = element('select', '', 'sel'); quality.setAttribute('aria-label', 'Stream quality');
    for (const [v,t] of [[2,'Low bandwidth'],[3,'Balanced'],[4,'Best quality']]) {
      const o = element('option',t); o.value = v; quality.append(o);
    }
    quality.value = '4';
    this.status = element('p', 'Ready to start an encrypted desktop stream.', 'desktop-status');
    this.stats = element('span', '', 'desktop-stream-stats');
    this.clipStatus = element('p', clipboard ? 'Text clipboard sharing is enabled. Paste here with Ctrl+V; copy remote text with the button.' :
      'Two-way clipboard is off. Enable it when opening the live session.', 'sub');
    const paste = this.pasteButton = iconButton('Paste local clipboard', 'M9 4H5v17h14V4h-4 M9 2h6v4H9Z M12 9v8 M9 14l3 3 3-3');
    this.copy = iconButton('Copy remote clipboard', 'M9 4H5v17h14V4h-4 M9 2h6v4H9Z M12 17V9 M9 12l3-3 3 3');
    paste.disabled = !clipboard || !input; this.copy.disabled = true;
    this.stage = element('div', '', 'desktop-stage');
    this.canvas = element('canvas'); this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Remote desktop. Take control to use mouse and keyboard.');
    this.canvas.hidden = true; this.stage.append(this.canvas);
    this.emptyState = element('div', '', 'desktop-empty-state');
    const screenMark = element('div', '', 'desktop-screen-mark');
    screenMark.setAttribute('aria-hidden', 'true');
    this.emptyTitle = element('h3', 'Your remote workspace');
    this.emptyNote = element('p', 'Start the desktop to authenticate the endpoint and request its picture.');
    this.emptyState.append(screenMark, this.emptyTitle, this.emptyNote);
    this.stage.append(this.emptyState);
    this.stallNotice = element('div', 'Connection stalled. The last picture is not current; remote input is suspended.', 'desktop-stall-notice');
    this.stallNotice.setAttribute('role', 'status');
    this.stallNotice.hidden = true;
    head.append(disconnect);
    const toolbar = element('div', '', 'desktop-session-toolbar');
    const sessionControls = element('div', '', 'desktop-control-group');
    sessionControls.append(this.startButton, this.controlButton);
    const displayControls = element('div', '', 'desktop-control-group desktop-display-controls');
    const monitorLabel = element('label', '', 'desktop-select-field');
    monitorLabel.append(element('span', 'Display'), this.monitor);
    this.monitor.append(element('option', 'Waiting for endpoint'));
    this.monitor.disabled = true;
    const scaleLabel = element('label', '', 'desktop-select-field');
    scaleLabel.append(element('span', 'Zoom'), scale);
    displayControls.append(monitorLabel, scaleLabel, focus, popout, full);
    const tools = iconButton('Session tools', 'M4 7h16 M4 17h16 M8 4v6 M16 14v6');
    tools.setAttribute('aria-expanded', 'false');
    toolbar.append(sessionControls, displayControls, tools);
    const workarea = element('div', '', 'desktop-workarea');
    const panel = element('aside', '', 'desktop-tools-panel');
    panel.setAttribute('aria-label', 'Remote session tools');
    panel.hidden = true;
    panel.append(element('h3', 'Session tools'), element('p', 'Available actions follow this live session\'s permissions.', 'desktop-tool-note'));
    const qualityLabel = element('label', '', 'desktop-select-field');
    qualityLabel.append(element('span', 'Picture quality'), quality);
    const refresh = this.refreshButton = iconButton('Refresh picture', 'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 3 M4 15l2 3a7 7 0 0 0 12-1');
    refresh.disabled = true;
    panel.append(qualityLabel, refresh, element('h4', 'Remote input'));
    this.inputNote = element('p', '', 'desktop-tool-note');
    panel.append(this.inputNote, sas, element('h4', 'Text clipboard'), this.clipStatus, paste, this.copy);
    panel.append(element('p', 'Clipboard text is transferred only through the permitted session. These buttons do not grant new permissions.', 'desktop-tool-note'));
    workarea.append(this.stage, panel);
    const footer = element('footer', '', 'desktop-session-footer');
    this.dimensions = element('span', 'No picture yet');
    this.elapsed = element('span', 'Not authenticated');
    footer.append(this.dimensions, this.stats, this.elapsed);
    this.displayRail = element('nav', '', 'desktop-display-rail');
    this.displayRail.setAttribute('aria-label', 'Remote displays');
    this.displayRail.hidden = true;
    root.append(head, toolbar, this.displayRail, this.status, this.stallNotice, workarea, footer);
    const on = (el, name, fn) => el.addEventListener(name, fn, {signal:this.events.signal});
    on(this.startButton, 'click', () => this.start().catch(e => this.fail(e.message)));
    on(tools, 'click', () => {
      panel.hidden = !panel.hidden;
      workarea.classList.toggle('tools-open', !panel.hidden);
      tools.setAttribute('aria-expanded', String(!panel.hidden));
      tools.classList.toggle('primary', !panel.hidden);
    });
    on(refresh, 'click', () => {
      if (!this.authenticatedAt || this.closed) return;
      this.releaseInput();
      this.send({misc:{refreshVideo:true}});
      this.status.textContent = 'Requested a fresh picture from the endpoint.';
    });
    on(this.controlButton, 'click', () => {
      this.releaseInput(); this.control = !this.control;
      buttonLabel(this.controlButton, this.control ? 'Give back control' : 'Take control');
      this.controlButton.setAttribute('aria-pressed', String(this.control));
      this.controlButton.classList.toggle('primary', this.control);
      this.updateChrome();
      if (this.control) this.canvas.focus();
    });
    on(full, 'click', () => {
      const doc = root.ownerDocument;
      (doc.fullscreenElement ? doc.exitFullscreen() : root.requestFullscreen()).catch(() => {});
    });
    on(popout, 'click', () => this.popOut());
    on(scale, 'change', () => {
      this.releaseInput();
      this.stage.scrollTop = this.stage.scrollLeft = 0;
      this.updateChrome();
    });
    on(focus, 'click', () => {
      this.releaseInput();
      const focused = root.classList.toggle('desktop-focused');
      focus.setAttribute('aria-pressed', String(focused));
      buttonLabel(focus, focused ? 'Show session details' : 'Focus on screen');
    });
    on(disconnect, 'click', () => { this.status.textContent = 'Desktop disconnected.'; this.close(); });
    on(paste, 'click', () => this.pasteLocal());
    on(this.copy, 'click', () => this.copyRemote());
    on(sas, 'click', () => { if (this.canInput()) this.send({keyEvent:{controlKey:CK.CtrlAltDel, press:true}}); });
    on(quality, 'change', () => this.send({misc:{option:{imageQuality:Number(quality.value),customFps:this.targetFps}}}));
    on(this.monitor, 'change', () => {
      this.releaseInput(); this.lastFrame = 0; this.displayIndex = Number(this.monitor.value);
      this.clearPresentation(); this.decodeTimes.clear();
      this.decoder?.reset(); if (this.decoder) this.configureDecoder();
      this.send({misc:{switchDisplay:{display:this.displayIndex}}});
      this.updateChrome();
    });
    this.inputEvents(on);
    on(window, 'blur', () => this.releaseInput());
    on(window, 'pagehide', () => this.close());
    on(document, 'visibilitychange', () => { if (root.ownerDocument === document && document.hidden) this.releaseInput(); });
    this.timer = setInterval(() => {
      if (!root.isConnected) { this.close(); return; }
      this.stats.textContent = this.frames ? `${this.frames} fps · ${(this.bytes * 8 / 1e6).toFixed(1)} Mbps` : '';
      this.frames = 0; this.bytes = 0;
      // Restore FPS slowly after decoder pressure subsides; preserve the
      // user's image-quality choice rather than making text blurrier.
      if (this.authenticatedAt && this.targetFps < 30 && performance.now() - this.lastPressure > 8000 &&
          performance.now() - this.lastRateChange > 3000 && this.decodeTimes.size < 2)
        this.setFrameRate(Math.min(30,this.targetFps + 5));
      if (this.authenticatedAt && !this.lastFrame && Date.now() - this.authenticatedAt > 15000)
        this.status.textContent = 'Connected to Windows, but capture has not produced a video frame. Desktop control is disabled.';
      // A still desktop legitimately produces no delta frames. Use RustDesk's
      // authenticated heartbeat for liveness, not changing pixels.
      if (this.lastFrame && Date.now() - this.lastPacket > 5000) {
        this.releaseInput(); this.controlButton.disabled = true;
        this.status.textContent = 'Waiting for the next desktop frame; control is suspended.';
      }
      this.updateChrome();
    }, 1000);
    this.updateChrome();
  }

  updateChrome() {
    if (this.closed) return;
    const now = Date.now();
    const live = this.lastFrame > 0 && now - this.lastPacket < 5000;
    this.root.dataset.connection = live ? 'live' : 'waiting';
    this.stallNotice.hidden = !(this.lastFrame > 0 && !live);
    const actual = this.scale.value !== 'fit';
    this.stage.classList.toggle('actual-size', actual);
    this.canvas.style.width = actual ? `${this.canvas.width * Number(this.scale.value) / 100}px` : '';
    this.canvas.style.height = actual ? `${this.canvas.height * Number(this.scale.value) / 100}px` : '';
    const displaySignature = JSON.stringify([this.displays, this.displayIndex, !!this.authenticatedAt]);
    if (displaySignature !== this.displaySignature) {
      this.displaySignature = displaySignature;
      this.displayRail.replaceChildren();
      this.displayRail.hidden = this.displays.length < 2;
      this.displays.forEach((display, index) => {
        const choice = element('button', '', 'desktop-display-choice');
        choice.type = 'button';
        choice.append(element('strong', `Display ${index + 1}`),
          element('span', `${display.name || 'Monitor'} / ${display.width} x ${display.height}`));
        choice.setAttribute('aria-pressed', String(index === this.displayIndex));
        choice.disabled = !this.authenticatedAt;
        choice.addEventListener('click', () => {
          if (index === this.displayIndex || this.closed) return;
          this.monitor.value = String(index);
          this.monitor.dispatchEvent(new Event('change'));
        }, {signal:this.events.signal});
        this.displayRail.append(choice);
      });
    }
    const phase = live ? (this.canInput() ? 'Live - controlling' : 'Live - view only') :
      this.lastFrame ? 'Connection stalled' : this.authenticatedAt ? 'Waiting for video' :
      this.ws ? 'Authenticating' : 'Ready';
    if (this.phaseBadge.textContent !== phase) this.phaseBadge.textContent = phase;
    this.phaseBadge.dataset.state = live ? 'live' : this.ws ? 'waiting' : 'ready';
    this.emptyState.hidden = this.lastFrame > 0;
    this.emptyTitle.textContent = this.authenticatedAt ? 'Waiting for the endpoint picture' :
      this.ws ? 'Establishing your remote session' : 'Your remote workspace';
    this.emptyNote.textContent = this.authenticatedAt ?
      'Windows has authenticated. Control stays unavailable until a video frame arrives.' :
      this.ws ? 'Checking the endpoint identity and establishing the encrypted desktop channel.' :
      'Start the desktop to authenticate the endpoint and request its picture.';
    this.refreshButton.disabled = !this.authenticatedAt;
    this.sasButton.disabled = !this.canInput();
    this.pasteButton.disabled = !this.allowClipboard || !this.canInput();
    this.monitor.disabled = !this.authenticatedAt || this.displays.length < 2;
    if (this.popup) this.displays.forEach((display, index) => {
      const option = this.monitor.options[index];
      if (option) option.textContent = `Display ${index + 1} (${display.width} x ${display.height})`;
    });
    this.inputNote.textContent = !this.allowInput ? 'View-only grant. Remote input is not permitted.' :
      !live ? 'Input is suspended until the picture and connection are ready.' :
      this.control ? 'You have control. Focus the picture to send mouse and keyboard input.' :
      'Input is permitted but switched off. Use Take control to enable it.';
    if (this.authenticatedAt) {
      const seconds = Math.max(0, Math.floor((now - this.authenticatedAt) / 1000));
      this.elapsed.textContent = `Authenticated ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    this.dimensions.textContent = this.lastFrame ?
      `${this.canvas.width} x ${this.canvas.height} / Display ${this.displayIndex + 1}` : 'No picture yet';
  }

  popOut() {
    if (this.closed) return;
    if (this.popup && !this.popup.closed) { this.popup.focus(); return; }
    const popup = window.open('', '', 'popup=yes,width=1400,height=900,resizable=yes,scrollbars=yes');
    if (!popup) { this.clipStatus.textContent = 'Allow pop-ups for this site, then try Pop out again.'; return; }
    this.releaseInput(); this.clearPresentation(); this.popup = popup;
    const doc = popup.document;
    doc.title = this.title;
    for (const sheet of document.styleSheets) {
      if (sheet.disabled) continue;
      try {
        // Snapshot the already loaded same-origin console styles. A blank
        // auxiliary window must not depend on a second stylesheet fetch.
        const copy = new popup.CSSStyleSheet();
        copy.replaceSync([...sheet.cssRules].map(rule => rule.cssText).join('\n'));
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, copy];
      } catch {
        if (sheet.href) {
          const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = sheet.href; doc.head.append(link);
        }
      }
    }
    doc.body.className = 'desktop-popout';
    const popoutIconPaths = {
      'Start desktop':'M9 5l11 7-11 7V5Z M4 5v14',
      'Take control':'M5 3v16l4-4 4 6 3-2-4-6h7L5 3Z',
      'Give back control':'M5 3v16l4-4 4 6 3-2-4-6h7L5 3Z',
      'Full screen':'M9 3H3v6 M15 3h6v6 M3 15v6h6 M21 15v6h-6',
      'Focus on screen':'M3 8V4h4 M17 4h4v4 M21 16v4h-4 M7 20H3v-4 M8 8h8v8H8Z',
      'Show session details':'M3 8V4h4 M17 4h4v4 M21 16v4h-4 M7 20H3v-4 M8 8h8v8H8Z',
      'Actual size':'M4 4h16v16H4Z M8 9l2-2v10 M14 9l2-2v10',
      'Fit to window':'M4 4h16v16H4Z M8 9l2-2v10 M14 9l2-2v10',
      'Session tools':'M4 6h8 M16 6h4 M4 12h2 M10 12h10 M4 18h10 M18 18h2 M12 3v6 M6 9v6 M14 15v6',
      'Refresh picture':'M20 10a8 8 0 0 0-14-5L3 8 M3 3v5h5 M4 14a8 8 0 0 0 14 5l3-3 M16 16h5v5',
      'Disconnect desktop':'M12 2v10 M7 5a8 8 0 1 0 10 0',
      'Ctrl+Alt+Delete':'M3 5h18v14H3Z M7 9h1 M11 9h1 M15 9h2 M7 13h1 M11 13h1 M15 13h2 M8 16h8',
      'Paste local clipboard':'M8 4H5v17h14V4h-3 M8 2h8v4H8Z M12 9v8 M9 14l3 3 3-3',
      'Copy remote clipboard':'M8 8h12v13H8Z M16 8V3H3v13h5'
    };
    this.popoutIcons = [];
    this.root.querySelectorAll('.desktop-icon').forEach(button => {
      const path = button.querySelector('svg path');
      const replacement = popoutIconPaths[button.getAttribute('aria-label')];
      if (!path || !replacement) return;
      this.popoutIcons.push([path, path.getAttribute('d')]);
      path.setAttribute('d', replacement);
    });
    this.anchor = document.createComment('desktop pop-out return point');
    this.root.before(this.anchor);
    this.placeholder = element('button', 'Return desktop to this tab', 'btn');
    this.anchor.before(this.placeholder);
    this.placeholder.addEventListener('click', () => this.returnToTab(), {signal:this.events.signal});
    doc.body.append(this.root);
    this.popoutButton.hidden = true;
    popup.addEventListener('blur', () => this.releaseInput(), {signal:this.events.signal});
    popup.addEventListener('pagehide', () => this.returnToTab(), {signal:this.events.signal});
    doc.addEventListener('visibilitychange', () => { if (doc.hidden) this.releaseInput(); }, {signal:this.events.signal});
    this.canvas.focus();
  }
  returnToTab() {
    const popup = this.popup;
    if (!popup) return;
    for (const [path, original] of this.popoutIcons || []) path.setAttribute('d', original);
    this.popoutIcons = [];
    const host = !this.closed && !this.anchor?.isConnected ? this.returnHost?.() : null;
    this.popup = null; this.releaseInput(); this.clearPresentation();
    this.popoutButton.hidden = false;
    this.placeholder?.remove();
    if (this.anchor?.isConnected) this.anchor.replaceWith(this.root);
    else if (host?.isConnected) host.replaceChildren(this.root);
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
    this.createDecoder();
    this.ws = new WebSocket(this.url); this.ws.binaryType = 'arraybuffer';
    let sequence = Promise.resolve();
    this.ws.onmessage = event => {
      // Preserve crypto counters across asynchronous password hashing. Bound
      // pending frames; silently dropping encrypted or delta frames is invalid.
      if (++this.pending > 32) { this.fail('The browser cannot keep up with the desktop stream.'); return; }
      sequence = sequence.then(() => this.receive(event.data)).catch(e => this.fail(e.message))
        .finally(() => this.pending--);
    };
    this.ws.onclose = event => { if (!this.closed) this.fail(event.reason || `The desktop connection ended (WebSocket ${event.code}).`); };
    this.ws.onerror = () => this.fail('The desktop network connection failed.');
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once:true});
      this.ws.addEventListener('close', () => reject(Error('Desktop channel was refused')), {once:true});
    });
    const r = await this.exec('desktop_open', '');
    if (!r.ok) throw Error(r.error || 'The endpoint could not start its desktop engine');
  }
  createDecoder() {
    const decoder = new VideoDecoder({output: frame => {
      if (this.decoder !== decoder) { frame.close(); return; }
      if (this.closed) { frame.close(); return; }
      this.decodeTimes.delete(frame.timestamp);
      this.queuePresentation(frame);
    }, error: () => { if (this.decoder === decoder) this.recoverDecoder(); }});
    this.decoder = decoder;
    this.configureDecoder();
  }
  recoverDecoder() {
    if (this.closed) return;
    const now = performance.now();
    this.decoderErrors = (this.decoderErrors || []).filter(at => now - at < 60000);
    if (this.decoderErrors.length >= 3) {
      this.fail('The browser video decoder repeatedly failed. Reconnect to retry.'); return;
    }
    this.decoderErrors.push(now);
    this.releaseInput(); this.lastFrame = 0; this.controlButton.disabled = true;
    this.clearPresentation(); this.decodeTimes.clear();
    if (this.decoder?.state !== 'closed') this.decoder?.close();
    try { this.createDecoder(); }
    catch { this.fail('The browser could not restart its video decoder.'); return; }
    this.recoveries++;
    this.status.textContent = 'Recovering video; waiting for a complete frame. Control is suspended.';
    this.lastPressure = now;
    this.setFrameRate(10);
    this.send({misc:{refreshVideo:true}});
  }
  configureDecoder() {
    this.decoder.configure({codec:'vp09.00.10.08', optimizeForLatency:true, hardwareAcceleration:'no-preference'});
    this.needKey = true;
  }
  clearPresentation() {
    if (this.paintWindow && this.paintRequest != null) this.paintWindow.cancelAnimationFrame(this.paintRequest);
    this.paintRequest = null; this.paintWindow = null;
    this.latestFrame?.close(); this.latestFrame = null;
  }
  queuePresentation(frame) {
    // Discard only decoded images, never encoded inter-frame references. Hold
    // one image for the visible window's next repaint, including in a pop-out.
    this.latestFrame?.close(); this.latestFrame = frame;
    if (this.paintRequest != null) return;
    this.paintWindow = this.root.ownerDocument.defaultView;
    this.paintRequest = this.paintWindow.requestAnimationFrame(() => {
      this.paintRequest = null;
      const image = this.latestFrame; this.latestFrame = null;
      if (!image) return;
      try {
        if (this.closed) return;
        if (this.canvas.width !== image.displayWidth) this.canvas.width = image.displayWidth;
        if (this.canvas.height !== image.displayHeight) this.canvas.height = image.displayHeight;
        this.canvas.getContext('2d', {alpha:false}).drawImage(image, 0, 0);
        this.canvas.hidden = false; this.lastFrame = Date.now(); this.frames++; this.presented++;
        this.emptyState.hidden = true;
        this.controlButton.disabled = !this.allowInput;
        this.status.textContent = this.control ? 'Live · you have mouse and keyboard control' : 'Live · view only';
      } finally { image.close(); }
    });
  }
  setFrameRate(fps) {
    if (fps === this.targetFps) return;
    this.targetFps = fps; this.lastRateChange = performance.now();
    this.send({misc:{option:{customFps:fps}}});
  }
  decodeVideo(frame) {
    if (this.needKey && !frame.key) return;
    const now = performance.now();
    const oldest = this.decodeTimes.values().next().value;
    if (this.decodeTimes.size >= 4 || this.decoder.decodeQueueSize >= 4) {
      this.lastPressure = now;
      if (now - this.lastRateChange > 1000) this.setFrameRate(Math.max(10,Math.floor(this.targetFps / 2)));
    }
    // A short burst is not corruption. Recover at a keyframe only after the
    // latency or queue budget is exhausted, instead of repeatedly resetting.
    if (this.decodeTimes.size >= 20 || this.decoder.decodeQueueSize >= 20 || (oldest != null && now - oldest > 500)) {
      this.releaseInput(); this.lastFrame = 0;
      this.controlButton.disabled = true;
      this.clearPresentation(); this.decodeTimes.clear();
      this.decoder.reset(); this.configureDecoder(); this.recoveries++;
      this.status.textContent = 'Recovering the desktop stream; waiting for a complete frame.';
      this.setFrameRate(10);
      this.send({misc:{refreshVideo:true}});
      if (!frame.key) return;
    }
    this.needKey = false;
    const timestamp = Number(frame.pts) * 1000;
    this.decodeTimes.set(timestamp,now);
    try {
      this.decoder.decode(new EncodedVideoChunk({type:frame.key ? 'key' : 'delta',timestamp,data:frame.data}));
    } catch { this.recoverDecoder(); }
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
    if (this.lastFrame) {
      this.controlButton.disabled = !this.allowInput;
      this.status.textContent = this.control ? 'Live · you have mouse and keyboard control' : 'Live · view only';
    }
    if (message.signedId) {
      this.ws.send(this.cipher.handshake(message.signedId.id, this.identity)); return;
    }
    if (!this.cipher.key) throw Error('The endpoint did not establish desktop encryption');
    if (message.hash) {
      if (!this.identity.password) throw Error('Repeated desktop login challenge');
      const password = await passwordResponse(this.identity.password, message.hash.salt, message.hash.challenge);
      this.identity.password = '';
      this.send({loginRequest:{username:this.identity.id, password, myId:'sixtonet-browser',
        // Native transport backpressure replaces the per-frame browser round
        // trip. Decoder pressure feeds back a bounded frame-rate request.
        myName:'SixtoNet browser operator', version:'1.4.9', myPlatform:'Web', videoAckRequired:false,
        option:{imageQuality:Number(this.quality.value), customFps:this.targetFps, disableAudio:2, disableClipboard:this.allowClipboard ? 1 : 2,
          enableFileTransfer:1, disableKeyboard:this.allowInput ? 1 : 2, showRemoteCursor:2,
          supportedDecoding:{abilityVp9:1, prefer:1}}}});
    }
    if (message.loginResponse) {
      if (message.loginResponse.error) throw Error(message.loginResponse.error);
      const peer = message.loginResponse.peerInfo;
      if (!peer?.displays?.length) throw Error('The endpoint reported no capturable displays');
      this.displays = peer.displays; this.displayIndex = peer.currentDisplay || 0;
      this.authenticatedAt = Date.now();
      if (peer.windowsSessions) {
        // Some Windows hosts wait for confirmation before subscribing video.
        // Confirm only the session selected by the endpoint, never switch users.
        this.send({misc:{selectedSid:peer.windowsSessions.currentSid || 0}});
      }
      this.monitor.replaceChildren(...peer.displays.map((d, i) => {
        const o = element('option', `${d.name || `Monitor ${i+1}`} · ${d.width}×${d.height}`); o.value = i; return o;
      }));
      this.monitor.value = this.displayIndex;
      this.updateChrome();
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
        return;
      }
      if (!video.vp9s) throw Error('The endpoint selected a codec this browser viewer did not negotiate');
      for (const frame of video.vp9s.frames) this.decodeVideo(frame);
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
      if (down) { c.focus({preventScroll:true}); c.setPointerCapture(e.pointerId); this.buttons.add(button); }
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
    const held = [...this.held.values()], buttons = [...this.buttons];
    this.held.clear(); this.buttons.clear();
    for (const key of held) this.send({keyEvent:{...key, down:false, modifiers:[]}});
    for (const button of buttons) this.send({mouseEvent:{mask:(button << 3) | 2}});
    this.held.clear(); this.buttons.clear();
  }
  fail(message) {
    if (this.closed) return;
    this.failureMessage = message;
    this.status.textContent = message; this.close();
    this.onDisconnect?.(message);
  }
  close() {
    if (this.closed) return;
    if (this.closing) return;
    this.closing = true;
    this.releaseInput(); this.closed = true;
    this.remoteClipboard = null; this.copy.disabled = true;
    clearInterval(this.timer); this.events.abort();
    this.clearPresentation(); this.decodeTimes.clear();
    this.ws?.close(); if (this.decoder?.state !== 'closed') this.decoder?.close();
    this.cipher.close(); if (this.identity) this.identity.password = '';
    this.controlButton.disabled = true; this.startButton.disabled = true;
    if (this.ws) this.exec('desktop_close', '').catch(() => {});
    const doc = this.root.ownerDocument;
    if (doc.fullscreenElement && (doc.fullscreenElement === this.root || this.root.contains(doc.fullscreenElement))) {
      doc.exitFullscreen().catch(() => {});
    }
    this.canvas.hidden = true; this.canvas.width = this.canvas.height = 0;
    const dismiss = element('button', 'Close remote view', 'btn');
    // Cleanup aborted the streaming listeners; this local close action must remain usable.
    dismiss.addEventListener('click', () => { this.root.hidden = true; });
    const ended = element('section', '', 'desktop-ended');
    ended.append(element('span', 'SESSION ENDED', 'desktop-eyebrow'),
      element('h3', this.failureMessage ? 'Desktop connection interrupted' : 'Desktop disconnected'),
      this.status, element('p', 'Remote input has been released and this viewer\'s clipboard state cleared.', 'desktop-tool-note'), dismiss);
    this.root.replaceChildren(ended);
    this.returnToTab();
  }
}
