import { TOTP, Secret, URI } from 'otpauth';
import {
  ALGORITHMS,
  DEFAULT_ALGORITHM,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  normalizeSecret,
  type Account,
  type AccountDraft,
  type Algorithm,
} from './model.ts';

/**
 * TOTP 计算与 otpauth:// 解析。
 *
 * 用 otpauth 库而不是手写 HMAC：算法本身只有几十行，但 Base32 解码的边界
 * 情况、非 SHA1 算法、非 6 位、非 30 秒周期这些组合容易写错，而验证码算错
 * 是那种「看起来能用、关键时刻登不进去」的隐性 bug。这个库有完整的
 * RFC 测试向量覆盖，值得这点体积。
 */

export interface CodeResult {
  /** 当前验证码，未分组 */
  code: string;
  /** 距离下次刷新还有多少秒（1..period） */
  secondsRemaining: number;
  /** 当前周期已过去的比例，0..1，用于画倒计时环 */
  progress: number;
}

/** 把账号参数还原成 otpauth 库的 TOTP 实例 */
function toTotp(account: Pick<Account, 'secret' | 'algorithm' | 'digits' | 'period'>): TOTP {
  return new TOTP({
    secret: Secret.fromBase32(account.secret),
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.period,
  });
}

/**
 * 计算某一时刻的验证码。
 *
 * timestamp 显式传入而不是内部取 Date.now()，这样倒计时渲染可以复用同一个
 * 时间基准，也让 RFC 测试向量可以直接验证。
 */
export function generateCode(
  account: Pick<Account, 'secret' | 'algorithm' | 'digits' | 'period'>,
  timestamp: number = Date.now(),
): CodeResult {
  const code = toTotp(account).generate({ timestamp });

  const periodMs = account.period * 1000;
  const elapsed = timestamp % periodMs;

  return {
    code,
    secondsRemaining: Math.ceil((periodMs - elapsed) / 1000),
    progress: elapsed / periodMs,
  };
}

/** 把验证码按 3 位一组分开，长验证码更易读也更好念 */
export function groupCode(code: string): string {
  if (code.length === 6 || code.length === 9) {
    return code.replace(/(\d{3})(?=\d)/g, '$1 ');
  }
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

// -------------------------------------------------------------- URI 解析

export type ParseErrorCode =
  | 'not_otpauth'
  | 'hotp_unsupported'
  | 'migration_unsupported'
  | 'malformed';

export class OtpUriError extends Error {
  readonly code: ParseErrorCode;

  constructor(code: ParseErrorCode) {
    super(code);
    this.name = 'OtpUriError';
    this.code = code;
  }
}

/**
 * 解析 otpauth:// 链接（二维码扫出来的内容，或用户手工粘贴）。
 *
 * 对几类「扫到了但我们处理不了」的情况给出可区分的错误码，界面上才能提示
 * 得具体一些 —— 用户扫到 Google Authenticator 的批量导出二维码是很常见的
 * 场景，笼统报「无效的二维码」会让人以为是扫描没对准。
 */
export function parseOtpauthUri(uri: string): AccountDraft {
  const trimmed = uri.trim();

  if (trimmed.toLowerCase().startsWith('otpauth-migration://')) {
    throw new OtpUriError('migration_unsupported');
  }
  if (!trimmed.toLowerCase().startsWith('otpauth://')) {
    throw new OtpUriError('not_otpauth');
  }
  if (trimmed.toLowerCase().startsWith('otpauth://hotp/')) {
    throw new OtpUriError('hotp_unsupported');
  }

  let parsed;
  try {
    parsed = URI.parse(trimmed);
  } catch {
    throw new OtpUriError('malformed');
  }

  if (!(parsed instanceof TOTP)) throw new OtpUriError('hotp_unsupported');

  const algorithm = normalizeAlgorithm(parsed.algorithm);

  return {
    issuer: parsed.issuer ?? '',
    label: parsed.label ?? '',
    secret: parsed.secret.base32,
    algorithm,
    digits: parsed.digits,
    period: parsed.period,
  };
}

/**
 * otpauth 库返回的算法名可能是 SHA1 / SHA-1 之类的变体，
 * 遇到不认识的一律退回 SHA1 —— 这是 RFC 6238 的默认值，
 * 也是实际上唯一被广泛使用的算法。
 */
function normalizeAlgorithm(raw: string): Algorithm {
  const upper = raw.toUpperCase().replace(/-/g, '');
  return (ALGORITHMS as readonly string[]).includes(upper) ? (upper as Algorithm) : 'SHA1';
}

/** 手工输入密钥时构造草稿，参数取 RFC 默认值 */
export function draftFromSecret(input: {
  issuer: string;
  label: string;
  secret: string;
}): AccountDraft {
  return {
    issuer: input.issuer,
    label: input.label,
    secret: normalizeSecret(input.secret),
    algorithm: DEFAULT_ALGORITHM,
    digits: DEFAULT_DIGITS,
    period: DEFAULT_PERIOD,
  };
}

/** 导出备份时用得上：把账号还原成 otpauth:// 链接 */
export function toOtpauthUri(account: Account): string {
  return new TOTP({
    issuer: account.issuer,
    label: account.label,
    secret: Secret.fromBase32(account.secret),
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.period,
  }).toString();
}
