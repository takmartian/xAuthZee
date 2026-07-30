import type { Rect, ViewportRect } from './types.ts';

/**
 * 把「用户在页面上拖出来的选区」（CSS 像素）映射到「截屏图里的实际像素矩形」。
 *
 *   实际 = 截屏宽 / window.innerWidth × CSS 像素
 *
 * 为什么不用 devicePixelRatio：浏览器页面缩放（125% / 150% / 200%）与
 * Retina 各自独立。截屏的宽度反映的是两者叠加后的真实物理像素数。
 * 用「实测截屏宽 / 窗口宽」反推，Retina、缩放、滚动条三者都覆盖。
 *
 * 唯一的脆弱点是：缩放发生在用户框选之后、截屏之前。这种情况罕见
 * （通常框选与截屏间隔 < 1s），即使发生误差也只是裁剪区域偏移几像素，
 * jsQR 对小幅偏移有较好的容忍度。
 */
export function computeCaptureScale(captureWidth: number, viewportWidth: number): number {
  if (viewportWidth <= 0) {
    throw new Error(`viewportWidth must be positive, got ${viewportWidth}`);
  }
  return captureWidth / viewportWidth;
}

/**
 * 把 CSS 像素下的选区换算成截屏图里的像素矩形。
 *
 * 输入边界：
 * - 选区超出窗口时仍返回原样（不裁剪），让调用方决定如何处理越界
 * - 比例 < 1（截屏宽 < innerWidth，比如全屏截图被缩放过）也按公式算
 * - 比例 < 1 时结果可能落在截屏外——交给调用方
 */
export function selectionToCaptureRect(
  selection: ViewportRect,
  viewport: { width: number; height: number },
  capture: { width: number; height: number },
): Rect {
  const scale = computeCaptureScale(capture.width, viewport.width);
  return {
    x: Math.round(selection.x * scale),
    y: Math.round(selection.y * scale),
    w: Math.round(selection.w * scale),
    h: Math.round(selection.h * scale),
  };
}

/**
 * 把矩形限制在图像范围内，避免越界读取造成 jsQR 解码失败。
 *
 * 算法是把「矩形占用的闭区间」和「图像占用的闭区间」求交集。
 * 关键点：不仅要限制起点，还要限制终点；起点越界（左/上）时，
 * 宽度也要相应缩水。
 */
export function clampRectToImage(rect: Rect, imageWidth: number, imageHeight: number): Rect {
  const x0 = Math.max(0, Math.min(rect.x, imageWidth));
  const y0 = Math.max(0, Math.min(rect.y, imageHeight));
  const x1 = Math.max(x0, Math.min(rect.x + rect.w, imageWidth));
  const y1 = Math.max(y0, Math.min(rect.y + rect.h, imageHeight));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}