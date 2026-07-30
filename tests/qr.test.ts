/**
 * M2 二维码链路单元测试。
 *
 * 覆盖三件事：
 *
 * 1. 缩放与裁剪数学。这是计划里点名要验证的「100%/125%/150%/200%
 *    缩放 + Retina/1× 下裁剪坐标正确」。把 devicePixelRatio 与浏览器缩放
 *    合并成「实测截屏宽 / innerWidth」这一项后，剩下的就是普通的乘法 +
 *    边界裁剪。
 *
 * 2. jsQR 集成。jsQR 本身没问题，但要确认我们的封装没有把数据写错：
 *    通道顺序（RGBA 不是 RGB 或 BGRA）、尺寸、数组类型（Uint8ClampedArray）。
 *
 * 3. 区域裁剪的越界兜底。框选超出图像边界是常见情况（用户拖到了
 *    视口外），不能让它把整条链路弄崩。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';

import {
  computeCaptureScale,
  selectionToCaptureRect,
  clampRectToImage,
} from '../lib/qr/scale.ts';
import { extractRegion } from '../lib/qr/region.ts';
import { decodeImageData, decodeRegion } from '../lib/qr/decode.ts';

/** 用 qrcode 库生成一个已知的二维码位图（黑=1，白=0） */
function renderQrMatrix(text: string, scale: number): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const qr = QRCode.create(text);
  const size = qr.modules.size;
  const dim = size * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);

  // qrcode 的 data 是 Uint8Array，长度 size*size，每项 0 或 1
  const buf = qr.modules.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = buf[y * size + x] === 1;
      const v = on ? 0 : 255;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const idx = ((y * scale + dy) * dim + (x * scale + dx)) * 4;
          data[idx] = v;
          data[idx + 1] = v;
          data[idx + 2] = v;
          data[idx + 3] = 255;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

// ------------------------------------------------------- 缩放与裁剪数学

describe('computeCaptureScale', () => {
  test('100% 缩放 + 普通屏：1.0', () => {
    assert.equal(computeCaptureScale(1280, 1280), 1);
  });

  test('100% 缩放 + Retina 2×：2.0', () => {
    assert.equal(computeCaptureScale(2560, 1280), 2);
  });

  test('125% 缩放 + 1×：1.25', () => {
    assert.equal(computeCaptureScale(1600, 1280), 1.25);
  });

  test('150% 缩放 + Retina 2×：3.0', () => {
    assert.equal(computeCaptureScale(3840, 1280), 3);
  });

  test('200% 缩放 + 1×：2.0', () => {
    assert.equal(computeCaptureScale(2560, 1280), 2);
  });

  test('窗口宽 ≤ 0 抛错（避免除零）', () => {
    assert.throws(() => computeCaptureScale(1280, 0));
  });
});

describe('selectionToCaptureRect', () => {
  test('1× 缩放下坐标原样转换', () => {
    const rect = selectionToCaptureRect(
      { x: 100, y: 200, w: 300, h: 150 },
      { width: 1280, height: 800 },
      { width: 1280, height: 800 },
    );
    assert.deepEqual(rect, { x: 100, y: 200, w: 300, h: 150 });
  });

  test('Retina 2× 下坐标 ×2', () => {
    const rect = selectionToCaptureRect(
      { x: 100, y: 200, w: 300, h: 150 },
      { width: 1280, height: 800 },
      { width: 2560, height: 1600 },
    );
    assert.deepEqual(rect, { x: 200, y: 400, w: 600, h: 300 });
  });

  test('150% 缩放 + 1× 屏下坐标 ×1.5 后取整', () => {
    const rect = selectionToCaptureRect(
      { x: 100, y: 100, w: 201, h: 201 },
      { width: 1280, height: 800 },
      { width: 1920, height: 1200 },
    );
    // 100 * 1.5 = 150；201 * 1.5 = 301.5 → 302
    assert.deepEqual(rect, { x: 150, y: 150, w: 302, h: 302 });
  });
});

describe('clampRectToImage', () => {
  test('矩形完全在图内：原样', () => {
    assert.deepEqual(
      clampRectToImage({ x: 10, y: 10, w: 100, h: 50 }, 500, 500),
      { x: 10, y: 10, w: 100, h: 50 },
    );
  });

  test('超出右边界裁剪到图像内', () => {
    assert.deepEqual(
      clampRectToImage({ x: 400, y: 10, w: 200, h: 50 }, 500, 500),
      { x: 400, y: 10, w: 100, h: 50 },
    );
  });

  test('左上越界取 0，尺寸相应收缩', () => {
    assert.deepEqual(
      clampRectToImage({ x: -30, y: -20, w: 100, h: 50 }, 500, 500),
      { x: 0, y: 0, w: 70, h: 30 },
    );
  });

  test('完全越界（宽或高 ≤ 0）收成 0', () => {
    assert.deepEqual(clampRectToImage({ x: 600, y: 600, w: 50, h: 50 }, 500, 500), {
      x: 500,
      y: 500,
      w: 0,
      h: 0,
    });
  });
});

// -------------------------------------------------- extractRegion 越界兜底

describe('extractRegion', () => {
  test('矩形完全在图内：复制整块像素', () => {
    const src = {
      data: new Uint8ClampedArray([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ]),
      width: 2,
      height: 2,
    };
    const out = extractRegion(src, { x: 0, y: 0, w: 2, h: 2 });
    assert.deepEqual([...out.data], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    assert.equal(out.width, 2);
    assert.equal(out.height, 2);
  });

  test('只取中间一行', () => {
    const src = {
      data: new Uint8ClampedArray([
        1, 2, 3, 4, 5, 6, 7, 8, // 第一行
        9, 10, 11, 12, 13, 14, 15, 16, // 第二行
        17, 18, 19, 20, 21, 22, 23, 24, // 第三行
      ]),
      width: 2,
      height: 3,
    };
    const out = extractRegion(src, { x: 0, y: 1, w: 2, h: 1 });
    assert.deepEqual([...out.data], [9, 10, 11, 12, 13, 14, 15, 16]);
  });

  test('越界时不崩：返回能用的图像（哪怕是空）', () => {
    const src = {
      data: new Uint8ClampedArray(16),
      width: 2,
      height: 2,
    };
    const out = extractRegion(src, { x: 100, y: 100, w: 50, h: 50 });
    assert.equal(out.width, 1);
    assert.equal(out.height, 1);
  });

  test('左上越界：实际只取落在图内的那块', () => {
    const src = {
      data: new Uint8ClampedArray([
        1, 1, 1, 1, 2, 2, 2, 2,
        3, 3, 3, 3, 4, 4, 4, 4,
        5, 5, 5, 5, 6, 6, 6, 6,
      ]),
      width: 2,
      height: 3,
    };
    // 选 (-1, -1, 3, 4)：起点越界，截到 (0,0)；
    // 终点 (-1+3, -1+4) = (2, 3)，与图边界 (2, 3) 重合 → 整图
    const out = extractRegion(src, { x: -1, y: -1, w: 3, h: 4 });
    assert.deepEqual(
      [...out.data],
      [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6],
    );
  });
});

// --------------------------------------------------- jsQR 集成 + 端到端

describe('jsQR 解码', () => {
  // 用一个真实的 otpauth URI 生成二维码图，验证我们生成的 RGBA 缓冲
  // 格式与 jsQR 的期望一致。这是「把图传对」和「把图传错」之间唯一
  // 一道关 —— 一旦传错 jsQR 会沉默地返回 null。
  const sample = 'otpauth://totp/GitHub:rex@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';

  test('整图解码正确', () => {
    const img = renderQrMatrix(sample, 4);
    assert.equal(decodeImageData(img), sample);
  });

  test('白边包裹 + 大空白图也能解（验证 onlyInvert 仍可识别正像）', () => {
    const inner = renderQrMatrix(sample, 4);
    const innerW = inner.width;
    const padded = new Uint8ClampedArray(300 * 300 * 4).fill(255);
    padded.forEach((_, i) => {
      if (i % 4 === 3) padded[i] = 255; // alpha
    });
    // 把 inner 复制到中间
    const offset = ((300 - innerW) / 2 | 0) * 4;
    for (let row = 0; row < innerW; row++) {
      const srcStart = row * innerW * 4;
      const dstStart = offset + row * 300 * 4;
      padded.set(inner.data.subarray(srcStart, srcStart + innerW * 4), dstStart);
    }
    assert.equal(decodeImageData({ data: padded, width: 300, height: 300 }), sample);
  });

  test('decodeRegion：裁剪一块非正中区域也能解', () => {
    const inner = renderQrMatrix(sample, 4);
    const innerW = inner.width;
    const padded = new Uint8ClampedArray(400 * 400 * 4).fill(255);
    for (let i = 3; i < padded.length; i += 4) padded[i] = 255;
    const offsetX = (400 - innerW) / 2 | 0;
    const offsetY = 100;
    for (let row = 0; row < innerW; row++) {
      const srcStart = row * innerW * 4;
      const dstStart = (offsetY + row) * 400 * 4 + offsetX * 4;
      padded.set(inner.data.subarray(srcStart, srcStart + innerW * 4), dstStart);
    }
    // 选区把整个二维码圈进去（再带点白边余量）
    const rect = { x: offsetX - 10, y: offsetY - 10, w: innerW + 20, h: innerW + 20 };
    assert.equal(decodeRegion({ data: padded, width: 400, height: 400 }, rect), sample);
  });

  test('完全没有 QR 的图返回 null（不是抛错）', () => {
    const blank = new Uint8ClampedArray(100 * 100 * 4).fill(200);
    assert.equal(decodeImageData({ data: blank, width: 100, height: 100 }), null);
  });

  test('解码区域越界时返回 null（不抛）', () => {
    const inner = renderQrMatrix(sample, 4);
    // 选区完全在图像外
    assert.equal(
      decodeRegion(inner, { x: inner.width + 100, y: 0, w: 50, h: 50 }),
      null,
    );
  });
});

// -------------------------------------- 真实 2FA QR PNG fixture 解码验证

/**
 * 加载一张 PNG 文件并转成 jsQR 能直接吃的 RGBA Uint8ClampedArray。
 *
 * 这是「真机链路」的最后一公里：用户在浏览器里被截到的就是 PNG，
 * captureVisibleTab 返回的也是 PNG。Node 这边能完整跑一遍同样的解码，
 * 才说明我们没有把 RGBA 通道顺序、alpha、padding 这些细节搞错。
 */
function loadPngAsImageData(path: string): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const png = PNG.sync.read(readFileSync(path));
  return {
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
    width: png.width,
    height: png.height,
  };
}

describe('真实 2FA QR fixture', () => {
  test('GitHub fixture 解码正确', () => {
    const img = loadPngAsImageData('tests/fixtures/m2-qr-images/1-github.png');
    assert.equal(
      decodeImageData(img),
      'otpauth://totp/GitHub:rex@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    );
  });

  test('Google fixture（SHA256 + 8 位）解码正确', () => {
    const img = loadPngAsImageData('tests/fixtures/m2-qr-images/2-google.png');
    assert.equal(
      decodeImageData(img),
      'otpauth://totp/Google:rex@gmail.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Google&algorithm=SHA256&digits=8',
    );
  });

  test('Microsoft fixture 解码正确', () => {
    const img = loadPngAsImageData('tests/fixtures/m2-qr-images/3-microsoft.png');
    assert.equal(
      decodeImageData(img),
      'otpauth://totp/Microsoft:rex@outlook.com?secret=MFRGGZDFMZTWQ2LKOBQW4IDPMFZGCZDDNZSG4&issuer=Microsoft',
    );
  });

  test('整图 + 选区裁剪（带 50px 余量）也能解', () => {
    const img = loadPngAsImageData('tests/fixtures/m2-qr-images/1-github.png');
    // 假设用户在 (10, 10) 拖了一个 230×230 的选区（M5 的 UI 会给出精确像素）
    const rect = { x: 10, y: 10, w: 230, h: 230 };
    assert.equal(
      decodeRegion(img, rect),
      'otpauth://totp/GitHub:rex@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    );
  });

  test('PNG 经过模拟「整屏截图 + 缩放」后仍能解', () => {
    // 模拟在 150% 缩放的 1× 屏上：截屏图比 innerWidth 大 1.5 倍
    // 用户拖的选区是 CSS 像素 200×200，换算后是 300×300 设备像素
    const img = loadPngAsImageData('tests/fixtures/m2-qr-images/1-github.png');
    const cssViewportWidth = img.width / 1.5; // 假装这张图是 1.5× 截屏
    const cssW = 200, cssH = 200;
    const scale = computeCaptureScale(img.width, cssViewportWidth);
    const captureRect = {
      x: Math.round(10 * scale),
      y: Math.round(10 * scale),
      w: Math.round(cssW * scale),
      h: Math.round(cssH * scale),
    };
    assert.equal(
      decodeRegion(img, captureRect),
      'otpauth://totp/GitHub:rex@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    );
  });
});