// 生成扩展图标（16/32/48/128 PNG）。
// 手写 PNG 编码，避免为了几张图标引入 canvas / sharp 这类重依赖
// —— 商店审核会看包体和依赖，能不加就不加。
//
//   npm run icons
//
// 图形：圆角方块底 + 缺口圆环（呼应 TOTP 倒计时环）。
// 缺口在右上，270° 弧，16px 下仍能辨认。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');
const SIZES = [16, 32, 48, 128];
const SS = 4; // 超采样倍数，用于抗锯齿

const BG_TOP = [99, 102, 241]; // #6366F1
const BG_BOTTOM = [67, 56, 202]; // #4338CA
const FG = [255, 255, 255];

/** CRC32：Node 20.15+ 有 zlib.crc32，低版本回退到查表实现 */
const crc32 = await (async () => {
  const { crc32: native } = await import('node:zlib');
  if (typeof native === 'function') return native;
  const table = Int32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  return (buf) => {
    let c = -1;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 10..12 = compression / filter / interlace，全部为 0

  // 每行前置一个 filter 字节（0 = None）
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = y * (width * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 圆角方形的有符号距离场，< 0 表示在内部 */
function roundedRectSdf(px, py, half, radius) {
  const qx = Math.abs(px) - (half - radius);
  const qy = Math.abs(py) - (half - radius);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

function render(size) {
  const n = size * SS;
  const acc = new Float64Array(size * size * 4);
  const half = n / 2;
  const cornerR = n * 0.24;
  const ringOuter = n * 0.345;
  const ringInner = n * 0.215;

  // 缺口：从 -90°（正上方）顺时针 90° 留空，形成倒计时环的观感
  const gapFrom = -Math.PI / 2;
  const gapTo = 0;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5 - half;
      const py = y + 0.5 - half;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (roundedRectSdf(px, py, half, cornerR) < 0) {
        // 纵向渐变底
        const t = y / (n - 1);
        r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t;
        g = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t;
        b = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t;
        a = 255;

        const dist = Math.hypot(px, py);
        if (dist >= ringInner && dist <= ringOuter) {
          const ang = Math.atan2(py, px);
          const inGap = ang >= gapFrom && ang <= gapTo;
          if (!inGap) {
            r = FG[0];
            g = FG[1];
            b = FG[2];
          }
        }
      }

      // 盒式降采样到目标分辨率
      const ox = (x / SS) | 0;
      const oy = (y / SS) | 0;
      const i = (oy * size + ox) * 4;
      acc[i] += r * (a / 255);
      acc[i + 1] += g * (a / 255);
      acc[i + 2] += b * (a / 255);
      acc[i + 3] += a;
    }
  }

  const samples = SS * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const alpha = acc[i * 4 + 3] / samples;
    // 预乘还原，避免边缘出现深色描边
    const scale = alpha > 0 ? 255 / acc[i * 4 + 3] : 0;
    out[i * 4] = Math.round(acc[i * 4] * scale);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] * scale);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] * scale);
    out[i * 4 + 3] = Math.round(alpha);
  }
  return encodePng(size, size, out);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `${size}.png`);
  writeFileSync(file, render(size));
  console.log(`generated ${file}`);
}
