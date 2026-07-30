import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { detectOtpField } from '@/lib/detect';
import { fillInto } from '@/lib/autofill';
import { anyMatch } from '@/lib/domain';
import { generateCode } from '@/lib/totp';
import { mountPanel, type OverlayHandle, type OverlayListItem } from './Overlay';
import type { Account } from '@/lib/model';
// Vite ?inline 把 panel.css 作为字符串打进 bundle，注入到 Shadow DOM。
import panelCss from './panel.css?inline';

/**
 * 常驻内容脚本（M7）：OTP 输入框聚焦浮层 + 填充。
 *
 * 两条硬约束：
 *
 * 1. **未命中时开销接近于零**。不在页面加载时扫所有 input，不创建任何
 *    DOM。挂一个 focusin 委托监听即可（focusin 会冒泡而 focus 不会），
 *    单个监听覆盖 SPA 后续渲染出来的输入框。
 *
 * 2. **体积必须小**。这里用原生 DOM 而不是 React。带 React 的内容脚本
 *    bundle 是 200+ kB，原始 DOM 加 helper 才 14 kB。React 仅用在 popup
 *    与设置页。
 *
 * 流程：
 *   focusin → detectOtpField
 *     不命中：什么都不做（最常见情况）
 *     命中 → 拉账号列表 → 按当前 host 排序 → mount 浮层到 input 下方
 *   点列表项 → fillInto(target, code)
 *     成功：浮层消失 + 复制成功信号
 *     失败：保留浮层 + 复制到剪贴板作为兜底
 *   focusout / Esc → 销毁浮层
 */

const MESSAGE = {
  REFRESH: 'otpfill:refresh',
  FILL: 'otpfill:fill',
} as const;

interface RefreshResponse {
  ok: true;
}

interface FillResponse {
  ok: boolean;
  error?: string;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: false, // iframe 内的 OTP 通常是嵌套卡片，主 frame 处理就够
  runAt: 'document_idle',
  cssInjectionMode: 'ui',

  async main() {
    let currentPanel: OverlayHandle | null = null;
    let currentTarget: HTMLInputElement | null = null;
    let cachedAccounts: Account[] | null = null;

    // 每次 focusin 都拉一次账号列表是浪费 —— 缓存到 storage 变更。
    // 但 popup 写入 → storage.sync.onChanged → 我们重新拉。一次浮层显示
    // 期间不会感知到变化，所以挂一个 listener 在 onChanged 时清缓存。
    async function loadAccounts(): Promise<Account[]> {
      if (cachedAccounts) return cachedAccounts;
      const raw = await browser.storage.sync.get(null);
      const byId = new Map<string, Account>();
      const order: string[] = [];
      for (const [k, v] of Object.entries(raw)) {
        if (k === 'index' && Array.isArray(v)) {
          order.push(...(v as string[]));
        } else if (k.startsWith('acct:') && v) {
          byId.set(k.slice(5), v as Account);
        }
      }
      const result: Account[] = [];
      for (const id of order) {
        const a = byId.get(id);
        if (a) result.push(a);
      }
      for (const [id, a] of byId) if (!order.includes(id)) result.push(a);
      cachedAccounts = result;
      return result;
    }

    browser.storage.onChanged.addListener((_changes, area) => {
      if (area === 'sync') cachedAccounts = null;
    });

    async function getPrefs() {
      const raw = await browser.storage.sync.get('prefs');
      const prefs = (raw.prefs as Partial<{
        panelEnabled: boolean;
        broadDetection: boolean;
        disabledHosts: string[];
      }> | undefined) ?? {};
      return {
        panelEnabled: prefs.panelEnabled ?? true,
        broadDetection: prefs.broadDetection ?? true,
        disabledHosts: prefs.disabledHosts ?? [],
      };
    }

    async function showPanel(target: HTMLInputElement) {
      // 同一时刻只允许一个浮层 —— 切换 focusin 目标时拆掉旧的
      currentPanel?.destroy();
      currentTarget = target;

      const [prefs, accounts] = await Promise.all([getPrefs(), loadAccounts()]);
      if (!prefs.panelEnabled) return;

      const host = window.location.host;
      const items = filterAccounts(accounts, host);
      // 浮层条目按「命中 + issuer 字典序」排，命中模式 'subdomain' / 'shared' 给个徽标
      const list: OverlayListItem[] = items.map((a) => {
        const m = anyMatch(host, a.domains);
        return {
          account: a,
          matchMode: m.hit ? m.mode : 'exact',
        };
      });

      const panel = mountPanel(list, {
        onPick: async (account) => {
          await fillAndClose(account, target, panel);
        },
      });
      currentPanel = panel;

      // 把样式 + 内容挂到 Shadow DOM 上
      const hostEl = document.createElement('div');
      hostEl.dataset.xzPanelHost = '';
      const shadow = hostEl.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = panelCss;
      shadow.append(style);
      shadow.append(panel.root);
      document.documentElement.append(hostEl);
      panel.position(target.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      });

      // 焦点切走时自动关
      const onFocusOut = (e: FocusEvent) => {
        // 关掉当焦点彻底离开 input 且没落在浮层内
        const next = e.relatedTarget as Node | null;
        if (next && shadow.contains(next)) return;
        if (next === target) return;
        panel.destroy();
        target.removeEventListener('focusout', onFocusOut);
        if (currentPanel === panel) currentPanel = null;
      };
      target.addEventListener('focusout', onFocusOut);
    }

    async function fillAndClose(account: Account, target: HTMLInputElement, panel: OverlayHandle) {
      const code = generateCode(account, Date.now()).code;
      const result = fillInto(target, code);
      if (!result.ok) {
        // 兜底：复制到剪贴板。剪贴板权限在 content script 上下文里通常
        // 是被宿主页 CSP 拦的，所以这条兜底也很可能在真实环境失败；
        // 真正的兜底是 popup 里点复制按钮。
        try {
          await navigator.clipboard.writeText(code);
        } catch {
          /* 静默 */
        }
      }
      panel.destroy();
      if (currentPanel === panel) currentPanel = null;
      target.focus();
    }

    // ---- focusin 委托
    document.addEventListener(
      'focusin',
      (e) => {
        const target = e.target as Element | null;
        if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) {
          return;
        }
        const kind = detectOtpField(target, {
          host: window.location.host,
          broadDetection: true,
          disabledHosts: [],
        });
        if (kind === 'none') return;
        void showPanel(target as HTMLInputElement);
      },
      true,
    );

    // ---- popup 主动填充（点 popup 行的复制按钮时）
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const req = message as { type?: string; accountId?: string } | undefined;
      if (req?.type === MESSAGE.FILL && typeof req.accountId === 'string') {
        const accountId = req.accountId;
        void (async () => {
          if (!currentTarget) {
            sendResponse({ ok: false, error: 'no focused input' });
            return;
          }
          const accounts = await loadAccounts();
          const acc = accounts.find((a) => a.id === accountId);
          if (!acc) {
            sendResponse({ ok: false, error: 'account not found' });
            return;
          }
          const code = generateCode(acc, Date.now()).code;
          const result = fillInto(currentTarget, code);
          sendResponse({ ok: result.ok } as FillResponse);
        })();
        return true;
      }
      if (req?.type === MESSAGE.REFRESH) {
        cachedAccounts = null;
        sendResponse({ ok: true } as RefreshResponse);
        return false;
      }
      return false;
    });
  },
});

function filterAccounts(accounts: Account[], host: string): Account[] {
  // 命中当前 host 的排前面，其余按原顺序；隐藏 secret 为空的（加密且未解锁）
  const hit: Account[] = [];
  const rest: Account[] = [];
  for (const a of accounts) {
    if (!a.secret) continue;
    if (anyMatch(host, a.domains).hit) hit.push(a);
    else rest.push(a);
  }
  return [...hit, ...rest];
}