import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

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
  await expect(page.getByRole('link',{name:'Open-source licences',exact:true})).toHaveAttribute('href',
    'https://github.com/hanvansolo/sixtonet-remote/tree/sixtonet');
  await expect(page.getByText('RustDesk engine · source',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Start desktop'}).click();
  await expect(page.getByText('Live · view only',{exact:true})).toBeVisible({timeout:15000});
  const c=page.locator('canvas');
  await c.click({position:{x:500,y:250}});
  expect(await page.evaluate(()=>observed.mouse.length)).toBe(0);
  await page.getByRole('button',{name:'Take control',exact:true}).click();
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
  await expect(popup.locator('canvas')).toBeVisible();
  await expect(popup.locator('body')).toHaveCSS('background-color','rgb(32, 33, 40)');
  await popup.locator('canvas').focus();
  await popup.keyboard.press('Z');
  expect(await page.evaluate(()=>observed.keys.some(k=>k.unicode===90))).toBe(true);
  expect(await page.evaluate(()=>observed.commands.filter(c=>c==='desktop_open').length)).toBe(1);
  await page.getByRole('button',{name:'Return desktop to this tab'}).click();
  await expect(c).toBeVisible();
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
