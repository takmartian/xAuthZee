/**
 * qrcode 的纯 JS 核心入口没有官方类型声明（@types/qrcode 只覆盖主入口）。
 *
 * 这里只声明我们真正用到的那一个函数 —— 我们不走 canvas / svg-tag 渲染器，
 * 而是拿模块矩阵自己画 SVG，所以只需要 create()。
 */
declare module 'qrcode/lib/core/qrcode.js' {
  export interface QrCoreModules {
    /** 矩阵边长（模块数） */
    size: number;
    /** 长度 = size * size，1 = 深色模块，0 = 浅色 */
    data: Uint8Array;
  }

  export interface QrCoreResult {
    modules: QrCoreModules;
    version: number;
    errorCorrectionLevel: { bit: number };
  }

  export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

  export function create(
    text: string,
    options?: { errorCorrectionLevel?: QrErrorCorrectionLevel },
  ): QrCoreResult;
}
