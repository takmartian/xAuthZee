/**
 * 二维码相关单元测试：otpauth 链接生成 + 二维码矩阵。
 *
 *   node --test tests/otpauth-uri.test.ts
 *
 * 这两个模块是纯函数，不碰浏览器 API —— 二维码弹窗的正确性全押在它们身上。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildOtpauthUri } from '../lib/otpauth-uri.ts';
import { buildQrMatrix, qrMatrixToPath, QR_QUIET_ZONE } from '../lib/qr.ts';
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

describe('生成 otpauth 链接', () => {
  test('标准链接：issuer、label、secret 都在', () => {
    const uri = buildOtpauthUri(account());
    assert.ok(uri);
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /issuer=GitHub/);
    assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
    assert.match(uri, /algorithm=SHA1/);
    assert.match(uri, /digits=6/);
    assert.match(uri, /period=30/);
  });

  test('特殊字符被正确编码（@ : 中文）', () => {
    const uri = buildOtpauthUri(
      account({ issuer: '示例 服务', label: 'a:b@例.com' }),
    );
    assert.ok(uri);
    // 原始字符不能直接出现在 path 段里
    assert.ok(!uri.includes('a:b@例.com'), 'label 里的特殊字符应被编码');
    assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
  });

  test('issuer 为空时不出错，也不产生空的 issuer 参数', () => {
    const uri = buildOtpauthUri(account({ issuer: '', label: 'only-label' }));
    assert.ok(uri);
    assert.match(uri, /otpauth:\/\/totp\/only-label/);
    assert.ok(!uri.includes('issuer='), '空 issuer 不该出现在链接里');
  });

  test('label 为空时退回用 issuer 当标签', () => {
    const uri = buildOtpauthUri(account({ label: '' }));
    assert.ok(uri);
    assert.match(uri, /otpauth:\/\/totp\/GitHub/);
  });

  test('加密态（secret 被清空）返回 null，而不是抛错', () => {
    assert.equal(buildOtpauthUri(account({ secret: '' })), null);
  });

  test('secret 不是合法 Base32 时返回 null', () => {
    assert.equal(buildOtpauthUri(account({ secret: 'not-base32!!' })), null);
  });

  test('非默认算法与位数也如实带出', () => {
    const uri = buildOtpauthUri(
      account({ algorithm: 'SHA256', digits: 8, period: 60 }),
    );
    assert.ok(uri);
    assert.match(uri, /algorithm=SHA256/);
    assert.match(uri, /digits=8/);
    assert.match(uri, /period=60/);
  });
});

describe('二维码矩阵', () => {
  test('生成的矩阵尺寸自洽，深色模块占 1/3 左右', () => {
    const m = buildQrMatrix('otpauth://totp/X:y?secret=JBSWY3DPEHPK3PXP');
    assert.ok(m);
    assert.ok(m.size > 0);
    assert.equal(m.modules.length, m.size * m.size);
    const dark = Array.from(m.modules).filter(Boolean).length;
    assert.ok(dark > 0 && dark < m.modules.length);
  });

  test('相同内容生成完全相同的矩阵（可重复）', () => {
    const a = buildQrMatrix('hello');
    const b = buildQrMatrix('hello');
    assert.ok(a && b);
    assert.deepEqual(Array.from(a.modules), Array.from(b.modules));
  });

  test('内容更长 → 矩阵更大', () => {
    const short = buildQrMatrix('a');
    const long = buildQrMatrix('a'.repeat(300));
    assert.ok(short && long);
    assert.ok(long.size > short.size);
  });

  test('空内容返回 null', () => {
    assert.equal(buildQrMatrix(''), null);
  });

  test('path 里每个深色模块一个 M 指令', () => {
    const m = buildQrMatrix('hello');
    assert.ok(m);
    const dark = Array.from(m.modules).filter(Boolean).length;
    const d = qrMatrixToPath(m);
    assert.equal(d.split('M').length - 1, dark);
    assert.ok(d.includes('h1v1h-1z'));
  });

  test('静区是标准的 4 个模块', () => {
    assert.equal(QR_QUIET_ZONE, 4);
  });
});
