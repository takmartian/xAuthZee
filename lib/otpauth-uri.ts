/**
 * 由账号生成 otpauth:// 链接。
 *
 * 这个链接是「二维码里装的东西」，也是其它验证器之间交换账号的标准格式。
 * 用 otpauth 库生成而不是手拼 —— issuer / label 的 URI 编码、参数顺序、
 * 算法名（SHA1/SHA256/SHA512）与 digits/period 的默认值都由它把关，
 * 手拼很容易在特殊字符（@ : / 中文）上翻车。
 *
 * 纯函数，不碰浏览器 API，可以直接 node --test 跑。
 */

import { Secret, TOTP } from 'otpauth';
import type { Account } from './model.ts';

/**
 * 生成 otpauth:// 链接。
 *
 * 返回 null 的两种情况：
 * - secret 为空（锁定态下 secret 被 strip 掉了）
 * - secret 不是合法 Base32（数据损坏，或用户手输时带了非法字符）
 *
 * 这两种情况都不该抛错 —— 调用方（二维码弹窗）只需要知道「生成不出来」，
 * 然后给用户一句人话提示，而不是让整个 popup 崩掉。
 */
export function buildOtpauthUri(account: Account): string | null {
  const raw = (account.secret ?? '').trim();
  if (!raw) return null;

  let secret: Secret;
  try {
    secret = Secret.fromBase32(raw);
  } catch {
    return null;
  }

  // issuer 为空时不能传空串给 otpauth —— 它会把 label 拼成 "':label'"。
  const issuer = account.issuer.trim();
  const label = (account.label || account.issuer).trim() || 'Account';

  try {
    return new TOTP({
      ...(issuer ? { issuer } : {}),
      label,
      secret,
      algorithm: account.algorithm,
      digits: account.digits,
      period: account.period,
    }).toString();
  } catch {
    return null;
  }
}
