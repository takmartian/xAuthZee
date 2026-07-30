/**
 * 定位策略对照实验。
 *
 * 背景：M1 实测发现，宿主页 body 带 transform 时，Shadow DOM 内部的
 * position: fixed 会退化为相对该 transform 元素定位，浮层会跟着页面滚走。
 * transform / filter / will-change / contain / backdrop-filter 都有这个效果，
 * 在真实站点上非常常见，所以必须先选定一个可靠的定位策略再写 M7 的浮层。
 *
 * 本脚本在同一个陷阱页面上依次挂载四种策略，滚动 400px 后测量浮层在视口内的
 * 位置是否保持不变，并额外检查它是否会被页面自身的高 z-index 元素遮挡。
 *
 *   node tests/positioning-strategy.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9336;
const URL_UNDER_TEST = 'http://127.0.0.1:5599/positioning-traps.html';

/**
 * 四种候选：
 *   body-fixed      当前实现。宿主挂 body，浮层 fixed。已知在 transform 页失效。
 *   html-fixed      宿主改挂 documentElement，绕开 body 上的 transform。
 *   html-absolute   宿主挂 html，浮层 absolute + 文档坐标，滚动时手动补偿。
 *   popover         宿主挂 body，浮层用 Popover API 进 top layer。
 *                   top layer 不受祖先 transform 影响，且天然盖在所有内容之上。
 */
const STRATEGIES = ['body-fixed', 'html-fixed', 'html-absolute', 'popover'];

const script = (strategy) => `(async () => {
  document.querySelectorAll('xz-test').forEach((e) => e.remove());
  scrollTo(0, 0);

  const host = document.createElement('xz-test');
  const shadow = host.attachShadow({ mode: 'open' });
  const panel = document.createElement('div');
  panel.textContent = '定位测试';
  Object.assign(panel.style, {
    width: '160px', height: '40px', background: '#4f46e5', color: '#fff',
    font: '13px system-ui', display: 'grid', placeItems: 'center',
    borderRadius: '8px', zIndex: '2147483000', margin: '0', padding: '0', border: '0',
  });
  shadow.appendChild(panel);
  Object.assign(host.style, { position: 'relative', width: '0', height: '0', display: 'block' });

  const strategy = ${JSON.stringify(strategy)};
  const parent = strategy.startsWith('html') ? document.documentElement : document.body;
  parent.appendChild(host);

  // 目标：浮层稳定停在视口 (24, 24)
  const place = () => {
    if (strategy === 'html-absolute') {
      Object.assign(panel.style, {
        position: 'absolute',
        top: (24 + scrollY) + 'px',
        left: (24 + scrollX) + 'px',
      });
    } else {
      Object.assign(panel.style, { position: 'fixed', top: '24px', left: '24px' });
    }
  };
  place();

  if (strategy === 'popover') {
    panel.setAttribute('popover', 'manual');
    try { panel.showPopover(); } catch (e) { return { error: 'showPopover 失败: ' + e.message }; }
  }

  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await settle();

  const at = () => {
    const r = panel.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left) };
  };

  const before = at();
  scrollTo(0, 400);
  await settle();
  if (strategy === 'html-absolute') { place(); await settle(); }
  const after = at();
  const scrolled = scrollY;

  // 顶层能力检测：视口 (24,24) 处最上层的元素是不是我们
  const topmost = document.elementFromPoint(30, 30);
  const onTop = topmost === host || topmost === panel || host.contains(topmost);

  host.remove();
  scrollTo(0, 0);

  return { before, after, scrolled, stable: before.top === after.top && before.left === after.left, onTop };
})()`;

// ------------------------------------------------------------------ 启动 Chrome

const profile = mkdtempSync(join(tmpdir(), 'xz-pos-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1000,700',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => {
  chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
});

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
  } catch {
    /* 等端口 */
  }
  await sleep(100);
}

const tab = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_UNDER_TEST)}`, {
    method: 'PUT',
  })
).json();

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};

await send('Runtime.enable');
await sleep(800);

const rows = [];
for (const strategy of STRATEGIES) {
  const res = await send('Runtime.evaluate', {
    expression: script(strategy),
    returnByValue: true,
    awaitPromise: true,
  });
  const v = res.result?.result?.value;
  if (!v || v.error) {
    rows.push({ 策略: strategy, 结果: v?.error ?? JSON.stringify(res).slice(0, 120) });
    continue;
  }
  rows.push({
    策略: strategy,
    滚动前: `${v.before.top},${v.before.left}`,
    滚动后: `${v.after.top},${v.after.left}`,
    滚动量: v.scrolled,
    位置稳定: v.stable ? '✔' : '✘',
    位于最顶层: v.onTop ? '✔' : '✘',
  });
}

console.table(rows);
process.exit(0);
