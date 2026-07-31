/**
 * GA migration 解析单测。
 *
 *   node --test tests/ga-migration.test.ts
 *
 * 因为 GA 的 protobuf schema 简单（5 个字段 + 嵌套 1 个），手写 encoder
 * 来做 roundtrip 是最直接的——避免拉 protobufjs 这种大库。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGaMigrationUrl,
  parseGaMigrationData,
  GaMigrationError,
  type GaMigrationResult,
} from '../lib/ga-migration.ts';
import { bytesToB64 } from '../lib/crypto.ts';

// ------------------------------------------------------------ 极简 protobuf encoder

function writeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return out;
}

function writeBytes(field: number, data: number[] | Uint8Array | string): number[] {
  const arr = typeof data === 'string' ? new TextEncoder().encode(data) : Array.from(data);
  return [
    ...writeVarint((field << 3) | 2),
    ...writeVarint(arr.length),
    ...arr,
  ];
}

function writeVarintField(field: number, value: number): number[] {
  return [...writeVarint((field << 3) | 0), ...writeVarint(value)];
}

interface EncodeOtpInput {
  secret: Uint8Array;
  name?: string;
  issuer?: string;
  algorithm?: number; // 0..4
  digits?: number; // 0=6, 1=8
  type?: number; // 0=HOTP, 1=TOTP
  counter?: number;
}

function encodeOtpParameters(o: EncodeOtpInput): number[] {
  const out: number[] = [];
  if (o.secret.length) out.push(...writeBytes(1, o.secret));
  if (o.name) out.push(...writeBytes(2, o.name));
  if (o.issuer) out.push(...writeBytes(3, o.issuer));
  if (o.algorithm !== undefined) out.push(...writeVarintField(4, o.algorithm));
  if (o.digits !== undefined) out.push(...writeVarintField(5, o.digits));
  if (o.type !== undefined) out.push(...writeVarintField(6, o.type));
  if (o.counter !== undefined) out.push(...writeVarintField(7, o.counter));
  return out;
}

function encodeMigrationPayload(otps: number[][]): Uint8Array {
  const out: number[] = [];
  for (const inner of otps) {
    out.push(...writeBytes(1, inner));
  }
  return new Uint8Array(out);
}

function b64urlFromBytes(b: Uint8Array): string {
  return bytesToB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeMigrationUrl(otps: EncodeOtpInput[]): string {
  const inner = otps.map(encodeOtpParameters);
  const payload = encodeMigrationPayload(inner);
  return `otpauth-migration://offline?data=${b64urlFromBytes(payload)}`;
}

// 期望的 Base32 编码（手算对照）
// secret = [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef] (10 字节 "Hello!Þ­¾ï")
// Base32 编码：每 5 bit 一组
// 0x48 = 01001000 → 01001 00000 1 → 续
//  实际手算太繁琐 —— 测试只验证 round-trip 后 secret 经过 Base32 编码能 decode 回原 bytes
function base32ToBytes(s: string): Uint8Array {
  const lookup = new Int8Array(36);
  for (let i = 0; i < 26; i++) lookup[i] = i; // A=0 ... Z=25
  for (let i = 0; i < 6; i++) lookup[26 + i] = 26 + i; // 2=26 ... 7=31
  lookup[0] = -1; // 占位防止后续被覆盖（A 也是字符合法值）
  // 重做：把 A-Z 映射到 0..25
  for (let i = 0; i < 26; i++) lookup[i] = i;
  const charToVal = new Map<string, number>();
  for (let i = 0; i < 26; i++) charToVal.set(String.fromCharCode(65 + i), i);
  for (let i = 0; i < 6; i++) charToVal.set('234567'[i]!, 26 + i);
  const clean = s.toUpperCase().replace(/=+$/, '');
  let bits = 0, value = 0, out: number[] = [];
  for (const ch of clean) {
    const v = charToVal.get(ch) ?? -1;
    if (v < 0) continue;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ------------------------------------------------------------ 测试

describe('parseGaMigrationUrl 入口校验', () => {
  test('非 otpauth-migration:// 开头 → not_migration_url', () => {
    assert.throws(
      () => parseGaMigrationUrl('otpauth://totp/GitHub:me'),
      (e: unknown) => e instanceof GaMigrationError && e.code === 'not_migration_url',
    );
  });

  test('缺 ?data= → not_migration_url', () => {
    assert.throws(
      () => parseGaMigrationUrl('otpauth-migration://offline'),
      (e: unknown) => e instanceof GaMigrationError && e.code === 'not_migration_url',
    );
  });

  test('data 为空字符串 → not_migration_url', () => {
    // data 是空 → 走"data 缺失"分支，错误码 not_migration_url
    assert.throws(
      () => parseGaMigrationUrl('otpauth-migration://offline?data='),
      (e: unknown) => e instanceof GaMigrationError && e.code === 'not_migration_url',
    );
  });
});

describe('parseGaMigrationData roundtrip', () => {
  test('单条 SHA1 TOTP 6 位', () => {
    const secret = new TextEncoder().encode('JBSWY3DPEHPK3PXP');
    const url = makeMigrationUrl([
      { secret, name: 'octocat@example.com', issuer: 'GitHub', algorithm: 1, digits: 1, type: 2 },
    ]);
    const r = parseGaMigrationUrl(url);
    assert.equal(r.accounts.length, 1);
    const acc = r.accounts[0]!;
    assert.equal(acc.issuer, 'GitHub');
    assert.equal(acc.label, 'octocat@example.com');
    assert.equal(acc.algorithm, 'SHA1');
    assert.equal(acc.digits, 6);
    assert.equal(acc.period, 30);
    assert.deepEqual(acc.domains, []);
    assert.deepEqual(base32ToBytes(acc.secret), secret);
    assert.equal(r.skipped.length, 0);
    assert.equal(r.total, 1);
  });

  test('SHA256 + 8 位 + 显式 issuer 字段', () => {
    const secret = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const url = makeMigrationUrl([
      { secret, name: 'me@example.com', issuer: 'Acme', algorithm: 2, digits: 2, type: 2 },
    ]);
    const r = parseGaMigrationUrl(url);
    const acc = r.accounts[0]!;
    assert.equal(acc.algorithm, 'SHA256');
    assert.equal(acc.digits, 8);
    assert.equal(acc.issuer, 'Acme');
    assert.equal(acc.label, 'me@example.com');
  });

  test('无 issuer 字段，从 name 拆分（"Issuer:account"）', () => {
    const secret = new TextEncoder().encode('ABCDEFGH');
    const url = makeMigrationUrl([
      { secret, name: 'Google:me@gmail.com', algorithm: 1, digits: 1, type: 2 },
    ]);
    const r = parseGaMigrationUrl(url);
    const acc = r.accounts[0]!;
    assert.equal(acc.issuer, 'Google');
    assert.equal(acc.label, 'me@gmail.com');
  });

  test('多条混合 + 部分被跳过（HOTP / MD5）', () => {
    const secret = new TextEncoder().encode('JBSWY3DPEHPK3PXP');
    const url = makeMigrationUrl([
      { secret, name: 'ok1@example.com', issuer: 'OK1', algorithm: 1, digits: 1, type: 2 },
      { secret, name: 'hotp@example.com', issuer: 'HOTP', algorithm: 1, digits: 1, type: 1 },
      { secret, name: 'md5@example.com', issuer: 'MD5', algorithm: 4, digits: 1, type: 2 },
      { secret, name: 'ok2@example.com', issuer: 'OK2', algorithm: 3, digits: 1, type: 2 },
    ]);
    const r: GaMigrationResult = parseGaMigrationUrl(url);
    assert.equal(r.total, 4);
    assert.equal(r.accounts.length, 2);
    assert.equal(r.accounts[0]!.issuer, 'OK1');
    assert.equal(r.accounts[1]!.issuer, 'OK2');
    assert.equal(r.accounts[1]!.algorithm, 'SHA512');
    assert.equal(r.skipped.length, 2);
    assert.ok(r.skipped.some((s) => s.reason === 'hotp'));
    assert.ok(r.skipped.some((s) => s.reason === 'md5'));
  });

  test('全是 HOTP → no_accounts', () => {
    const secret = new TextEncoder().encode('JBSWY3DPEHPK3PXP');
    const url = makeMigrationUrl([
      { secret, name: 'hotp1@example.com', algorithm: 1, type: 1 },
    ]);
    assert.throws(
      () => parseGaMigrationUrl(url),
      (e: unknown) => e instanceof GaMigrationError && e.code === 'no_accounts',
    );
  });

  test('algorithm=0 (UNSPECIFIED) 默认 SHA1', () => {
    const secret = new TextEncoder().encode('JBSWY3DPEHPK3PXP');
    const url = makeMigrationUrl([
      { secret, name: 'u@example.com', algorithm: 0, digits: 1, type: 2 },
    ]);
    const r = parseGaMigrationUrl(url);
    assert.equal(r.accounts[0]!.algorithm, 'SHA1');
  });

  test('digits=0 (UNSPECIFIED) 默认 6 位', () => {
    const secret = new TextEncoder().encode('JBSWY3DPEHPK3PXP');
    const url = makeMigrationUrl([
      { secret, name: 'u@example.com', algorithm: 1, digits: 0, type: 2 },
    ]);
    const r = parseGaMigrationUrl(url);
    assert.equal(r.accounts[0]!.digits, 6);
  });

  test('真实 GA 导出格式：digits=1=6 位、type=2=TOTP', () => {
    // 用户反馈：6 位 TOTP 在 GA 里，导过来变 8 位。
    // 根因：之前把 enum 映射写错。digits=1 才是 6 位，type=2 才是 TOTP。
    // 这个测试是回归保护 —— 锁定为「真实 GA 字节 → 6 位 TOTP」的映射。
    const secret = new TextEncoder().encode('JBSWY3DPEHPK3PXP');
    const url = makeMigrationUrl([
      // GA 实际写的方式：algorithm=1 (SHA1), digits=1 (6 位), type=2 (TOTP)
      { secret, name: 'me@example.com', issuer: 'GA-Test', algorithm: 1, digits: 1, type: 2 },
    ]);
    const r = parseGaMigrationUrl(url);
    assert.equal(r.accounts.length, 1);
    assert.equal(r.accounts[0]!.digits, 6, '6 位 GA 账户必须导入为 6 位');
    assert.equal(r.accounts[0]!.algorithm, 'SHA1');
  });
});

describe('parseGaMigrationData base64 容错', () => {
  test('URL-safe base64（带 -_）正常解析', () => {
    const secret = new TextEncoder().encode('JBSWY3DPEHPK3PXP');
    const url = makeMigrationUrl([{ secret, name: 'me@example.com', algorithm: 1, type: 2 }]);
    // url 已经用 URL-safe 编码；提取 data 再直接传 parseGaMigrationData
    const data = url.split('data=')[1]!;
    const r = parseGaMigrationData(data);
    assert.equal(r.accounts.length, 1);
  });

  test('非 base64 字符串 → bad_base64 或 not_protobuf', () => {
    assert.throws(
      () => parseGaMigrationData('@@@not-base64@@@'),
      (e: unknown) => e instanceof GaMigrationError,
    );
  });
});
