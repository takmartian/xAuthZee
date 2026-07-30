import type { ViewportRect } from './types.ts';

/**
 * 用户在页面上拖出的矩形往往是「从 A 点拖到 B 点」，A 可能
 * 在 B 的右下方。规范化为「左上角 + 宽高」。
 *
 * 还顺手处理几种常见的退化情况：
 * - 起点在终点左下/右下：交换
 * - 宽或高为负或零：返回 zeroRect，调用方应给出"选区太小"提示
 */
export function normalizeDragRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
): ViewportRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  return { x, y, w, h };
}

/** 二维码最小能识别的尺寸经验值 —— 边长低于 ~50px 时大概率解不出 */
export const MIN_QR_SIDE = 50;

/**
 * 把选区裁剪到视口范围内 + 最小尺寸检查。
 *
 * 返回 null 表示「这个选区没法解码」，UI 应给用户提示并允许重试。
 */
export function prepareSelection(
  rect: ViewportRect,
  viewport: { width: number; height: number },
): { rect: ViewportRect } | { error: SelectionError } {
  // 选区超出视口的部分裁掉。起点越界（左/上）时，宽度也要相应缩水，
  // 否则会拿到一个起点对齐到 0、但宽度还按原值的"超界"矩形。
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const w = Math.min(rect.w - Math.max(0, -rect.x), viewport.width - x);
  const h = Math.min(rect.h - Math.max(0, -rect.y), viewport.height - y);

  if (w <= 0 || h <= 0) return { error: 'selection_outside' };
  if (w < MIN_QR_SIDE || h < MIN_QR_SIDE) return { error: 'selection_too_small' };

  return { rect: { x, y, w, h } };
}

export type SelectionError = 'selection_outside' | 'selection_too_small';