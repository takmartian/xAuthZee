/**
 * 二维码往返验证：我们生成的二维码，真实的解码器能不能读出来。
 *
 *   node --test tests/qr-roundtrip.test.ts
 *
 * 光断言「矩阵尺寸自洽」是不够的 —— 矩阵对了但整体画歪了（比如某个模块
 * 错位、颜色反了），扫码器照样读不出来。这里把矩阵按像素画成 RGBA 图，
 * 再交给 jsQR（和扩展里扫图用的是同一个库）解码，断言解出来的文本与
 * 原始 otpauth 链接逐字相同。
 *
 * 这条测试同时守着三件事：
 *   1. lib/qr.ts 生成的矩阵是对的
 *   2. QrModal 里那套「深色模块 = 黑，浅色 = 白」的画法是对的
 *   3. otpauth 链接本身是合法可扫的
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';

import { buildOtpauthUri } from '../lib/otpauth-uri.ts';
import { buildQrMatrix, QR_QUIET_ZONE } from '../lib/qr.ts';
import type { Account } from '../lib/model.ts';

const account = (over: Partial<Account> = {}): Account => ({
  id: 'a1',
  issuer: 'GitHub',
  label: 'rex@example.com',
  secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  domains: [],
  createdAt: 0,
  ...over,
});

/** 把模块矩阵画成 RGBA 像素缓冲（深色=黑，浅色=白，四周留静区） */
function renderMatrix(
  matrix: { size: number; modules: Uint8Array },
  scale = 4,
): { data: Uint8ClampedArray; width: number; height: number } {
  const side = matrix.size + QR_QUIET_ZONE * 2;
  const width = side * scale;
  const height = side * scale;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mx = Math.floor(x / scale) - QR_QUIET_ZONE;
      const my = Math.floor(y / scale) - QR_QUIET_ZONE;
      const dark =
        mx >= 0 &&
        my >= 0 &&
        mx < matrix.size &&
        my < matrix.size &&
        matrix.modules[my * matrix.size + mx] === 1;
      const v = dark ? 0 : 255;
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('二维码能被真实解码器读出来', () => {
  test('标准账号：解出来的就是 otpauth 链接', () => {
    const uri = buildOtpauthUri(account());
    assert.ok(uri);

    const matrix = buildQrMatrix(uri);
    assert.ok(matrix);

    const img = renderMatrix(matrix);
    const decoded = jsQR(img.data, img.width, img.height);
    assert.ok(decoded, 'jsQR 应该能解出结果');
    assert.equal(decoded.data, uri);
  });

  test('特殊字符（中文、@、冒号）也能完整还原', () => {
    const uri = buildOtpauthUri(
      account({ issuer: '示例 服务', label: 'a:b@例.com' }),
    );
    assert.ok(uri);

    const matrix = buildQrMatrix(uri);
    assert.ok(matrix);

    const img = renderMatrix(matrix);
    const decoded = jsQR(img.data, img.width, img.height);
    assert.ok(decoded);
    assert.equal(decoded.data, uri);
  });

  test('非默认算法与位数（SHA256 / 8 位 / 60 秒）也能扫', () => {
    const uri = buildOtpauthUri(
      account({ algorithm: 'SHA256', digits: 8, period: 60 }),
    );
    assert.ok(uri);

    const matrix = buildQrMatrix(uri);
    assert.ok(matrix);

    const img = renderMatrix(matrix);
    const decoded = jsQR(img.data, img.width, img.height);
    assert.ok(decoded);
    assert.equal(decoded.data, uri);
  });
});
