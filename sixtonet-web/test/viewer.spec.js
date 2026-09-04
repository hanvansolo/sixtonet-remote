import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

test('real browser decrypts VP9 inter-frames, gates input and releases held keys', async ({page})=>{
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://desktop.test/**',route=>{
    const script=route.request().url().endsWith('fixture.js');
    return route.fulfill({status:200,contentType:script?'application/javascript':'text/html',
      headers:{'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'"},
      body:script?readFileSync('dist/browser-fixture.js'):
        '<!doctype html><html><head><meta charset="utf-8"><title>SixtoNet desktop test</title><style>body{background:#202128;color:white;font:16px sans-serif;margin:24px}.card-head{display:flex;gap:8px;align-items:center}canvas{width:100%;height:auto}button,select{padding:8px;background:#343544;color:white;border:1px solid #555;border-radius:5px}.sub{color:#aaa}a{color:#aaa}</style></head><body><h1>Remote Desktop — protocol test</h1><div id="viewer"></div><script src="/fixture.js"></script></body></html>'});
  });
  await page.goto('https://desktop.test/');
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
  await page.screenshot({path:'test-results/viewer.png',fullPage:true});
  await page.evaluate(()=>viewer.close());
  expect(await page.evaluate(()=>observed.closed)).toBe(true);
});
