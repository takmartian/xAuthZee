import { h } from '@/lib/dom';

/**
 * M1 样式探针。
 *
 * 存在的唯一目的：在样式敌对的页面上验证 Shadow DOM 隔离是否可靠。
 * 逐项覆盖会被宿主页面破坏的常见属性——字号、行高、盒模型、等宽字体、
 * 层级、颜色——任何一项在某个网站上失真，说明这套样式方案还不能拿去
 * 写真正的浮层。
 *
 * 这里的 DOM 结构与 tests/style-isolation.mjs 里的复刻版本一一对应，
 * 改动时两边要同步。
 */
export function renderProbe(): HTMLElement {
  const row = (issuer: string, code: string) =>
    h(
      'div',
      { class: 'xz-row' },
      h('span', { class: 'xz-issuer', text: issuer }),
      h('span', { class: 'xz-code', text: code }),
    );

  return h(
    'div',
    { class: 'xz-panel' },
    h('div', { class: 'xz-header', text: 'XAuthZee style probe' }),
    row('GitHub', '492 015'),
    row('一个很长的中文服务名称示例超出后应当省略', '038 774'),
    h(
      'div',
      { class: 'xz-checks' },
      h('p', { text: '字号应为 13px，与宿主页 html font-size 无关' }),
      h('p', { text: '下方色块应为 40×12px、四角圆润的实心方块' }),
      h('span', { class: 'xz-swatch' }),
    ),
  );
}
