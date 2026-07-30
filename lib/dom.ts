/**
 * 极简 DOM 构建helper，专供内容脚本使用。
 *
 * 为什么不用 React：这段代码会注入到用户访问的每一个页面。把 React +
 * ReactDOM 打进来会让内容脚本从几 kB 涨到 200 kB 以上，而且内容脚本无法
 * 与 popup 共享 chunk（MV3 的声明式内容脚本不支持 ES module，必须打成
 * 单个 IIFE），这 200 kB 是实打实每页解析一次。浮层本身只是一个列表，
 * 用不上组件树和调和算法。
 *
 * React 仍然用于 popup 和设置页 —— 那两处只在用户主动打开时才加载。
 */

type Child = Node | string | number | null | undefined | false;

interface Props {
  class?: string;
  text?: string;
  style?: Partial<CSSStyleDeclaration>;
  /** 直接写在元素上的属性，如 role、aria-*、tabindex */
  attrs?: Record<string, string | number>;
  /** 事件监听，键为事件名，如 { click: fn, mousedown: fn } */
  on?: Partial<{
    [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void;
  }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  if (props.class) el.className = props.class;
  if (props.text != null) el.textContent = props.text;
  if (props.style) Object.assign(el.style, props.style);

  if (props.attrs) {
    for (const [name, value] of Object.entries(props.attrs)) {
      el.setAttribute(name, String(value));
    }
  }

  if (props.on) {
    for (const [type, handler] of Object.entries(props.on)) {
      el.addEventListener(type, handler as EventListener);
    }
  }

  for (const child of children) {
    if (child == null || child === false) continue;
    el.append(typeof child === 'object' ? child : String(child));
  }

  return el;
}

/** 内联 SVG。内容脚本里不能用 <img src=extension://>，会被部分站点的 CSP 拦下 */
export function svg(viewBox: string, path: string, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const root = document.createElementNS(ns, 'svg');
  root.setAttribute('viewBox', viewBox);
  root.setAttribute('width', String(size));
  root.setAttribute('height', String(size));
  root.setAttribute('fill', 'none');
  root.setAttribute('aria-hidden', 'true');

  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.4');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  root.append(p);

  return root;
}
