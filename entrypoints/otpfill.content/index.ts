import { defineContentScript } from 'wxt/utils/define-content-script';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
// 设计 token 必须在这里引入：cssInjectionMode: 'ui' 会把样式打进 Shadow DOM，
// 而 Shadow DOM 取不到宿主页 :root 上的自定义属性，theme.css 里的 :host 分支
// 正是为此准备的。
import '@/styles/theme.css';
import './probe.css';
import { renderProbe } from './Probe';

/**
 * 常驻内容脚本：OTP 输入框聚焦浮层 + 验证码填充。
 *
 * 它会注入到所有页面，因此有两条硬约束：
 *
 * 1. 未命中时开销接近于零。不做 MutationObserver 扫描，不预先创建 DOM，
 *    只挂一个 focusin 委托监听（focusin 会冒泡而 focus 不会，所以单个
 *    监听就能覆盖 SPA 后续渲染出来的输入框）。
 * 2. 体积必须小。这里一律用原生 DOM 而非 React —— 详见 lib/dom.ts 的说明。
 *
 * 当前为 M1 阶段：只在 URL 带 #xz-probe 时挂样式探针。
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  cssInjectionMode: 'ui',

  async main(ctx) {
    if (!location.hash.includes('xz-probe')) return;

    const ui = await createShadowRootUi(ctx, {
      name: 'xauthzee-panel',
      position: 'overlay',
      // 必须挂在 <html> 而不是 <body>。
      //
      // 实测（tests/positioning-strategy.mjs）：宿主页 body 上只要有
      // transform / filter / will-change / contain 之一，它就会成为
      // position: fixed 的包含块，挂在 body 下的浮层会跟着页面滚走
      // —— 滚动 400px 后浮层从 top 24 掉到 -376。这类属性在真实站点上
      // 极常见（GPU 合成层、毛玻璃、滚动优化），不能赌。
      // 挂到 documentElement 就绕开了 body 的包含块。
      anchor: 'html',
      append: 'last',
      isolateEvents: true,
      onMount(container) {
        container.append(renderProbe());
      },
    });

    ui.mount();
  },
});
