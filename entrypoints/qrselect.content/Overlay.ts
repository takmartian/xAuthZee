/**
 * 框选遮罩的 DOM 构造与事件处理（原生 DOM，无 React）。
 *
 * 设计要点：
 *
 * 1. 全屏浮层 + 半透明遮罩。遮罩用 box-shadow 在选区矩形四周铺开，
 *    实现"挖空"效果，无需 SVG / clip-path。
 *
 * 2. 拖拽用 pointer events，同时支持鼠标和触屏。mousedown 才开始拖，
 *    避免和页面自身的 click 冲突。
 *
 * 3. 释放鼠标即视为"完成框选"，调用方决定下一步（截屏 / 解码）。
 *
 * 4. Esc 键取消整个流程 —— 比单独一个"取消"按钮更顺手。
 */

import { h, svg } from '@/lib/dom';

export interface SelectionResult {
  rect: { x: number; y: number; w: number; h: number };
  viewport: { width: number; height: number };
}

export interface OverlayHandle {
  /** 整个浮层的根元素，调用方挂到 Shadow DOM 容器里 */
  readonly root: HTMLElement;
  /** 切换到"解码中"状态：把 hint 换成转圈 + 文案 */
  setBusy(message: string): void;
  /** 切换到"成功"状态：显示确认卡片，resolve 即用户点了"添加" */
  showConfirm(card: ConfirmCard): Promise<ConfirmResult>;
  /** 切换到"失败"状态：显示错误卡片，resolve 即用户选了重试/取消 */
  showError(card: ErrorCard): Promise<'retry' | 'cancel'>;
  /** 整个卸载（成功或失败后调用） */
  destroy(): void;
}

export interface ConfirmCard {
  /** 主标题，比如"扫描成功" */
  title: string;
  /** 字段列表（label + value） */
  fields: Array<{ label: string; value: string; mono?: boolean }>;
  /** 确认按钮文案，默认 "添加" */
  confirmLabel?: string;
  /** 取消按钮文案，默认 "取消" */
  cancelLabel?: string;
}

export interface ErrorCard {
  title: string;
  message: string;
  retryLabel?: string;
  cancelLabel?: string;
}

export type ConfirmResult = 'confirm' | 'cancel';

/** 给调用方用的 mount 函数。返回的 root 需要 append 到 Shadow 容器 */
export function mountOverlay(): OverlayHandle {
  const root = h('div', { class: 'xz-overlay' });
  const mask = h('div', { class: 'xz-mask' });
  const hint = h('div', { class: 'xz-hint' });
  hint.innerHTML = '框选二维码 &nbsp;·&nbsp; <kbd>Esc</kbd> 取消';
  const selection = h('div', { class: 'xz-selection' });
  const selectionBorder = h('div', { class: 'xz-selection-border' });
  const handleTL = h('div', { class: 'xz-handle xz-tl' });
  const handleTR = h('div', { class: 'xz-handle xz-tr' });
  const handleBL = h('div', { class: 'xz-handle xz-bl' });
  const handleBR = h('div', { class: 'xz-handle xz-br' });
  const sizeLabel = h('div', { class: 'xz-size-label' });
  selectionBorder.append(handleTL, handleTR, handleBL, handleBR);
  selection.append(selectionBorder, sizeLabel);
  root.append(mask, hint, selection);

  let destroyed = false;
  let resolveConfirm: ((r: ConfirmResult) => void) | null = null;
  let resolveError: ((r: 'retry' | 'cancel') => void) | null = null;

  function clearCard() {
    const existing = root.querySelector('.xz-card');
    if (existing) existing.remove();
  }

  // --------------------------------------------------------- 拖拽

  let dragging = false;
  let startPt = { x: 0, y: 0 };
  let currentRect: SelectionResult | null = null;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // 已经在显示确认/错误卡片时，拖拽不应该覆盖
    if (resolveConfirm || resolveError) return;
    e.preventDefault();
    dragging = true;
    startPt = { x: e.clientX, y: e.clientY };
    selection.classList.add('xz-active');
    mask.classList.add('xz-cutout');
    updateSelectionRect(startPt, startPt);
    root.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    updateSelectionRect(startPt, { x: e.clientX, y: e.clientY });
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    root.releasePointerCapture(e.pointerId);

    const end = { x: e.clientX, y: e.clientY };
    const { x, y, w, h } = normalizeRect(startPt, end);
    currentRect = {
      rect: { x, y, w, h },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };

    // 触发外部逻辑：把"用户选了"这个事件冒泡出去
    document.dispatchEvent(
      new CustomEvent('xz-selection-done', { detail: currentRect }),
    );
  };

  function normalizeRect(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
  }

  function updateSelectionRect(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) {
    const { x, y, w, h } = normalizeRect(a, b);
    Object.assign(selection.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
    sizeLabel.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);

  // 让 root 能接收 pointer 事件。mask 自身是 pointer-events: none，
  // 鼠标穿透到底下的 root。
  mask.style.pointerEvents = 'none';
  hint.style.pointerEvents = 'none';
  selection.style.pointerEvents = 'none';

  // --------------------------------------------------------- Esc 取消

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (resolveConfirm) {
      e.preventDefault();
      resolveConfirm('cancel');
      cleanup();
    } else if (resolveError) {
      e.preventDefault();
      resolveError('cancel');
      cleanup();
    } else {
      // 框选过程中按 Esc —— 也走 cancel，把整个流程关掉
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('xz-selection-cancel'));
    }
  };
  window.addEventListener('keydown', onKey);

  // --------------------------------------------------------- 状态切换

  function setBusy(message: string) {
    clearCard();
    hint.innerHTML = '';
    hint.append(svg('0 0 16 16', '', 14));
    // 用一个旋转点占位（h 不支持 spin 元素，直接构造）
    const spinner = h('span', { class: 'xz-spinner' });
    hint.append(spinner, document.createTextNode(` ${message}`));
    selection.classList.remove('xz-active');
    mask.classList.remove('xz-cutout');
  }

  function showConfirm(card: ConfirmCard): Promise<ConfirmResult> {
    clearCard();
    hint.style.display = 'none';
    selection.classList.remove('xz-active');
    mask.classList.remove('xz-cutout');

    const cardEl = h('div', { class: 'xz-card' });
    const header = h('div', { class: 'xz-card-header' });
    header.append(
      h('div', { class: 'xz-card-icon' }, checkGlyph()),
      h('span', { text: card.title }),
    );
    cardEl.append(header);

    const body = h('div', { class: 'xz-card-body' });
    for (const field of card.fields) {
      const fieldEl = h('div', { class: 'xz-card-field' });
      fieldEl.append(h('div', { class: 'xz-card-field-label', text: field.label }));
      const valClass = field.mono ? 'xz-card-field-value xz-mono' : 'xz-card-field-value';
      fieldEl.append(h('div', { class: valClass, text: field.value }));
      body.append(fieldEl);
    }
    cardEl.append(body);

    const footer = h('div', { class: 'xz-card-footer' });
    const cancelBtn = h('button', {
      class: 'xz-card-button',
      text: card.cancelLabel ?? '取消',
      on: { click: () => resolveConfirm?.('cancel') },
    });
    const confirmBtn = h('button', {
      class: 'xz-card-button xz-primary',
      text: card.confirmLabel ?? '添加',
      on: { click: () => resolveConfirm?.('confirm') },
    });
    footer.append(cancelBtn, confirmBtn);
    cardEl.append(footer);

    root.append(cardEl);

    return new Promise((resolve) => {
      resolveConfirm = (r) => {
        resolveConfirm = null;
        resolve(r);
      };
    });
  }

  function showError(card: ErrorCard): Promise<'retry' | 'cancel'> {
    clearCard();
    hint.style.display = 'none';
    selection.classList.remove('xz-active');
    mask.classList.remove('xz-cutout');

    const cardEl = h('div', { class: 'xz-card' });
    const header = h('div', { class: 'xz-card-header xz-error' });
    header.append(
      h('div', { class: 'xz-card-icon' }, crossGlyph()),
      h('span', { text: card.title }),
    );
    cardEl.append(header);

    const body = h('div', { class: 'xz-card-body' });
    body.append(h('p', { text: card.message, style: { margin: '0' } }));
    cardEl.append(body);

    const footer = h('div', { class: 'xz-card-footer' });
    const cancelBtn = h('button', {
      class: 'xz-card-button',
      text: card.cancelLabel ?? '取消',
      on: { click: () => resolveError?.('cancel') },
    });
    const retryBtn = h('button', {
      class: 'xz-card-button xz-primary',
      text: card.retryLabel ?? '再试一次',
      on: { click: () => resolveError?.('retry') },
    });
    footer.append(cancelBtn, retryBtn);
    cardEl.append(footer);

    root.append(cardEl);

    return new Promise((resolve) => {
      resolveError = (r) => {
        resolveError = null;
        resolve(r);
      };
    });
  }

  function cleanup() {
    if (destroyed) return;
    destroyed = true;
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerup', onPointerUp);
    root.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('keydown', onKey);
    root.remove();
  }

  function destroy() {
    // 任何未 resolved 的 promise 都收尾
    if (resolveConfirm) resolveConfirm('cancel');
    if (resolveError) resolveError('cancel');
    cleanup();
  }

  return { root, setBusy, showConfirm, showError, destroy };
}

// ------------------------------------------------------------ 图标

function checkGlyph(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const root = document.createElementNS(ns, 'svg');
  root.setAttribute('viewBox', '0 0 16 16');
  root.setAttribute('width', '14');
  root.setAttribute('height', '14');
  root.setAttribute('fill', 'none');
  root.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M3.5 8.5l3 3 6-6');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  root.append(path);
  return root;
}

function crossGlyph(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const root = document.createElementNS(ns, 'svg');
  root.setAttribute('viewBox', '0 0 16 16');
  root.setAttribute('width', '14');
  root.setAttribute('height', '14');
  root.setAttribute('fill', 'none');
  root.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M4.5 4.5l7 7M11.5 4.5l-7 7');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  root.append(path);
  return root;
}