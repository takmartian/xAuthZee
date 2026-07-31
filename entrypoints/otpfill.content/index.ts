import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { detectOtpField } from '@/lib/detect';
import { fillInto } from '@/lib/autofill';
import { anyMatch } from '@/lib/domain';
import { generateCode } from '@/lib/totp';
import { mountPanel, type OverlayHandle, type OverlayListItem } from './Overlay';
import type { Account } from '@/lib/model';
import { installContentLockRuntime, getDerivedKey } from '@/lib/lock-runtime';
import { getLockState } from '@/lib/lock';
import { revealAccounts, stripSecrets } from '@/lib/secrets';
import { createMessageVault } from '@/lib/storage';

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

    // 装 content 的 lock runtime —— sync / session 全部走消息代理
    // 问 background。浮层要按 lockState 决定能否展示密文。
    installContentLockRuntime();
    const messageVault = createMessageVault();

    // 每次 focusin 都拉一次账号列表是浪费 —— 缓存到 storage 变更。
    // 但 popup 写入 → storage.sync.onChanged → 我们重新拉。一次浮层显示
    // 期间不会感知到变化，所以挂一个 listener 在 onChanged 时清缓存。
    async function loadAccounts(): Promise<Account[]> {
      if (cachedAccounts) return cachedAccounts;
      const accounts = await messageVault.list();

      // 按 lockState 处理 secret：plaintext 直返，unlocked 解密，
      // locked 把 secret 清空（filterAccounts 已有的 !a.secret continue
      // 会自然过滤掉所有账号 —— 浮层就空了）。
      const state = await getLockState();
      let result: Account[];
      if (state === 'unlocked') {
        const key = await getDerivedKey();
        result = key ? await revealAccounts(accounts, key) : stripSecrets(accounts);
      } else if (state === 'locked') {
        result = stripSecrets(accounts);
      } else {
        result = accounts;
      }
      cachedAccounts = result;
      return result;
    }

    // MV3 content script 不能直接监听 browser.storage.onChanged（会抛
    // "Access to storage is not allowed from this context"）。background 那
    // 边在 storage 变化时通过 tabs.sendMessage 广播 xz-storage-changed，
    // 这里用 runtime.onMessage 收并清缓存。
    browser.runtime.onMessage.addListener((message) => {
      const m = message as { type?: string; area?: string } | undefined;
      if (m?.type !== 'xz-storage-changed') return false;
      if (m.area !== 'sync' && m.area !== 'session') return false;
      cachedAccounts = null;
      return false;
    });

    async function getPrefs() {
      const raw = await messageVault.getPrefs();
      return {
        panelEnabled: raw.panelEnabled ?? true,
        broadDetection: raw.broadDetection ?? true,
        disabledHosts: raw.disabledHosts ?? [],
      };
    }

    async function showPanel(target: HTMLInputElement) {
      // 同一时刻只允许一个浮层 —— 切换 focusin 目标时拆掉旧的
      currentPanel?.destroy();
      currentTarget = target;

      const prefs = await getPrefs();
      if (!prefs.panelEnabled) return;

      // M8-k：locked 态下不展示账号列表，改成「点击解锁」入口
      const lockStateNow = await getLockState();
      if (lockStateNow === 'locked') {
        const panel = mountPanel(
          [],
          {
            onPick: () => {},
            onUnlock: () => {
              // 点「点击解锁」→ background 调 chrome.action.openPopup()。
              // Chrome 限制 openPopup 必须有 user gesture；content 端
              // sendMessage 不一定传染得到，失败就静默 —— 浮层文案已提示
              // 「打开工具栏弹窗」作兜底。
              void browser.runtime
                .sendMessage({ type: 'xz-open-popup' })
                .catch(() => {});
              panel.destroy();
              if (currentPanel === panel) currentPanel = null;
            },
          },
          'locked',
        );
        currentPanel = panel;
        panel.position(target.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        });
        const onFocusOut = (e: FocusEvent) => {
          const next = e.relatedTarget as Node | null;
          if (next && panel.root.contains(next)) return;
          if (next === target) return;
          panel.destroy();
          target.removeEventListener('focusout', onFocusOut);
          if (currentPanel === panel) currentPanel = null;
        };
        target.addEventListener('focusout', onFocusOut);
        return;
      }

      const accounts = await loadAccounts();
      const host = window.location.host;
      const items = filterAccounts(accounts, host);
      // 浮层条目按「命中 + issuer 字典序」排，命中模式 'subdomain' / 'shared' 给个徽标
      // 'exact' 命中（域名列表中精确匹配当前 host）给右侧小圆点。
      const list: OverlayListItem[] = items.map((a) => {
        const m = anyMatch(host, a.domains);
        return {
          account: a,
          matchMode: m.hit ? m.mode : 'exact',
          matched: m.hit,
        };
      });

      const panel = mountPanel(list, {
        onPick: async (account) => {
          await fillAndClose(account, target, panel);
        },
      });
      currentPanel = panel;

      // Overlay 自己已经挂到 documentElement 下了
      panel.position(target.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      });

      // 焦点切走时自动关
      const onFocusOut = (e: FocusEvent) => {
        // 关掉当焦点彻底离开 input 且没落在浮层内
        const next = e.relatedTarget as Node | null;
        if (next && panel.root.contains(next)) return;
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

    // ---- focusin + click 委托
    //
    // focusin 处理「刚聚焦到 OTP 输入框」的情况。
    // 但有一种情况 focusin 不会再次触发：用户点错选项后浮层关掉，但
    // mousedown.preventDefault 让 input 保持聚焦 —— 这时浏览器不再发
    // focusin。需要 click 兜底：在没有浮层且点击命中 OTP 输入框时主动
    // 重新挂一个。
    const handler = (target: HTMLInputElement | HTMLTextAreaElement) => {
      const kind = detectOtpField(target, {
        host: window.location.host,
        broadDetection: true,
        disabledHosts: [],
      });
      if (kind === 'none') return;
      // 已经有浮层且挂在同一个 target 上 —— 不重复挂
      if (currentPanel && currentTarget === target) return;
      // showPanel 只处理 HTMLInputElement —— textarea 我们也按单输入框路径走
      if (target instanceof HTMLInputElement) {
        void showPanel(target);
      }
    };
    document.addEventListener(
      'focusin',
      (e) => {
        const t = e.target;
        if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
          handler(t);
        }
      },
      true,
    );
    // click 兜底：focusin 没发但用户点了 input（通常是浮层关掉后想再选）
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement) && !(t instanceof HTMLTextAreaElement)) return;
        // 仅在「浮层不在」时挂 —— 否则 click 进浮层会被误判
        if (currentPanel) return;
        handler(t);
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