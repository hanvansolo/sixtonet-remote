import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

test('explicit control-on-connect waits for video and cannot override a view-only grant', async ({page})=>{
  await page.route('https://desktop.test/**', route=>route.fulfill({contentType:route.request().url().endsWith('fixture.js')?'application/javascript':'text/html',
    body:route.request().url().endsWith('fixture.js')?readFileSync('dist/browser-fixture.js'):'<div id="viewer"></div><script src="/fixture.js"></script>'}));
  await page.goto('https://desktop.test/?control');
  expect(await page.evaluate(()=>viewer.canInput())).toBeFalsy();
  await page.getByRole('button',{name:'Start desktop'}).click();
  await expect(page.getByText('Live · you have mouse and keyboard control',{exact:true})).toBeVisible({timeout:15000});
  await page.locator('canvas').click({position:{x:100,y:100}});
  expect(await page.evaluate(()=>observed.mouse.length)).toBeGreaterThan(0);
  await page.goto('https://desktop.test/?control&viewonly');
  await page.getByRole('button',{name:'Start desktop'}).click();
  await expect(page.getByText('Live · view only',{exact:true})).toBeVisible({timeout:15000});
  expect(await page.evaluate(()=>viewer.canInput())).toBeFalsy();
});

test('real browser decrypts VP9 inter-frames, gates input and releases held keys', async ({page})=>{
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://desktop.test/**',route=>{
    const script=route.request().url().endsWith('fixture.js');
    const css=route.request().url().endsWith('style.css');
    return route.fulfill({status:200,contentType:script?'application/javascript':css?'text/css':'text/html',
      headers:{'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; connect-src 'self'"},
      body:script?readFileSync('dist/browser-fixture.js'):css?
        'body{background:#202128;color:white;font:16px sans-serif;margin:24px}.card-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}canvas{width:100%;height:auto}button,select{padding:8px;background:#343544;color:white;border:1px solid #555;border-radius:5px}.sub{color:#aaa}a{color:#aaa}':
        '<!doctype html><html><head><meta charset="utf-8"><title>SixtoNet desktop test</title><link rel="stylesheet" href="/style.css"></head><body><h1>Remote Desktop — protocol test</h1><div id="viewer"></div><script src="/fixture.js"></script></body></html>'});
  });
  await page.goto('https://desktop.test/');
  const buttons = page.locator('.desktop-icon');
  await expect(buttons).toHaveCount(9);
  for (const button of await buttons.all()) {
    await expect(button.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    await expect(button).toHaveText('');
    await expect(button).toHaveAttribute('title', await button.getAttribute('aria-label'));
  }
  await expect(page.getByRole('link',{name:'Open-source licences',exact:true})).toHaveCount(0);
  await expect(page.getByText('RustDesk engine · source',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Start desktop'}).click();
  await expect(page.getByText('Live · view only',{exact:true})).toBeVisible({timeout:15000});
  expect(await page.evaluate(()=>observed.selectedSessions)).toEqual([2]);
  const c=page.locator('canvas');
  await c.click({position:{x:500,y:250}});
  expect(await page.evaluate(()=>observed.mouse.length)).toBe(0);
  await page.getByRole('button',{name:'Take control',exact:true}).click();
  await expect(page.getByRole('button',{name:'Give back control'})).toHaveAttribute('aria-pressed','true');
  await c.click({position:{x:400,y:220}});
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.getByRole('button',{name:'Give back control'}).click();
  const seen=await page.evaluate(()=>observed);
  expect(seen.mouse.some(m=>(m.mask&7)===1)).toBe(true);
  expect(seen.keys.some(k=>k.controlKey===4 && k.down===false), JSON.stringify(seen.keys)).toBe(true);
  expect(seen.codecErrors).toEqual([]);expect(errors).toEqual([]);
  await page.keyboard.up('Control');
  await page.getByRole('button',{name:'Take control',exact:true}).click();
  await page.keyboard.press('A');
  await page.keyboard.press('!');
  const typed = await page.evaluate(()=>observed.keys.filter(k=>k.unicode).map(k=>k.unicode));
  expect(typed).toEqual([65,33]);
  await page.evaluate(()=>sendRemoteClipboard('MUST NOT READ'));
  await expect(page.getByRole('button',{name:'Copy remote clipboard'})).toBeDisabled();
  expect(await page.evaluate(()=>viewer.remoteClipboard)).toBeNull();
  const popupPromise=page.waitForEvent('popup');
  await page.getByRole('button',{name:'Pop out',exact:true}).click();
  const popup=await popupPromise;
  await expect(popup.getByRole('button',{name:'Pop out',exact:true})).toHaveCount(0);
  await expect(popup.locator('button[aria-label="Pop out"]')).toBeHidden();
  await popup.getByRole('button',{name:'Actual size',exact:true}).click();
  await expect(popup.getByRole('button',{name:'Fit to window'})).toHaveAttribute('title','Fit to window');
  await expect(popup.getByRole('button',{name:'Fit to window'}).locator('svg')).toHaveCount(1);
  await popup.getByRole('button',{name:'Fit to window'}).click();
  await expect(popup.locator('canvas')).toBeVisible();
  await expect(popup.locator('body')).toHaveCSS('background-color','rgb(32, 33, 40)');
  await popup.locator('canvas').focus();
  await popup.keyboard.press('Z');
  expect(await page.evaluate(()=>observed.keys.some(k=>k.unicode===90))).toBe(true);
  expect(await page.evaluate(()=>observed.commands.filter(c=>c==='desktop_open').length)).toBe(1);
  await page.getByRole('button',{name:'Return desktop to this tab'}).click();
  await expect(c).toBeVisible();
  await expect(page.getByRole('button',{name:'Pop out',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>viewer.closed)).toBe(false);
  await page.screenshot({path:'test-results/viewer.png',fullPage:true});
  await page.evaluate(()=>viewer.close());
  expect(await page.evaluate(()=>observed.closed)).toBe(true);
});

test('clipboard uses explicit grant and gestures; no automatic local reads or writes', async ({page})=>{
  await page.route('https://desktop.test/**',route=>route.fulfill({status:200,
    contentType:route.request().url().endsWith('fixture.js')?'application/javascript':'text/html',
    body:route.request().url().endsWith('fixture.js')?readFileSync('dist/browser-fixture.js'):
      '<!doctype html><div id="viewer"></div><script src="/fixture.js"></script>'}));
  await page.goto('https://desktop.test/?clipboard');
  await page.getByRole('button',{name:'Start desktop'}).click();
  await expect(page.getByText('Live · view only',{exact:true})).toBeVisible({timeout:15000});
  await page.evaluate(()=>sendRemoteClipboard('Remote MiXeD £ text'));
  await expect(page.getByRole('button',{name:'Copy remote clipboard'})).toBeEnabled();
  expect(await page.evaluate(()=>observed.localWrites)).toEqual([]);
  expect(await page.evaluate(()=>observed.localReads)).toBe(0);
  await page.getByRole('button',{name:'Copy remote clipboard'}).click();
  expect(await page.evaluate(()=>observed.localWrites)).toEqual(['Remote MiXeD £ text']);
  await page.getByRole('button',{name:'Take control',exact:true}).click();
  await page.getByRole('button',{name:'Paste local clipboard'}).click();
  expect(await page.evaluate(()=>observed.clipboard)).toEqual(['Local £ clipboard']);
  expect(await page.evaluate(()=>observed.keys.some(k=>k.chr===118 && k.press))).toBe(true);
  await page.locator('canvas').evaluate(c=>{
    const data=new DataTransfer(); data.setData('text/plain','Pasted £ A');
    c.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
  });
  expect(await page.evaluate(()=>observed.clipboard.at(-1))).toBe('Pasted £ A');
  await page.evaluate(()=>sendRemoteClipboard('unsupported',{compress:true}));
  await expect(page.getByRole('button',{name:'Copy remote clipboard'})).toBeDisabled();
  await page.evaluate(()=>viewer.close());
  expect(await page.evaluate(()=>viewer.remoteClipboard)).toBeNull();
});

test('quality survives connection and a delayed relay no longer serialises each video frame',async({page})=>{
  await page.route('https://desktop.test/**',route=>route.fulfill({status:200,
    contentType:route.request().url().endsWith('fixture.js')?'application/javascript':'text/html',
    body:route.request().url().endsWith('fixture.js')?readFileSync('dist/browser-fixture.js'):
      '<!doctype html><div id="viewer"></div><script src="/fixture.js"></script>'}));
  await page.goto('https://desktop.test/?lag=75');
  await expect(page.getByLabel('Stream quality')).toHaveValue('4');
  await page.getByLabel('Stream quality').selectOption('2');
  await page.getByRole('button',{name:'Start desktop'}).click();
  await expect(page.getByText('Live · view only',{exact:true})).toBeVisible({timeout:15000});
  expect(await page.evaluate(()=>observed.login)).toEqual({videoAckRequired:false,imageQuality:2});
  const before=await page.evaluate(()=>({count:viewer.presented,at:performance.now()}));
  await expect.poll(()=>page.evaluate(()=>viewer.presented),{timeout:4000}).toBeGreaterThan(before.count+30);
  const sample=await page.evaluate(()=>({count:viewer.presented,at:performance.now(),resets:viewer.recoveries}));
  const fps=(sample.count-before.count)*1000/(sample.at-before.at);
  expect(fps).toBeGreaterThan(12); // Stop-and-wait at 150ms RTT cannot exceed ~6.7fps.
  expect(sample.resets).toBe(0);
  console.log(`Delayed synthetic relay (150ms RTT): ${fps.toFixed(1)} presented fps, ${sample.resets} recoveries`);
  await page.getByLabel('Stream quality').selectOption('4');
  await expect.poll(()=>page.evaluate(()=>observed.options.some(o=>o.imageQuality===4))).toBe(true);
  const popupPromise=page.waitForEvent('popup');
  await page.getByRole('button',{name:'Pop out',exact:true}).click();
  const popup=await popupPromise;
  await expect.poll(()=>page.evaluate(()=>viewer.paintWindow===viewer.popup)).toBe(true);
  await expect(popup.locator('canvas')).toBeVisible();
  await page.evaluate(()=>viewer.close());
  expect(await page.evaluate(()=>({pending:viewer.latestFrame,decode:viewer.decodeTimes.size}))).toEqual({pending:null,decode:0});
});


test('transient stalls preserve control intent and congestion closes without recursion', async ({page}) => {
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://desktop.test/**',route=>route.fulfill({status:200,
    contentType:route.request().url().endsWith('fixture.js')?'application/javascript':'text/html',
    body:route.request().url().endsWith('fixture.js')?readFileSync('dist/browser-fixture.js'):
      '<!doctype html><div id="viewer"></div><script src="/fixture.js"></script>'}));
  await page.goto('https://desktop.test/');
  await page.getByRole('button',{name:'Start desktop'}).click();
  await expect(page.getByText('Live · view only',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Take control',exact:true}).click();
  await page.evaluate(()=>{
    // Exhaust the decoder latency budget while the user has control.
    viewer.decodeTimes.set(-1,performance.now()-1000);
  });
  await expect.poll(()=>page.evaluate(()=>viewer.recoveries)).toBeGreaterThan(0);
  await expect.poll(()=>page.evaluate(()=>viewer.canInput())).toBe(true);
  await expect(page.getByRole('button',{name:'Give back control'})).toHaveAttribute('aria-pressed','true');
  // Simulate lost heartbeat while the desktop is still; resume with authenticated traffic.
  await page.evaluate(()=>{window.savedReceive=viewer.receive.bind(viewer);viewer.receive=async()=>{};viewer.lastPacket=Date.now()-6000;});
  await expect(page.getByRole('button',{name:'Give back control'})).toBeDisabled();
  expect(await page.evaluate(()=>viewer.canInput())).toBe(false);
  await page.evaluate(()=>{viewer.receive=savedReceive;viewer.cipher.decode=()=>({testDelay:{fromClient:true}});});
  await expect(page.getByRole('button',{name:'Give back control'})).toBeEnabled();
  expect(await page.evaluate(()=>viewer.canInput())).toBe(true);
  await page.evaluate(()=>{
    viewer.held.set('Control',{controlKey:4,down:true});
    viewer.ws.bufferedAmount=2*1024*1024;
    viewer.send({mouseEvent:{mask:0,x:1,y:1}});
  });
  expect(await page.evaluate(()=>viewer.closed)).toBe(true);
  expect(await page.evaluate(()=>observed.commands.filter(x=>x==='desktop_close').length)).toBe(1);
  expect(errors).toEqual([]);
});

test('popout returns to a fresh console host after its original pane is removed', async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://desktop.test/**',route=>route.fulfill({status:200,
    contentType:route.request().url().endsWith('fixture.js')?'application/javascript':'text/html',
    body:route.request().url().endsWith('fixture.js')?readFileSync('dist/browser-fixture.js'):
      '<!doctype html><div id="pane"><div id="viewer"></div></div><script src="/fixture.js"></script>'}));
  await page.goto('https://desktop.test/');
  await page.getByRole('button',{name:'Start desktop'}).click();
  await expect(page.locator('canvas')).toBeVisible();
  const opened=page.waitForEvent('popup');
  await page.getByRole('button',{name:'Pop out',exact:true}).click();
  const popup=await opened;
  await page.evaluate(()=>{
    document.querySelector('#pane').replaceChildren();
    viewer.returnHost=()=>document.querySelector('#pane');
  });
  await popup.close();
  await expect(page.locator('canvas')).toBeVisible();
  expect(await page.evaluate(()=>viewer.closed)).toBe(false);
  expect(await page.evaluate(()=>observed.commands.filter(x=>x==='desktop_open').length)).toBe(1);
  await expect.poll(()=>page.evaluate(()=>viewer.presented)).toBeGreaterThan(2);
  expect(errors).toEqual([]);
  await page.evaluate(()=>viewer.close());
});


test('taking canvas focus does not scroll between mouse down and up', async ({page}) => {
  await page.setViewportSize({width:1100,height:650});
  await page.route('https://desktop.test/**', route=>route.fulfill({contentType:route.request().url().endsWith('fixture.js')?'application/javascript':'text/html',
    body:route.request().url().endsWith('fixture.js')?readFileSync('dist/browser-fixture.js'):'<div style="height:350px">Support tools</div><div id="viewer"></div><script src="/fixture.js"></script>'}));
  await page.goto('https://desktop.test/?control');
  await page.getByRole('button',{name:'Start desktop'}).click();
  await expect(page.getByText('Live \u00b7 you have mouse and keyboard control',{exact:true})).toBeVisible({timeout:15000});
  await page.evaluate(()=>window.scrollTo(0,0));
  const box=await page.locator('canvas').boundingBox();
  await page.mouse.move(box.x+100,box.y+35);
  const before=await page.evaluate(()=>window.scrollY);
  await page.mouse.down();
  expect(await page.evaluate(()=>window.scrollY)).toBe(before);
  await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>observed.mouse.filter(m=>m.mask===9||m.mask===10).length)).toBe(2);
  const events=await page.evaluate(()=>observed.mouse.filter(m=>m.mask===9||m.mask===10));
  expect(events[0].x).toBe(events[1].x);expect(events[0].y).toBe(events[1].y);
});


test('ended desktop clears the frozen picture, exits fullscreen and remains dismissible', async ({page})=>{
  await page.route('https://desktop.test/**',route=>route.fulfill({contentType:route.request().url().endsWith('fixture.js')?'application/javascript':'text/html',body:route.request().url().endsWith('fixture.js')?readFileSync('dist/browser-fixture.js'):'<div id="viewer"></div><script src="/fixture.js"></script>'}));
  await page.goto('https://desktop.test/?control');
  await page.getByRole('button',{name:'Start desktop'}).click();
  await expect.poll(()=>page.evaluate(()=>viewer.lastFrame)).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Full screen',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
  await page.evaluate(()=>{window.disconnects=0;viewer.onDisconnect=()=>window.disconnects++;viewer.fail('The remote user ended this session.');viewer.fail('Duplicate disconnect');});
  expect(await page.evaluate(()=>window.disconnects)).toBe(1);
  await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
  await expect(page.locator('#viewer canvas')).toHaveCount(0);
  await expect(page.getByText('The remote user ended this session.')).toBeVisible();
  await page.getByRole('button',{name:'Close remote view',exact:true}).click();
  await expect(page.locator('#viewer')).toBeHidden();
});
