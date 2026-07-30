/**
 * 聚焦浮层的 DOM 构造（原生 DOM，无 React）。
 *
 * 设计要点：
 *
 * 1. 浮层挂到 documentElement（html）下，绕过 body 上的 transform / filter
 *    / will-change 等属性导致的 fixed 包含块陷阱（见 tests/positioning-strategy.mjs）。
 *
 * 2. mousedown + preventDefault —— 阻止点击浮层条目时输入框失去焦点，
 *    站点自己的 onBlur 校验逻辑就不会误触发。
 *
 * 3. 滚动 / 窗口尺寸变化时 updatePosition 重读 rect —— scroll 事件不冒泡，
 *    用 capture: true 在 document 上捕获。
 *
 * 4. 浮层整体放进 Shadow DOM，样式与宿主页完全隔离。attachShadow 的事件
 *    默认会重定向到 shadow root，所以 isolateEvents: true 让 shadow 内的
 *    click 不会触发宿主页面的 click handler（反之亦然）。
 *
 * 5. Esc 关掉浮层并让 focus 回到输入框。
 *
 * 6. 点浮层外的任意位置关掉（mousedown 在 document 上 capture）。input
 *    失焦先走 focusout 关浮层，document 上的 mousedown 是二次保险。
 */

import { h } from '@/lib/dom';
import type { Account } from '@/lib/model';
import panelCss from './panel.css?inline';

export interface OverlayHandle {
  readonly root: HTMLElement;
  /** 更新位置到 targetRect 对应位置 */
  position(targetRect: DOMRect, viewport: { width: number; height: number }): void;
  /** 销毁并清掉事件监听 */
  destroy(): void;
}

export interface OverlayCallbacks {
  /** 点列表项时调用 —— 传入 account 和「原始 target 输入框」 */
  onPick: (account: Account) => void;
}

export interface OverlayListItem {
  account: Account;
  /** 命中模式，用于在条目上显示一个徽标 */
  matchMode: 'exact' | 'subdomain' | 'shared' | 'none';
}

/**
 * 创建浮层 host（挂在 documentElement 下，Shadow DOM 内）。
 *
 * 调用方持有 handle，结束时调 destroy。
 */
export function mountPanel(items: OverlayListItem[], cb: OverlayCallbacks): OverlayHandle {
  // ---- Shadow DOM 容器
  const hostEl = document.createElement('div');
  hostEl.dataset.xzPanelHost = '';
  const shadow = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = panelCss;
  shadow.append(style);

  // ---- 浮层根
  const root = h('div', { class: 'xz-panel', attrs: { role: 'listbox' } });
  if (items.length === 0) {
    root.append(emptyHint());
  } else {
    for (const item of items) {
      root.append(row(item, cb));
    }
  }
  shadow.append(root);
  document.documentElement.append(hostEl);

  let destroyed = false;

  // ---- Esc 关掉
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();
  };
  // capture: true 让我们的 handler 先于宿主页的 Esc 处理跑（如果有的话）
  window.addEventListener('keydown', onKey, true);

  // ---- 点浮层外面关掉（mousedown 而不是 click —— click 在 Shadow DOM
  // 内的条目上不冒泡到 document）
  const onDocPointerDown = (e: MouseEvent) => {
    const t = e.target as Node | null;
    if (!t) return;
    if (root.contains(t)) return;
    // Shadow DOM 内的 t 可能让 root.contains 不可靠，host 也判一下
    if (hostEl.contains(t)) return;
    cleanup();
  };
  document.addEventListener('mousedown', onDocPointerDown, true);

  const onResize = () => {
    /* caller 自己监听 resize 重新 position */
  };
  window.addEventListener('resize', onResize);

  function cleanup() {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDocPointerDown, true);
    window.removeEventListener('resize', onResize);
    hostEl.remove();
  }

  // ---- position
  function position(targetRect: DOMRect, viewport: { width: number; height: number }) {
    const top = targetRect.bottom + 4;
    let left = targetRect.left;
    const PANEL_WIDTH = 240;
    if (left + PANEL_WIDTH > viewport.width - 8) {
      left = Math.max(8, viewport.width - PANEL_WIDTH - 8);
    }
    Object.assign(root.style, {
      position: 'fixed',
      top: `${top}px`,
      left: `${left}px`,
      width: `${PANEL_WIDTH}px`,
      maxHeight: `${Math.max(120, viewport.height - top - 8)}px`,
      zIndex: '2147483000',
    });
  }

  return {
    root,
    position,
    destroy: cleanup,
  };
}

// ------------------------------------------------------------ 单行

function row(item: OverlayListItem, cb: OverlayCallbacks): HTMLElement {
  const { account, matchMode } = item;
  const title = account.issuer || account.label;
  const sub = account.issuer && account.label ? account.label : '';

  const row = h('button', {
    class: 'xz-row',
    attrs: {
      type: 'button',
      role: 'option',
      'aria-label': title,
    },
  });
  // mousedown 而非 click：阻止输入框失焦
  row.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cb.onPick(account);
  });

  const text = h('div', { class: 'xz-row-text' });
  text.append(
    h('div', { class: 'xz-row-title', text: title }),
    sub ? h('div', { class: 'xz-row-sub', text: sub }) : document.createTextNode(''),
  );
  row.append(text);

  if (matchMode === 'subdomain' || matchMode === 'shared') {
    row.append(badge(matchMode));
  }

  return row;
}

function badge(mode: 'subdomain' | 'shared'): HTMLElement {
  const label = mode === 'subdomain' ? 'sub' : 'shared';
  return h('span', { class: `xz-badge xz-badge-${mode}`, text: label });
}

function emptyHint(): HTMLElement {
  return h('div', { class: 'xz-empty', text: '小验子 · 没有匹配的账号' });
}