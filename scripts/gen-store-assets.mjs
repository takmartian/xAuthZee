// 生成 Chrome Web Store 上架所需的 promo tiles 和 screenshots 占位。
//
//   npm run store-assets
//
// 输出到 store-assets/：
//   promo/small-440x280.png
//   promo/large-920x680.png
//   promo/marquee-1400x560.png
//   screenshots/01-popup.png
//   screenshots/02-otp-overlay.png
//   screenshots/03-options.png
//   screenshots/04-locked.png
//
// 设计原则：纯 Node + 手写 PNG 编码（沿用 gen-icons.mjs 的 encoder），
// 不引入 sharp / canvas。文本用 5x7 ASCII bitmap 字体（中文字符
// 暂不支持 —— Chrome Web Store 主语言是英文，英文版 tile 即可满足要求）。
// 真实上架前建议用设计工具（Sketch / Figma）出更精细的版本替换。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'store-assets');

// ------------------------------------------------------------- base64 PNG

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
  ihdr[8] = 8;
  ihdr[9] = 6;
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

// ------------------------------------------------------------- canvas

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.buf = Buffer.alloc(w * h * 4); // RGBA
  }
  // 线性插值颜色
  static lerp(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }
  // 填充背景（垂直渐变）
  fillGradient(top, bottom) {
    const px = this.buf;
    for (let y = 0; y < this.h; y++) {
      const t = y / (this.h - 1);
      const c = Canvas.lerp(top, bottom, t);
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 4;
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
      }
    }
  }
  fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.floor(x + w));
    const y1 = Math.min(this.h, Math.floor(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = (py * this.w + px) * 4;
        this.buf[i] = color[0];
        this.buf[i + 1] = color[1];
        this.buf[i + 2] = color[2];
        this.buf[i + 3] = color[3] ?? 255;
      }
    }
  }
  // 有符号距离场：圆角矩形，< 0 表示在内部
  static roundedRectSdf(px, py, half, radius) {
    const qx = Math.abs(px) - (half - radius);
    const qy = Math.abs(py) - (half - radius);
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
  }
  // 抗锯齿圆角矩形（4x 超采样）
  fillRoundedRect(x, y, w, h, radius, color) {
    const SS = 4;
    const acc = new Float64Array(this.w * this.h * 4);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.floor(x + w), y1 = Math.floor(y + h);
    for (let py = y0 * SS; py < y1 * SS; py++) {
      for (let pxx = x0 * SS; pxx < x1 * SS; pxx++) {
        const cx = pxx / SS + 0.5 - (x + w / 2);
        const cy = py / SS + 0.5 - (y + h / 2);
        if (Canvas.roundedRectSdf(cx, cy, w / 2, radius) < 0) {
          const i = (Math.floor(py / SS) * this.w + Math.floor(pxx / SS)) * 4;
          acc[i] += color[0];
          acc[i + 1] += color[1];
          acc[i + 2] += color[2];
          acc[i + 3] += color[3] ?? 255;
        }
      }
    }
    const samples = SS * SS;
    for (let py = y0; py < y1; py++) {
      for (let pxx = x0; pxx < x1; pxx++) {
        const i = (py * this.w + pxx) * 4;
        const a = acc[i + 3] / samples;
        if (a > 0) {
          const scale = a > 0 ? 255 / acc[i + 3] : 0;
          // 混合到现有像素
          const srcR = acc[i] * scale;
          const srcG = acc[i + 1] * scale;
          const srcB = acc[i + 2] * scale;
          const oldA = this.buf[i + 3] / 255;
          const newA = a;
          const outA = newA + oldA * (1 - newA);
          if (outA > 0) {
            this.buf[i] = Math.round((srcR * newA + this.buf[i] * oldA * (1 - newA)) / outA);
            this.buf[i + 1] = Math.round((srcG * newA + this.buf[i + 1] * oldA * (1 - newA)) / outA);
            this.buf[i + 2] = Math.round((srcB * newA + this.buf[i + 2] * oldA * (1 - newA)) / outA);
            this.buf[i + 3] = Math.round(outA * 255);
          }
        }
      }
    }
  }
  // 5x7 ASCII bitmap 字体：每个字符 5 列 × 7 行
  drawText(text, x, y, scale, color) {
    let cx = x;
    for (const ch of text.toUpperCase()) {
      const glyph = FONT5x7[ch];
      if (glyph) {
        for (let row = 0; row < 7; row++) {
          const bits = glyph[row];
          for (let col = 0; col < 5; col++) {
            if (bits & (1 << (4 - col))) {
              this.fillRect(cx + col * scale, y + row * scale, scale, scale, color);
            }
          }
        }
      }
      cx += 6 * scale; // 5 + 1 字符间距
    }
  }
  textWidth(text, scale) {
    return text.length * 6 * scale - scale;
  }
  drawCircle(cx, cy, r, color) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) {
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
          const i = (y * this.w + x) * 4;
          this.buf[i] = color[0];
          this.buf[i + 1] = color[1];
          this.buf[i + 2] = color[2];
          this.buf[i + 3] = color[3] ?? 255;
        }
      }
    }
  }
  fillCircle(cx, cy, r, color) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) {
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
          const i = (y * this.w + x) * 4;
          this.buf[i] = color[0];
          this.buf[i + 1] = color[1];
          this.buf[i + 2] = color[2];
          this.buf[i + 3] = color[3] ?? 255;
        }
      }
    }
  }
  toPng() {
    return encodePng(this.w, this.h, this.buf);
  }
}

// ------------------------------------------------------------- font (5x7 ASCII)

// ------------------------------------------------------------- font (5x7 ASCII)

const FONT5x7 = {
  ' ': [
    0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000,
  ],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  '.': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00110, 0b00110],
  ',': [0b00000, 0b00000, 0b00000, 0b00000, 0b00110, 0b00110, 0b00100],
  ':': [0b00000, 0b00110, 0b00110, 0b00000, 0b00110, 0b00110, 0b00000],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100],
  '?': [0b01110, 0b10001, 0b00001, 0b00110, 0b00100, 0b00000, 0b00100],
  '-': [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
  '/': [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  "'": [0b00100, 0b00100, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
};

// ------------------------------------------------------------- icon

const BG_TOP = [99, 102, 241];
const BG_BOTTOM = [67, 56, 202];
const FG = [255, 255, 255];

/** 渲染 icon（带 ring），返回画好的 Canvas。size 是正方形边长 */
function renderIcon(size) {
  const SS = 4;
  const c = new Canvas(size, size);
  const n = size * SS;
  const half = n / 2;
  const cornerR = n * 0.24;
  const ringOuter = n * 0.345;
  const ringInner = n * 0.215;
  const gapFrom = -Math.PI / 2;
  const gapTo = 0;

  const acc = new Float64Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5 - half;
      const py = y + 0.5 - half;
      let r = 0, g = 0, b = 0, a = 0;
      if (Canvas.roundedRectSdf(px, py, half, cornerR) < 0) {
        const t = y / (n - 1);
        r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t;
        g = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t;
        b = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t;
        a = 255;
        const dist = Math.hypot(px, py);
        if (dist >= ringInner && dist <= ringOuter) {
          const ang = Math.atan2(py, px);
          if (!(ang >= gapFrom && ang <= gapTo)) {
            r = FG[0]; g = FG[1]; b = FG[2];
          }
        }
      }
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
  for (let i = 0; i < size * size; i++) {
    const a3 = acc[i * 4 + 3];
    const a = a3 / samples;
    const scale = a3 > 0 ? 255 / a3 : 0;
    c.buf[i * 4] = Math.round(acc[i * 4] * scale);
    c.buf[i * 4 + 1] = Math.round(acc[i * 4 + 1] * scale);
    c.buf[i * 4 + 2] = Math.round(acc[i * 4 + 2] * scale);
    c.buf[i * 4 + 3] = Math.round(a);
  }
  return c;
}

/** 把一个 Canvas 绘制到目标 Canvas 的指定位置（不缩放） */
function blit(dst, src, x, y) {
  for (let py = 0; py < src.h; py++) {
    for (let pxx = 0; pxx < src.w; pxx++) {
      const si = (py * src.w + pxx) * 4;
      const sa = src.buf[si + 3];
      if (sa === 0) continue;
      const dx = Math.floor(x) + pxx;
      const dy = Math.floor(y) + py;
      if (dx < 0 || dy < 0 || dx >= dst.w || dy >= dst.h) continue;
      const di = (dy * dst.w + dx) * 4;
      const srcA = sa / 255;
      const dstA = dst.buf[di + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) continue;
      const inv = 1 / outA;
      dst.buf[di] = Math.round((src.buf[si] * srcA + dst.buf[di] * dstA * (1 - srcA)) * inv);
      dst.buf[di + 1] = Math.round((src.buf[si + 1] * srcA + dst.buf[di + 1] * dstA * (1 - srcA)) * inv);
      dst.buf[di + 2] = Math.round((src.buf[si + 2] * srcA + dst.buf[di + 2] * dstA * (1 - srcA)) * inv);
      dst.buf[di + 3] = Math.round(outA * 255);
    }
  }
}

// ------------------------------------------------------------- promo tiles

function smallPromo() {
  // 440x280
  const c = new Canvas(440, 280);
  c.fillGradient(BG_TOP, BG_BOTTOM);
  // icon 96x96
  const icon = renderIcon(96);
  blit(c, icon, 24, 92);
  // 标题
  c.drawText('XAUTHZEE', 144, 80, 6, FG);
  // 副标题（小一些）
  c.drawText('TOTP IN YOUR BROWSER', 144, 142, 2, [255, 255, 255, 200]);
  // 装饰下划线
  c.fillRect(144, 174, 96, 3, FG);
  c.drawText('SCAN. CLICK. FILL.', 144, 188, 2, [255, 255, 255, 230]);
  return c;
}

function largePromo() {
  // 920x680
  const c = new Canvas(920, 680);
  c.fillGradient(BG_TOP, BG_BOTTOM);
  // icon 200x200 居中靠上
  const icon = renderIcon(200);
  blit(c, icon, (920 - 200) / 2, 70);
  // 标题
  const titleScale = 12;
  const titleText = 'XAUTHZEE';
  const titleW = c.textWidth(titleText, titleScale);
  c.drawText(titleText, (920 - titleW) / 2, 320, titleScale, FG);
  // 副标题
  const sub = 'TOTP AUTHENTICATOR IN YOUR BROWSER';
  const subW = c.textWidth(sub, 3);
  c.drawText(sub, (920 - subW) / 2, 430, 3, [255, 255, 255, 220]);
  // 三个 feature pill
  const pills = ['SCAN QR', 'ONE-CLICK FILL', 'MASTER PASSWORD'];
  const pillW = 220;
  const pillH = 56;
  const gap = 30;
  const totalW = pills.length * pillW + (pills.length - 1) * gap;
  let px = (920 - totalW) / 2;
  const py = 500;
  for (const t of pills) {
    c.fillRoundedRect(px, py, pillW, pillH, 28, [255, 255, 255, 30]);
    const tw = c.textWidth(t, 2);
    c.drawText(t, px + (pillW - tw) / 2, py + (pillH - 14) / 2, 2, FG);
    px += pillW + gap;
  }
  return c;
}

function marqueePromo() {
  // 1400x560
  const c = new Canvas(1400, 560);
  c.fillGradient(BG_TOP, BG_BOTTOM);
  // 左侧 icon
  const icon = renderIcon(220);
  blit(c, icon, 80, 170);
  // 中部 title + tagline
  c.drawText('XAUTHZEE', 360, 180, 10, FG);
  c.drawText('TOTP AUTHENTICATOR', 360, 290, 3, [255, 255, 255, 220]);
  c.drawText('SCAN. CLICK. FILL.', 360, 330, 3, [255, 255, 255, 220]);
  c.fillRect(360, 364, 80, 3, FG);
  c.drawText('ALL DATA STAYS ON YOUR DEVICE', 360, 380, 2, [255, 255, 255, 200]);
  c.drawText('SYNC VIA YOUR BROWSER ACCOUNT', 360, 402, 2, [255, 255, 255, 200]);
  // 右侧 popup 预览
  drawPopupMock(c, 820, 100, 500, 380);
  return c;
}

/** 简易 popup mock（不绑定真实账号） */
function drawPopupMock(c, x, y, w, h) {
  c.fillRoundedRect(x, y, w, h, 12, [255, 255, 255, 245]);
  // header
  c.fillRect(x, y, w, 32, [245, 245, 250, 255]);
  c.fillRoundedRect(x, y, w, 32, 12, [245, 245, 250, 255]);
  c.fillRect(x, y + 20, w, 12, [245, 245, 250, 255]);
  c.drawText('XAUTHZEE', x + 16, y + 10, 2, [40, 40, 40, 255]);
  // search bar
  c.fillRoundedRect(x + 12, y + 44, w - 24, 28, 14, [240, 240, 245, 255]);
  c.drawText('SEARCH CODES...', x + 24, y + 51, 1, [150, 150, 160, 255]);
  // 4 行账号占位
  const rows = [
    ['GITHUB', 'OCTOCAT@EXAMPLE.COM', '482 915'],
    ['GOOGLE', 'ME@GMAIL.COM', '771 034'],
    ['AWS', 'DEVOPS', '126 853'],
    ['NPM', 'TEAM', '359 412'],
  ];
  for (let i = 0; i < rows.length; i++) {
    const ry = y + 86 + i * 58;
    c.fillRoundedRect(x + 8, ry, w - 16, 50, 6, [255, 255, 255, 255]);
    c.drawText(rows[i][0], x + 18, ry + 8, 1, [40, 40, 40, 255]);
    c.drawText(rows[i][1], x + 18, ry + 22, 1, [120, 120, 130, 255]);
    c.drawText(rows[i][2], x + 18, ry + 34, 2, [40, 40, 40, 255]);
    // ring
    c.drawCircle(x + w - 28, ry + 24, 8, [99, 102, 241, 255]);
  }
}

// ------------------------------------------------------------- screenshots

// 1. popup 截图（带浏览器 chrome 边）
function shotPopup() {
  // 1280x800
  const c = new Canvas(1280, 800);
  // 浏览器 chrome（顶 tab bar + 地址栏）
  c.fillRect(0, 0, 1280, 64, [232, 232, 238, 255]);
  c.fillRect(0, 64, 1280, 2, [210, 210, 215, 255]);
  c.fillRect(0, 66, 1280, 40, [248, 248, 250, 255]);
  c.fillRect(0, 106, 1280, 2, [220, 220, 225, 255]);
  c.drawText('GITHUB.COM', 32, 30, 2, [40, 40, 40, 255]);
  c.drawText('HTTPS://GITHUB.COM/LOGIN', 32, 78, 1, [80, 80, 80, 255]);
  // 页面背景
  c.fillRect(0, 108, 1280, 692, [255, 255, 255, 255]);
  c.drawText('SIGN IN TO GITHUB', 200, 220, 4, [40, 40, 40, 255]);
  c.fillRoundedRect(200, 300, 400, 40, 6, [245, 245, 248, 255]);
  c.drawText('USERNAME', 210, 314, 1, [140, 140, 150, 255]);
  c.fillRoundedRect(200, 360, 400, 40, 6, [245, 245, 248, 255]);
  c.drawText('PASSWORD', 210, 374, 1, [140, 140, 150, 255]);
  c.fillRoundedRect(200, 460, 400, 60, 6, [245, 245, 248, 255]);
  c.drawText('VERIFICATION CODE', 210, 474, 1, [140, 140, 150, 255]);
  c.drawText('482 915', 210, 492, 3, [40, 40, 40, 255]);
  c.fillRoundedRect(200, 560, 400, 44, 6, [99, 102, 241, 255]);
  c.drawText('SIGN IN', 370, 574, 2, [255, 255, 255, 255]);
  // popup 在右侧
  drawPopupMock(c, 740, 140, 360, 540);
  return c;
}

// 2. otp 浮层截图
function shotOtpOverlay() {
  const c = new Canvas(1280, 800);
  c.fillRect(0, 0, 1280, 64, [232, 232, 238, 255]);
  c.fillRect(0, 64, 1280, 2, [210, 210, 215, 255]);
  c.fillRect(0, 66, 1280, 40, [248, 248, 250, 255]);
  c.fillRect(0, 106, 1280, 2, [220, 220, 225, 255]);
  c.drawText('GOOGLE.COM/ACCOUNTS', 32, 30, 2, [40, 40, 40, 255]);
  c.drawText('HTTPS://ACCOUNTS.GOOGLE.COM', 32, 78, 1, [80, 80, 80, 255]);
  c.fillRect(0, 108, 1280, 692, [255, 255, 255, 255]);
  c.drawText('2-STEP VERIFICATION', 400, 200, 4, [40, 40, 40, 255]);
  c.drawText('ENTER THE CODE FROM YOUR AUTHENTICATOR APP', 400, 240, 1, [100, 100, 110, 255]);
  // 六宫格输入
  for (let i = 0; i < 6; i++) {
    c.fillRoundedRect(400 + i * 56, 290, 48, 56, 6, [245, 245, 248, 255]);
  }
  c.drawText('7', 419, 308, 3, [40, 40, 40, 255]);
  c.drawText('7', 475, 308, 3, [40, 40, 40, 255]);
  c.drawText('1', 531, 308, 3, [40, 40, 40, 255]);
  // 浮层 panel
  const px = 700, py = 300, pw = 260, ph = 200;
  c.fillRoundedRect(px, py, pw, ph, 8, [255, 255, 255, 255]);
  c.fillRoundedRect(px, py + ph - 1, pw, 1, 0, [220, 220, 225, 255]);
  c.drawText('GOOGLE', px + 14, py + 12, 2, [40, 40, 40, 255]);
  c.drawText('ME@GMAIL.COM', px + 14, py + 30, 1, [120, 120, 130, 255]);
  c.drawText('771 034', px + 14, py + 50, 4, [40, 40, 40, 255]);
  c.drawText('22 S', px + pw - 50, py + 60, 1, [100, 100, 110, 255]);
  c.drawCircle(px + pw - 30, py + 70, 10, [99, 102, 241, 255]);
  // 高亮绿点（matched indicator）
  c.fillCircle(px + pw - 26, py + 18, 4, [46, 164, 79, 255]);
  // 分隔线 + 第二行
  c.fillRect(px, py + 100, pw, 1, [230, 230, 235, 255]);
  c.drawText('AWS', px + 14, py + 112, 2, [40, 40, 40, 255]);
  c.drawText('126 853', px + 14, py + 130, 2, [40, 40, 40, 255]);
  return c;
}

// 3. options 截图
function shotOptions() {
  const c = new Canvas(1280, 800);
  c.fillRect(0, 0, 1280, 56, [255, 255, 255, 255]);
  c.fillRect(0, 56, 1280, 1, [230, 230, 235, 255]);
  c.drawText('XAUTHZEE - OPTIONS', 40, 22, 2, [40, 40, 40, 255]);
  c.fillRect(40, 100, 700, 36, [255, 255, 255, 255]);
  c.drawText('SECURITY', 60, 116, 2, [40, 40, 40, 255]);
  c.fillRect(60, 144, 200, 18, [40, 40, 40, 255]);
  c.drawText('AUTO-LOCK TIMEOUT: 15 MINUTES', 60, 168, 1, [100, 100, 110, 255]);
  c.fillRoundedRect(60, 200, 180, 36, 6, [40, 40, 40, 255]);
  c.drawText('ENABLE ENCRYPTION', 90, 212, 1, [255, 255, 255, 255]);
  // Domain bindings section
  c.fillRect(40, 290, 700, 30, [255, 255, 255, 255]);
  c.drawText('DOMAIN BINDINGS', 60, 304, 2, [40, 40, 40, 255]);
  const bindings = [
    ['GITHUB.COM', '3 ACCOUNTS'],
    ['GOOGLE.COM', '2 ACCOUNTS'],
    ['AWS.AMAZON.COM', '1 ACCOUNT'],
  ];
  for (let i = 0; i < bindings.length; i++) {
    const y = 350 + i * 50;
    c.fillRoundedRect(60, y, 660, 40, 6, [245, 245, 248, 255]);
    c.drawText(bindings[i][0], 80, y + 14, 1, [40, 40, 40, 255]);
    c.drawText(bindings[i][1], 500, y + 14, 1, [100, 100, 110, 255]);
  }
  // Transfer section
  c.fillRect(40, 530, 700, 30, [255, 255, 255, 255]);
  c.drawText('IMPORT / EXPORT', 60, 544, 2, [40, 40, 40, 255]);
  c.fillRoundedRect(60, 580, 160, 36, 6, [40, 40, 40, 255]);
  c.drawText('EXPORT ALL', 96, 592, 1, [255, 255, 255, 255]);
  c.fillRoundedRect(240, 580, 160, 36, 6, [40, 40, 40, 255]);
  c.drawText('IMPORT FILE', 280, 592, 1, [255, 255, 255, 255]);
  c.fillRoundedRect(420, 580, 240, 36, 6, [40, 40, 40, 255]);
  c.drawText('IMPORT FROM GOOGLE AUTH.', 446, 592, 1, [255, 255, 255, 255]);
  return c;
}

// 4. locked 截图
function shotLocked() {
  const c = new Canvas(1280, 800);
  c.fillRect(0, 0, 1280, 56, [255, 255, 255, 255]);
  c.fillRect(0, 56, 1280, 1, [230, 230, 235, 255]);
  c.drawText('XAUTHZEE', 40, 22, 2, [40, 40, 40, 255]);
  c.fillRect(0, 0, 1280, 800, [245, 245, 250, 255]);
  c.drawText('X', 640, 30, 2, [40, 40, 40, 255]);
  // center unlock card
  const cardX = 440, cardY = 240, cardW = 400, cardH = 320;
  c.fillRoundedRect(cardX, cardY, cardW, cardH, 12, [255, 255, 255, 255]);
  c.fillRoundedRect(cardX, cardY, cardW, 56, 12, [99, 102, 241, 255]);
  c.fillRect(cardX, cardY + 40, cardW, 16, [99, 102, 241, 255]);
  c.drawText('UNLOCK', cardX + 16, cardY + 18, 2, [255, 255, 255, 255]);
  c.drawText('ENTER MASTER PASSWORD', cardX + 24, cardY + 90, 2, [40, 40, 40, 255]);
  c.drawText('TO UNLOCK YOUR 2FA CODES', cardX + 24, cardY + 110, 1, [100, 100, 110, 255]);
  c.fillRoundedRect(cardX + 24, cardY + 140, cardW - 48, 44, 6, [245, 245, 248, 255]);
  c.drawText('* * * * * * * *', cardX + 40, cardY + 156, 2, [40, 40, 40, 255]);
  c.fillRoundedRect(cardX + 24, cardY + 200, cardW - 48, 44, 8, [99, 102, 241, 255]);
  c.drawText('UNLOCK', cardX + 200, cardY + 216, 2, [255, 255, 255, 255]);
  c.drawText('FORGOT PASSWORD? OPEN OPTIONS', cardX + 24, cardY + 262, 1, [120, 120, 130, 255]);
  return c;
}

// ------------------------------------------------------------- main

mkdirSync(join(OUT_DIR, 'promo'), { recursive: true });
mkdirSync(join(OUT_DIR, 'screenshots'), { recursive: true });

const targets = [
  ['promo/small-440x280.png', smallPromo()],
  ['promo/large-920x680.png', largePromo()],
  ['promo/marquee-1400x560.png', marqueePromo()],
  ['screenshots/01-popup.png', shotPopup()],
  ['screenshots/02-otp-overlay.png', shotOtpOverlay()],
  ['screenshots/03-options.png', shotOptions()],
  ['screenshots/04-locked.png', shotLocked()],
];
for (const [rel, c] of targets) {
  const out = join(OUT_DIR, rel);
  writeFileSync(out, c.toPng());
  console.log(`generated ${out}`);
}
