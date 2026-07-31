/**
 * 加解密原语。
 *
 * M8 主密码加密的底层：PBKDF2 派生密钥 + AES-GCM 加解密 + enc1 序列
 * 化。设计上 **不带任何状态**：每次调用都接收 key 字节，业务层（lib/lock.ts）
 * 负责管理 key 的存储和生命周期。
 *
 * 选型理由：
 * - WebCrypto 是浏览器原生 API，无需依赖
 * - PBKDF2-SHA256 / 600_000 轮是 OWASP 当前推荐值（2023+）
 * - AES-GCM 提供 AEAD：篡改密文直接抛错，不用自己写 MAC 校验
 * - 12 字节 IV 是 GCM 标准；每次 encrypt 都随机生成，避免 IV 重用灾难
 * - 32 字节 salt：保证不同用户的派生路径不重合
 *
 * **跨平台 base64**：浏览器用 btoa/atob，Node（测试）用 Buffer。两者都
 * 处理无 padding 的输入（AES-GCM 密文不补 0，恰好对齐）。
 */

import { ENC_PREFIX } from './model.ts';

// ------------------------------------------------------------- base64

/**
 * Uint8Array → base64 字符串。无 padding（不补 '='），这样序列化后长度
 * 紧凑且不会让 Base32 校验函数误判。
 */
export function bytesToB64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

/** base64 字符串 → Uint8Array。无 padding 也接受 */
export function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ------------------------------------------------------------- 随机数

/** 加密学安全的随机字节。Node 24+ / 浏览器都有 WebCrypto 的 getRandomValues */
export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 16 字节随机 salt（PBKDF2 推荐长度）。返回 Uint8Array */
export function randomSalt(): Uint8Array {
  return randomBytes(16);
}

// ------------------------------------------------------------- KDF

/** OWASP 推荐的 PBKDF2 迭代次数（2023+） */
export const PBKDF2_ITER = 600_000;

/**
 * 从密码派生 32 字节的 AES-256 原始 key。
 *
 * 返回的是裸字节（Uint8Array），不是 CryptoKey —— 这样可以序列化到
 * `chrome.storage.session`（存 base64），跨 SW 重启存活。
 *
 * 注意：相同 (password, salt, iter) 总是派生相同的 key，这正是 verify
 * 密文能校验密码对错的依据。
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iter: number = PBKDF2_ITER,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password) as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      iterations: iter,
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

// ------------------------------------------------------------- AES-GCM

/**
 * 用 AES-GCM-256 加密任意字符串。
 *
 * 每次调用都生成新的 12 字节 IV。返回的 iv / ciphertext 都是 base64。
 * GCM 的 auth tag 自动附加在 ciphertext 末尾，decrypt 时也会校验
 * —— 任何篡改都会抛 OperationError。
 */
export async function encrypt(
  plaintext: string,
  key: Uint8Array,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    cryptoKey,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return {
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(new Uint8Array(ct)),
  };
}

/**
 * AES-GCM-256 解密。
 *
 * 任何错误（错 key / 篡改密文 / IV 长度不对）都抛 OperationError。
 * 调用方需要决定怎么处理（典型：上锁或返回 false）。
 */
export async function decrypt(
  iv: string,
  ciphertext: string,
  key: Uint8Array,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const ivBytes = b64ToBytes(iv);
  const ctBytes = b64ToBytes(ciphertext);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    cryptoKey,
    ctBytes as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

// ------------------------------------------------------------- enc1 序列化

/**
 * 把 (iv, ciphertext) 序列化成存储格式：`enc1:<iv-b64>:<ct-b64>`
 *
 * 冒号前缀（来自 model.ENC_PREFIX）是关键设计 —— Base32 字母表不含
 * 冒号，所以前缀跟明文密钥永远不会混淆。
 */
export function serializeEncrypted(iv: string, ciphertext: string): string {
  return `${ENC_PREFIX}${iv}:${ciphertext}`;
}

/** 解析 enc1:... 字符串，返回 { iv, ciphertext }；不是 enc1 格式返回 null */
export function parseEncrypted(s: string): { iv: string; ciphertext: string } | null {
  if (!s.startsWith(ENC_PREFIX)) return null;
  const rest = s.slice(ENC_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx < 0) return null;
  const iv = rest.slice(0, colonIdx);
  const ciphertext = rest.slice(colonIdx + 1);
  if (!iv || !ciphertext) return null;
  return { iv, ciphertext };
}

/** 快路径：是否加密过的 secret */
export function isEncryptedSecret(s: string): boolean {
  return s.startsWith(ENC_PREFIX);
}

// ------------------------------------------------------------- 验证常量

/**
 * 启用加密时写入 sync 的验证密文对应的明文。
 *
 * unlock() 拿这个常量 + derivedKey 解密 verify 密文，能解出本常量说
 * 明密码正确。这是「不需要服务器参与就能校验密码」的标准模式。
 */
export const VERIFIER_PLAINTEXT = 'xz-verify-v1';