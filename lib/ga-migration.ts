/**
 * Google Authenticator 迁移数据解析。
 *
 * Google Authenticator（手机版）的"Transfer accounts / Export"功能
 * 把所有账号编码成一个 `otpauth-migration://offline?data=<BASE64>` QR
 * 码。`data` 是 URL-safe base64 编码的 protobuf，结构如下：
 *
 *   message MigrationPayload {
 *     repeated OtpParameters otp_parameters = 1;
 *     int32 version = 2;
 *     int32 batch_size = 3;
 *     int32 batch_index = 4;
 *     int32 batch_id = 5;
 *   }
 *   message OtpParameters {
 *     bytes secret = 1;
 *     string name = 2;
 *     string issuer = 3;
 *     int32 algorithm = 4;  // 0=UNSPECIFIED, 1=SHA1, 2=SHA256, 3=SHA512, 4=MD5
 *     int32 digits = 5;     // 0=UNSPECIFIED, 1=6, 2=8
 *     int32 type = 6;       // 0=UNSPECIFIED, 1=HOTP, 2=TOTP
 *     int64 counter = 7;
 *   }
 *
 * 关键：enum 第一个值是 UNSPECIFIED，protobuf 缺省值就是它。**GA 实际导
 * 出**对 6 位 TOTP 写的是 digits=1, type=2（不是 0/1）—— 之前的实现把
 * enum 顺序理解错了，导致 6 位被解析成 8 位。
 *
 * 我们不依赖 protobufjs 这种大库 —— 整个 schema 用不到 100 行手写解
 * 码（HOTP / MD5 直接拒绝，剩余字段就那么几个）。
 */

import { b64ToBytes } from './crypto.ts';
import { DEFAULT_PERIOD, type Account, type Algorithm } from './model.ts';

export const GA_MIGRATION_URL_PREFIX = 'otpauth-migration://';

export interface GaMigrationResult {
  accounts: Account[];
  /** 解码成功但跳过的非 TOTP / 不支持算法（用于 UI 提示） */
  skipped: Array<{ reason: 'hotp' | 'md5' | 'unsupported'; name?: string }>;
  /** protobuf 里有 N 个 OtpParameters，最终成功导入 M 个 */
  total: number;
}

export class GaMigrationError extends Error {
  readonly code: 'not_migration_url' | 'bad_base64' | 'not_protobuf' | 'no_accounts';
  constructor(code: GaMigrationError['code'], message: string) {
    super(message);
    this.name = 'GaMigrationError';
    this.code = code;
  }
}

/**
 * 从 `otpauth-migration://...` URL 解码出 Account 列表。
 *
 * 抛 GaMigrationError —— UI 拿错误码做提示文案。
 */
export function parseGaMigrationUrl(url: string): GaMigrationResult {
  if (!url.startsWith(GA_MIGRATION_URL_PREFIX)) {
    throw new GaMigrationError('not_migration_url', '不是 Google Authenticator 迁移链接');
  }
  // URL 长这样：otpauth-migration://offline?data=<BASE64>
  const queryStart = url.indexOf('?');
  if (queryStart < 0) {
    throw new GaMigrationError('not_migration_url', '迁移链接缺少 ?data= 参数');
  }
  const params = new URLSearchParams(url.slice(queryStart + 1));
  const data = params.get('data');
  if (!data) {
    throw new GaMigrationError('not_migration_url', '迁移链接缺少 data 参数');
  }
  return parseGaMigrationData(data);
}

/**
 * 直接吃 base64（URL-safe 或标准都可）字符串。
 *
 * protobuf 是 binary 编码，对 base64 实现细节很敏感：
 *   - URL-safe 用 `-_`，标准用 `+/` —— 我们都支持（先按 URL-safe 试，失败再按标准）
 *   - 末尾可能有 `=` padding
 */
export function parseGaMigrationData(b64: string): GaMigrationResult {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Flexible(b64);
  } catch (e) {
    throw new GaMigrationError('bad_base64', e instanceof Error ? e.message : 'base64 解码失败');
  }
  if (bytes.length === 0) {
    throw new GaMigrationError('not_protobuf', '数据为空');
  }
  const proto = parseMigrationPayload(bytes);
  if (proto.otp_parameters.length === 0) {
    throw new GaMigrationError('no_accounts', '迁移数据里没有账号');
  }
  const accounts: Account[] = [];
  const skipped: GaMigrationResult['skipped'] = [];
  for (const p of proto.otp_parameters) {
    // enum 0 是 UNSPECIFIED，1=HOTP，2=TOTP。
    // GA 实际导出 TOTP 写 2；老 spec 误把 0=HOTP/1=TOTP 会把全部 TOTP 漏判。
    if (p.type === 1) {
      // HOTP
      skipped.push({ reason: 'hotp', name: p.name });
      continue;
    }
    if (p.algorithm === 4) {
      // MD5
      skipped.push({ reason: 'md5', name: p.name });
      continue;
    }
    const algorithm: Algorithm =
      p.algorithm === 2 ? 'SHA256' : p.algorithm === 3 ? 'SHA512' : 'SHA1';
    // enum 0=UNSPECIFIED, 1=6 位, 2=8 位
    const digits: 6 | 8 = p.digits === 2 ? 8 : 6;
    // GA 把 issuer 和 label 都塞在 name 字段里（"Issuer:account@example.com"），
    // 但同时也有 issuer 字段。我们优先用 issuer 字段；name 拆出 label。
    const name = p.name ?? '';
    const issuerFromName = name.includes(':') ? name.slice(0, name.indexOf(':')) : '';
    const labelFromName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    const issuer = (p.issuer ?? '') || issuerFromName;
    const label = labelFromName;
    if (!label) {
      skipped.push({ reason: 'unsupported', name: p.name });
      continue;
    }
    // GA 的 secret 是 raw bytes（已经 base32 解码过的形态），我们需要的是 Base32 字符串
    // —— 重新编码成大写 Base32 字母表
    const secret = bytesToBase32(p.secret);
    if (!secret) {
      skipped.push({ reason: 'unsupported', name: p.name });
      continue;
    }
    accounts.push({
      id: newAccountId(),
      issuer: issuer || label,
      label: label !== issuer ? label : '',
      secret,
      algorithm,
      digits,
      period: DEFAULT_PERIOD,
      domains: [],
      createdAt: Date.now(),
    });
  }
  if (accounts.length === 0) {
    throw new GaMigrationError('no_accounts', '没有可导入的 TOTP 账号');
  }
  return { accounts, skipped, total: proto.otp_parameters.length };
}

// ------------------------------------------------------------ protobuf decoder

interface OtpParametersProto {
  secret: Uint8Array;
  name: string;
  issuer: string;
  algorithm: number;
  digits: number;
  type: number;
  counter: number;
}

interface MigrationPayloadProto {
  otp_parameters: OtpParametersProto[];
  version: number;
  batch_size: number;
  batch_index: number;
  batch_id: number;
}

function parseMigrationPayload(buf: Uint8Array): MigrationPayloadProto {
  const out: MigrationPayloadProto = {
    otp_parameters: [],
    version: 0,
    batch_size: 0,
    batch_index: 0,
    batch_id: 0,
  };
  let off = 0;
  while (off < buf.length) {
    const tag = readVarint(buf, off);
    off = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 0x07;
    if (field === 1 && wire === 2) {
      // repeated OtpParameters
      const len = readVarint(buf, off);
      off = len.next;
      const inner = buf.slice(off, off + len.value);
      off += len.value;
      out.otp_parameters.push(parseOtpParameters(inner));
    } else if (wire === 0) {
      // varint scalar
      const v = readVarint(buf, off);
      off = v.next;
      if (field === 2) out.version = v.value;
      else if (field === 3) out.batch_size = v.value;
      else if (field === 4) out.batch_index = v.value;
      else if (field === 5) out.batch_id = v.value;
      // 忽略未识别字段（forward compat）
    } else if (wire === 2) {
      // length-delimited —— 跳过未识别的 string/bytes/message
      const len = readVarint(buf, off);
      off = len.next + len.value;
    } else {
      // 不支持的 wire type
      break;
    }
  }
  return out;
}

function parseOtpParameters(buf: Uint8Array): OtpParametersProto {
  const out: OtpParametersProto = {
    secret: new Uint8Array(0),
    name: '',
    issuer: '',
    algorithm: 0,
    digits: 0,
    type: 1, // 默认 TOTP
    counter: 0,
  };
  let off = 0;
  while (off < buf.length) {
    const tag = readVarint(buf, off);
    off = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 0x07;
    if (wire === 2) {
      const len = readVarint(buf, off);
      off = len.next;
      const data = buf.slice(off, off + len.value);
      off += len.value;
      if (field === 1) out.secret = data;
      else if (field === 2) out.name = new TextDecoder().decode(data);
      else if (field === 3) out.issuer = new TextDecoder().decode(data);
    } else if (wire === 0) {
      const v = readVarint(buf, off);
      off = v.next;
      if (field === 4) out.algorithm = v.value;
      else if (field === 5) out.digits = v.value;
      else if (field === 6) out.type = v.value;
      else if (field === 7) out.counter = v.value;
    } else {
      break;
    }
  }
  return out;
}

function readVarint(buf: Uint8Array, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  while (i < buf.length) {
    const b = buf[i]!;
    value |= (b & 0x7f) << shift;
    i++;
    if ((b & 0x80) === 0) {
      // 注意：protobuf varint 是无符号的，但我们的 schema 都是非负 enum
      // + 小整数，所以 number 不会溢出。如果要支持 int64 字段就得上 BigInt。
      return { value: value >>> 0, next: i };
    }
    shift += 7;
    if (shift >= 32) throw new Error('varint too large');
  }
  throw new Error('truncated varint');
}

// ------------------------------------------------------------ base64

function decodeBase64Flexible(s: string): Uint8Array {
  // 优先按 URL-safe 试一次（GA 用 URL-safe），失败再按标准
  const norm1 = s.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return b64ToBytes(norm1);
  } catch {
    // b64ToBytes 不抛——atob/Buffer 都不在乎。保留 fallback 逻辑。
  }
  return b64ToBytes(s);
}

// ------------------------------------------------------------ Base32

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * 把 raw secret bytes 编码成大写 Base32 字符串（无 padding）。
 * 这是 normalizeSecret 接受的格式。
 */
function bytesToBase32(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 0x1f]!;
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 0x1f]!;
  }
  return out;
}

// ------------------------------------------------------------ id

/**
 * 与 lib/model.ts 的 newAccountId 一致的生成方式，但这里就地定义一个
 * 简化版（不引入 model.ts 内部常量以保持模块依赖最小）。
 */
function newAccountId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(10, '0').slice(0, 10);
}
