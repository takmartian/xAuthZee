/**
 * Account.secret 加解密的业务封装。
 *
 * 把 lib/crypto.ts 的低层操作转成「给一组 Account 加解密」的批量函数。
 * 调用方约定：
 *
 *   - **写入前**（add / update / QR 导入）：如果当前是 unlocked，用
 *     migrateAccounts 把明文 secret 改成 enc1:... 再写 vault。
 *   - **读出后**（list 后要用 secret 算 TOTP）：如果 unlocked 且 secret
 *     是 enc1:，用 revealAccounts 解密成明文再传给 totp.ts。
 *   - **locked 态**：用 stripSecrets 清掉 secret，原有的
 *     `if (!a.secret) continue` 就会自动过滤掉这些账号，UI 显示为空。
 *
 * 三个函数（migrate / reveal / strip）都是纯函数 + async（migrate /
 * reveal 内部用 crypto.subtle）。
 */

import type { Account } from './model.ts';
import { encrypt, decrypt, isEncryptedSecret } from './crypto.ts';

/** 单个 secret：明文 → enc1:...（已加密则保持） */
export async function migrateSecret(
  plain: string,
  key: Uint8Array,
): Promise<string> {
  if (isEncryptedSecret(plain)) return plain;
  const { iv, ciphertext } = await encrypt(plain, key);
  return `enc1:${iv}:${ciphertext}`;
}

/** 单个 secret：enc1:... → 明文（已是明文则保持；key=null 时加密的 secret 会抛错） */
export async function revealSecret(
  secret: string,
  key: Uint8Array | null,
): Promise<string> {
  if (!isEncryptedSecret(secret)) return secret;
  if (!key) throw new Error('cannot reveal encrypted secret without key');
  const colonIdx = secret.indexOf(':', 5); // 跳过 'enc1:'
  if (colonIdx < 0) throw new Error('malformed encrypted secret');
  const iv = secret.slice(5, colonIdx);
  const ciphertext = secret.slice(colonIdx + 1);
  return decrypt(iv, ciphertext, key);
}

/** 同步版判断；不依赖锁状态，只看字符串前缀 */
export { isEncryptedSecret };

/**
 * 批量迁移：把一组账号里的明文 secret 全部加密。已加密的保持。
 *
 * 用在「启用加密」时的存量数据迁移。
 */
export async function migrateAccounts(
  accounts: readonly Account[],
  key: Uint8Array,
): Promise<Account[]> {
  return Promise.all(
    accounts.map(async (a) => ({
      ...a,
      secret: await migrateSecret(a.secret, key),
    })),
  );
}

/**
 * 批量解密：把一组账号里的 enc1:... secret 还原成明文。已是明文的保持。
 *
 * 用在 unlocked 态下读 vault 后、传给 totp 之前。key 为 null 时所有
 * 加密 secret 会抛错（罕见路径：locked 态不应走到这里）。
 */
export async function revealAccounts(
  accounts: readonly Account[],
  key: Uint8Array | null,
): Promise<Account[]> {
  return Promise.all(
    accounts.map(async (a) => ({
      ...a,
      secret: await revealSecret(a.secret, key),
    })),
  );
}

/**
 * 清掉所有 secret（返回新数组，不修改入参）。
 *
 * 用在 locked 态：UI 不能显示验证码，但列表行还在（让用户看到「这个
 * 账号存在，已锁定」而不是凭空消失）。`otpfill.content` 的
 * `if (!a.secret) continue` 会自然把这些账号从浮层候选里过滤掉。
 */
export function stripSecrets(accounts: readonly Account[]): Account[] {
  return accounts.map((a) => ({ ...a, secret: '' }));
}