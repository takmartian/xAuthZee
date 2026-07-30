import jsQR from 'jsqr';
import type { Rect } from './types.ts';
import { extractRegion } from './region.ts';

/**
 * 解码 ImageData 中的二维码。
 *
 * 选 dontInvert 而非默认的 attemptBoth：attemptBoth 在找不到正像时会
 * 再尝试一次反色，速度慢一倍。对 2FA QR 来说，黑底深模块是正像，
 * 反色只会引入误报。
 *
 * 注意 jsQR 内部对「onlyInvert」的处理有 bug —— 它会跳过反色图的
 * 计算却仍去访问该变量，导致 TypeError。所以「只认正像」在 jsQR 里
 * 就是「不要反色尝试」，即 dontInvert。
 *
 * 找不到二维码时返回 null（jsQR 的本意），不要抛 —— 调用方要靠这个
 * 来区分「解码失败，重试一次」与「解码成功但链接不合法」。
 */
export function decodeImageData(
  image: { data: Uint8ClampedArray; width: number; height: number },
): string | null {
  const result = jsQR(image.data, image.width, image.height, {
    inversionAttempts: 'dontInvert',
  });
  return result?.data ?? null;
}

/**
 * 把整张图像和选区都吃进来：裁剪 + 解码一步到位。
 *
 * 包装这一层的目的是把「裁剪越界」「解码失败」「解码到非 otpauth」
 * 三件事的兜底集中到一处。调用方只需要问「拿到合法字符串了吗」。
 */
export function decodeRegion(
  image: { data: Uint8ClampedArray; width: number; height: number },
  rect: Rect,
): string | null {
  const region = extractRegion(image, rect);
  return decodeImageData(region);
}