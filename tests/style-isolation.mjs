/**
 * M1 验证：浮层样式在敌对页面中的隔离效果。
 *
 * 为什么不直接加载扩展跑：Chrome 137 起出于安全考虑停用了 --load-extension
 * 命令行开关，本机 Chrome 150 上实测 --headless=new、有头模式、
 * --disable-features=DisableLoadExtensionCommandLineSwitch、
 * --enable-unsafe-extension-debugging 各种组合都无法把未打包扩展装进去
 * （/json/list 里始终只有 Chrome 自带的组件扩展）。
 *
 * 因此这里改为在页面内「忠实复刻」WXT 的 shadow root 构造，并加载真实构建
 * 产物 .output/chrome-mv3/content-scripts/otpfill.css。复刻依据是
 * node_modules/wxt/dist/utils/content-script-ui/{shadow-root,shared}.mjs 与
 * @webext-core/isolated-element 的源码：
 *
 *   - <xauthzee-panel> 宿主元素，attachShadow({ mode: 'open' })
 *   - 样式表首行注入 :host{all:initial !important;}
 *   - 入口 CSS 里的 :root 被替换为 :host
 *   - position: 'overlay' 时宿主元素为 position:relative + 0×0，
 *     内层容器为 position:absolute; top:0; left:0
 *
 * 这样能覆盖 M1 真正关心的问题——我们的 CSS 在宿主页敌意样式下会不会失真、
 * fixed 定位在 transform 祖先下是否可靠。唯一没覆盖的是 Chrome 注入 CSS 文件
 * 这一步本身，而那不是风险所在。扩展整体仍需在 chrome://extensions 手动加载
 * 做一次人工确认。
 *
 * 用法：
 *   npm run build
 *   (cd tests/fixtures && python3 -m http.server 5599 --bind 127.0.0.1 &)
 *   node tests/style-isolation.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const ORIGIN = 'http://127.0.0.1:5599';
const CSS_FILE = join(ROOT, '.output', 'chrome-mv3', 'content-scripts', 'otpfill.css');

const PAGES = ['hostile-reset', 'hostile-rem', 'hostile-layers'];

/** 期望值取自 entrypoints/otpfill.content/probe.css，对不上即说明隔离被击穿 */
const EXPECTED = {
  panelFontSize: '13px',
  panelPosition: 'fixed',
  panelBoxSizing: 'border-box',
  panelTextAlign: 'left',
  panelLetterSpacing: 'normal',
  issuerFontSize: '13px',
  codeFontSize: '15px',
  swatchWidth: 40,
  swatchHeight: 12,
};

// ---------------------------------------------------------------- CDP 客户端

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const resolver = this.#pending.get(msg.id);
      if (!resolver) return;
      this.#pending.delete(msg.id);
      msg.error ? resolver.reject(new Error(msg.error.message)) : resolver.resolve(msg.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`无法连接 ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? '页面内求值失败');
    }
    return result.value;
  }

  close() {
    this.#ws.close();
  }
}

// -------------------------------------------------------- 页面内的挂载 + 测量

/** 生成在页面里执行的脚本。cssText 为真实构建产物内容。 */
function buildProbeScript(cssText) {
  return `(async () => {
    // ---- 复刻 WXT createShadowRootUi({ position: 'overlay' }) ----
    const host = document.createElement('xauthzee-panel');
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent =
      '/* WXT Shadow Root Reset */ :host{all:initial !important;}\\n' +
      ${JSON.stringify(cssText)}.replaceAll(':root', ':host');
    shadow.appendChild(style);

    const container = document.createElement('div');
    shadow.appendChild(container);

    Object.assign(host.style, {
      overflow: 'visible', position: 'relative',
      width: '0', height: '0', display: 'block',
    });
    Object.assign(container.style, { position: 'absolute', top: '0', left: '0' });

    // ---- 探针 DOM，结构与 entrypoints/otpfill.content/Probe.ts 保持一致 ----
    container.innerHTML = \`
      <div class="xz-panel">
        <div class="xz-header">XAuthZee style probe</div>
        <div class="xz-row"><span class="xz-issuer">GitHub</span><span class="xz-code">492 015</span></div>
        <div class="xz-row"><span class="xz-issuer">一个很长的中文服务名称示例超出后应当省略</span><span class="xz-code">038 774</span></div>
        <div class="xz-checks">
          <p>字号应为 13px，与宿主页 html font-size 无关</p>
          <p>下方色块应为 40×12px、四角圆润的实心方块</p>
          <span class="xz-swatch"></span>
        </div>
      </div>\`;

    // 挂到 documentElement 而非 body：body 上的 transform 会成为 fixed 的
    // 包含块，浮层会跟着页面滚走。与 otpfill.content 里 anchor: 'html' 一致。
    document.documentElement.appendChild(host);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const q = (sel) => shadow.querySelector(sel);
    const panel = q('.xz-panel');
    const issuer = q('.xz-issuer');
    const code = q('.xz-code');
    const swatch = q('.xz-swatch');
    if (!panel || !issuer || !code || !swatch) return { error: '探针元素缺失' };

    const cs = (el) => getComputedStyle(el);
    const measure = () => {
      const r = panel.getBoundingClientRect();
      return { top: Math.round(r.top), right: Math.round(innerWidth - r.right) };
    };

    const before = measure();
    scrollTo(0, 400);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const after = measure();
    const scrolled = scrollY;
    scrollTo(0, 0);

    return {
      panelFontSize: cs(panel).fontSize,
      panelPosition: cs(panel).position,
      panelBoxSizing: cs(panel).boxSizing,
      panelTextAlign: cs(panel).textAlign,
      panelLetterSpacing: cs(panel).letterSpacing,
      panelFontFamily: cs(panel).fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      panelLineHeight: cs(panel).lineHeight,
      issuerFontSize: cs(issuer).fontSize,
      codeFontSize: cs(code).fontSize,
      swatchWidth: Math.round(swatch.getBoundingClientRect().width),
      swatchHeight: Math.round(swatch.getBoundingClientRect().height),
      rectBeforeScroll: before,
      rectAfterScroll: after,
      scrolled,
    };
  })()`;
}

// ------------------------------------------------------------------- 主流程

const cssText = readFileSync(CSS_FILE, 'utf8');

const profile = mkdtempSync(join(tmpdir(), 'xz-cdp-'));
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

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(100);
  }
  throw new Error('Chrome DevTools 端口始终未就绪');
}

async function openTab(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`无法打开标签页：${res.status}`);
  return res.json();
}

// 先确认静态服务在跑，否则报错会很难懂
try {
  const probe = await fetch(`${ORIGIN}/hostile-reset.html`);
  if (!probe.ok) throw new Error(String(probe.status));
} catch (err) {
  console.error(`✖ 无法访问 ${ORIGIN}：${err.message}`);
  console.error('  请先在 tests/fixtures 下运行：python3 -m http.server 5599 --bind 127.0.0.1');
  process.exit(2);
}

await waitForDevtools();

const script = buildProbeScript(cssText);
let failures = 0;
const rows = [];

for (const page of PAGES) {
  const target = await openTab(`${ORIGIN}/${page}.html`);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

  let result;
  try {
    await cdp.send('Runtime.enable');
    result = await cdp.evaluate(script);
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  }

  if (result?.error) {
    console.error(`✖ ${page}：${result.error}`);
    failures++;
    continue;
  }

  const problems = [];
  for (const [key, want] of Object.entries(EXPECTED)) {
    if (result[key] !== want) problems.push(`${key} 期望 ${want}，实际 ${result[key]}`);
  }

  // fixed 是否真的相对视口：滚动后浮层在视口内的位置不应变化。
  // hostile-layers 页的 body 带 transform，会把 fixed 的包含块改成 body，
  // 这条断言就是专门为那种页面准备的。
  const { rectBeforeScroll: a, rectAfterScroll: b, scrolled } = result;
  const stuck = a.top === b.top && a.right === b.right;
  if (scrolled > 0 && !stuck) {
    problems.push(`滚动 ${scrolled}px 后浮层跟着移动：top ${a.top}→${b.top}, right ${a.right}→${b.right}`);
  }

  rows.push({
    页面: page,
    字号: result.panelFontSize,
    行高: result.panelLineHeight,
    字间距: result.panelLetterSpacing,
    验证码字号: result.codeFontSize,
    色块: `${result.swatchWidth}×${result.swatchHeight}`,
    字体: result.panelFontFamily,
    滚动后固定: scrolled > 0 ? (stuck ? '是' : '否') : '页面未滚动',
  });

  if (problems.length) {
    failures++;
    console.error(`✖ ${page}`);
    for (const p of problems) console.error(`    ${p}`);
  } else {
    console.log(`✔ ${page}`);
  }
}

console.log();
console.table(rows);

process.exit(failures ? 1 : 0);
