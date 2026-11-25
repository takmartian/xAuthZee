/**
 * 二维码矩阵生成。
 *
 * 只用 qrcode 的纯 JS 核心（lib/core/qrcode）拿模块矩阵，SVG 自己在 React
 * 里画。两个原因：
 *
 * 1. **不拖 Node 依赖**。qrcode 的主入口 lib/index.js 会 require('./server')，
 *    里面带着 fs/http 这些 Node 内置模块；浏览器里根本用不上，还会把构建搞复杂。
 * 2. **自己画 SVG 比交给库画更好控**。渲染出来的是一组 <rect>，尺寸、颜色、
 *    静区（quiet zone）都能按 popup 的主题来，不用去迁就库的默认样式。
 *
 * 容错级别选 M：二维码内容是 otpauth 链接，屏幕对屏幕扫码，密度过高反而
 * 难认。M 是各验证器的通用默认，容错与密度的平衡点。
 *
 * 纯函数，可以直接 node --test 跑。
 */

// 深导入必须带 .js 后缀：Node 的 ESM 解析器不会给无后缀的路径补 .js，
// 写成 'qrcode/lib/core/qrcode' 会直接 ERR_MODULE_NOT_FOUND。
import { create } from 'qrcode/lib/core/qrcode.js';

export interface QrMatrix {
  /** 矩阵边长（模块数） */
  size: number;
  /** 长度 = size * size，1 = 深色模块，0 = 浅色 */
  modules: Uint8Array;
}

/** 静区宽度（模块数）。QR 规范要求至少 4 */
export const QR_QUIET_ZONE = 4;

/**
 * 生成二维码矩阵。内容过长（超出版本上限）时返回 null —— 调用方负责兜底。
 */
export function buildQrMatrix(text: string): QrMatrix | null {
  if (!text) return null;
  try {
    const result = create(text, { errorCorrectionLevel: 'M' });
    return { size: result.modules.size, modules: result.modules.data };
  } catch {
    return null;
  }
}

/**
 * 把矩阵转成 SVG 的 path 描述（只画深色模块，比逐个 rect 少一半节点）。
 *
 * 返回的是 d 属性字符串，调用方直接塞进 <path>。
 */
export function qrMatrixToPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.modules[y * matrix.size + x]) {
        parts.push(`M${x} ${y}h1v1h-1z`);
      }
    }
  }
  return parts.join('');
}
