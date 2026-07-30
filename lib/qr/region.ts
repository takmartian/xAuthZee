import type { Rect } from './types.ts';

/**
 * 从一整张图像的 RGBA 缓冲里抠出指定矩形区域，得到新的 ImageData。
 *
 * 这个函数刻意纯函数化（不进 DOM 也不依赖 Canvas）的原因：
 *
 * 1. 单元测试能在 Node 里直接跑，无需拉起浏览器
 * 2. 内容脚本里同样可以用：先在 Canvas 上拿到 ImageData，再调用本函数
 *
 * 输入约定：data 是 RGBA 八位宽，按行连续存储。这是 jsQR 与 Canvas
 * getImageData 共同的标准布局，省掉一次转换。
 */
export function extractRegion(
  source: { data: Uint8ClampedArray; width: number; height: number },
  rect: Rect,
): { data: Uint8ClampedArray; width: number; height: number } {
  const { width: srcW, height: srcH, data: src } = source;

  // 边界裁剪到图像内。越界读取会返回 undefined，越界写入会无声丢失，
  // 二者都会让 jsQR 拿到一张「左半边有图、右半边空白」的奇怪图，直接失败。
  const x0 = Math.max(0, Math.min(rect.x, srcW));
  const y0 = Math.max(0, Math.min(rect.y, srcH));
  const x1 = Math.max(x0, Math.min(rect.x + rect.w, srcW));
  const y1 = Math.max(y0, Math.min(rect.y + rect.h, srcH));
  const w = x1 - x0;
  const h = y1 - y0;

  if (w <= 0 || h <= 0) {
    // 矩形完全在图外，返回 1×1 全白，避免下游崩
    return {
      data: new Uint8ClampedArray([255, 255, 255, 255]),
      width: 1,
      height: 1,
    };
  }

  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y0 + row) * srcW + x0) * 4;
    const dstStart = row * w * 4;
    out.set(src.subarray(srcStart, srcStart + w * 4), dstStart);
  }
  return { data: out, width: w, height: h };
}