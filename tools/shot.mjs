// Скриншоты через headless Chrome (CDP), без зависимостей.
// node tools/shot.mjs <url> <outPrefix> <desktop|mobile> [--dismiss-cookies]
// Пишет <outPrefix>-top.jpg (первый экран) и <outPrefix>-full.jpg (вся страница).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, mode = 'desktop', ...flags] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/shot.mjs <url> <outPrefix> <desktop|mobile> [--dismiss-cookies]');
  process.exit(1);
}
const mobile = mode === 'mobile';
const vp = mobile ? { width: 390, height: 844, dsf: 2 } : { width: 1440, height: 900, dsf: 1 };
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'shot-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--no-first-run', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => { chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); };

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('Chrome не запустился');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) events.push(msg.method);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    pending.set(++id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dsf, mobile });
  if (mobile) {
    await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  await send('Page.navigate', { url });
  for (let i = 0; i < 100 && !events.includes('Page.loadEventFired'); i++) await sleep(200);
  await sleep(1200);
  if (flags.includes('--dismiss-cookies')) {
    await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(e=>/Отклонить необязательные/.test(e.innerText)); if(b) b.click(); })()`);
    await sleep(500);
  }
  // прокрутить страницу, чтобы подгрузились ленивые картинки и сработали появления
  await evaluate(`(async () => {
    document.documentElement.style.scrollBehavior='auto';
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += Math.round(innerHeight*0.7)) { scrollTo(0, y); await new Promise(r=>setTimeout(r,180)); }
    scrollTo(0, 0); await new Promise(r=>setTimeout(r,500));
    await Promise.all([...document.images].filter(i=>!i.complete).map(i=>new Promise(r=>{i.onload=i.onerror=r; setTimeout(r,4000);})));
  })()`);
  await sleep(600);

  const top = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  writeFileSync(`${out}-top.jpg`, Buffer.from(top.data, 'base64'));

  // в снимке всей страницы прилипающая нижняя панель оказалась бы посреди кадра — прячем её
  await evaluate(`document.querySelectorAll('body *').forEach(e=>{const s=getComputedStyle(e); if(s.position==='fixed'&&parseFloat(s.bottom)===0) e.style.visibility='hidden';})`);
  const { cssContentSize } = await send('Page.getLayoutMetrics');
  const height = Math.ceil(cssContentSize.height);
  const scale = Math.min(1, 14000 / (height * vp.dsf));
  const full = await send('Page.captureScreenshot', {
    format: 'jpeg', quality: 82, captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: vp.width, height, scale },
  });
  writeFileSync(`${out}-full.jpg`, Buffer.from(full.data, 'base64'));
  console.log(`${out}: ${vp.width}x${height}css, full scale ${scale.toFixed(2)}`);
  ws.close();
  done(0);
} catch (e) {
  console.error('ошибка:', e.message);
  done(1);
}
