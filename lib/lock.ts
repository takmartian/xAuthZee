/**
 * M8 主密码锁状态机。
 *
 * 三态：`plaintext`（未启用加密）/ `locked`（已启用但当前未解锁）/
 * `unlocked`（已启用且 session 里挂着派生 key）。
 *
 * **持久化布局**：
 * - `storage.sync` 上的 `sec` 记录：salt + verifier 密文 + KDF 参数
 * - `storage.session` 上的 `derivedKey`（base64 字节）+ `unlockedAt`（ms）
 *   session 跨 SW 重启存活、关浏览器即失 —— 这是 SW 被回收后还能免
 *   输密码继续用的关键
 *
 * **运行时不直接 import browser**：所有副作用都通过 LockRuntime 接口
 * 注入。生产代码在 popup / options / background 启动时调一次
 * `setLockRuntime(...)` 装上真实 browser API；测试时构造 fake runtime。
 * 这样 lock.ts 本身可在 node --test 直接跑。
 *
 * **自动锁三重触发**：
 * 1. `chrome.alarms('xz-auto-lock')` —— SW 还活着时定时触发
 * 2. `checkAutoLock()` —— 任何 surface 启动 / 重开时校验 `unlockedAt`
 * 3. `chrome.idle.onStateChanged === 'locked'` —— 系统锁屏立即锁
 *
 * **迁移自愈**：`setupEncryption` 第 3 步先写 sec 记录，第 4 步才迁
 * 移账号 secret。如果第 3 步后 SW 被回收，下次启动会检测到「有 sec
 * 但 session 无 key」即 locked 态；用户 unlock 时会补走第 4 步（解
 * 锁时也调一遍迁移，确保已加密的不重复处理）。
 */

import type { Account, SecRecord } from './model.ts';
import {
  PBKDF2_ITER,
  VERIFIER_PLAINTEXT,
  b64ToBytes,
  bytesToB64,
  decrypt,
  deriveKey,
  encrypt,
  randomSalt,
  serializeEncrypted,
} from './crypto.ts';
import { isEncryptedSecret, migrateAccounts, revealSecret } from './secrets.ts';

// ------------------------------------------------------------- 类型

export type LockState = 'plaintext' | 'locked' | 'unlocked';

/** storage.sync 的最小子集 */
export interface SyncStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** storage.session 的最小子集 */
export interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** vault 的最小子集 —— 只用到 list / update / 偏好读写 */
export interface VaultLike {
  list(): Promise<Account[]>;
  update(id: string, patch: Partial<Account>): Promise<void>;
  getPrefs(): Promise<{ lockMinutes: number }>;
  setPrefs(patch: { lockMinutes?: number }): Promise<void>;
}

/** chrome.alarms 替身 —— null 表示不可用（测试 / 不需要自动锁） */
export interface AlarmLike {
  create(name: string, info: { delayInMinutes: number }): Promise<void>;
  clear(name: string): Promise<void>;
}

/**
 * 生产代码装上真实 browser API 后注入。`onChange` 在 sync.sec 或
 * session.derivedKey 变化时触发，让 popup / content 重新读 lock state。
 */
export interface LockRuntime {
  sync: SyncStorage;
  session: SessionStorage;
  vault: VaultLike;
  alarm: AlarmLike | null;
  now(): number;
  onChange(cb: (state: LockState) => void): () => void;
}

// ------------------------------------------------------------- runtime 单例

let runtime: LockRuntime | null = null;

/** 装上 runtime。返回卸载函数；多次调用取最后一次。 */
export function setLockRuntime(r: LockRuntime): () => void {
  runtime = r;
  return () => {
    if (runtime === r) runtime = null;
  };
}

function rt(): LockRuntime {
  if (!runtime) throw new Error('lock runtime not configured — call setLockRuntime first');
  return runtime;
}

/** 测试 / 调试用：当前 runtime 是否已配置 */
export function hasLockRuntime(): boolean {
  return runtime !== null;
}

// ------------------------------------------------------------- key 常量

const SEC_KEY = 'sec';
const SESSION_DERIVED_KEY = 'derivedKey';
const SESSION_UNLOCKED_AT = 'unlockedAt';
const ALARM_NAME = 'xz-auto-lock';

// ------------------------------------------------------------- 公开 API

/**
 * 当前锁状态。
 *
 * - `plaintext`：未启用加密，secret 都是明文 —— 这是默认状态
 * - `locked`：已启用加密，但 session 里没有派生 key —— UI 应进解锁闸门
 * - `unlocked`：已启用加密，session 里有 key —— 可正常用 secret
 */
export async function getLockState(): Promise<LockState> {
  const r = rt();
  const secRec = await r.sync.get(SEC_KEY);
  if (!secRec[SEC_KEY]) return 'plaintext';
  const sess = await r.session.get(SESSION_DERIVED_KEY);
  return sess[SESSION_DERIVED_KEY] ? 'unlocked' : 'locked';
}

/**
 * 启用主密码加密。
 *
 * 顺序（**关浏览器中途能自愈的关键**）：
 *   1. 生成 salt，派生 key
 *   2. 加密 verifier
 *   3. 写 sec 记录到 sync    ← 这一步之后即使 SW 死，下次启动也能检测到「正在迁移」
 *   4. 迁移所有明文 secret 为 enc1:...
 *   5. 写 session.derivedKey + unlockedAt
 *   6. 调度 alarm
 *
 * 如果调用前已是 locked / unlocked，抛错。
 */
export async function setupEncryption(password: string): Promise<void> {
  const r = rt();
  const cur = await getLockState();
  if (cur !== 'plaintext') throw new Error('encryption already enabled');

  const salt = randomSalt();
  const key = await deriveKey(password, salt, PBKDF2_ITER);
  const { iv: verifyIv, ciphertext: verifyCiphertext } = await encrypt(
    VERIFIER_PLAINTEXT,
    key,
  );

  const sec: SecRecord = {
    kdf: 'PBKDF2-SHA256',
    iter: PBKDF2_ITER,
    salt: bytesToB64(salt),
    verifyIv,
    verifyCiphertext,
  };
  // 第 3 步先写 sec —— 中途死了下次启动能检测到
  await r.sync.set({ [SEC_KEY]: sec });

  // 第 4 步迁移（幂等：migrateSecret 对 enc1: 不动）
  const accounts = await r.vault.list();
  const migrated = await migrateAccounts(accounts, key);
  for (const acc of migrated) {
    const original = accounts.find((a) => a.id === acc.id);
    if (original && original.secret !== acc.secret) {
      await r.vault.update(acc.id, { secret: acc.secret });
    }
  }

  // 第 5 步 + 第 6 步
  await writeSessionKey(key);
  await scheduleAutoLockAlarm();
}

/**
 * 用密码解锁。返回 true 表示成功，false 表示密码错（或 sec 不存在）。
 *
 * 失败时不抛错 —— UI 可以直接显示「密码错误」无需 try/catch。
 * 成功后会调 scheduleAutoLockAlarm 重置定时器。
 */
export async function unlock(password: string): Promise<boolean> {
  const r = rt();
  const secBag = await r.sync.get(SEC_KEY);
  const sec = secBag[SEC_KEY] as SecRecord | undefined;
  if (!sec) return false;

  const salt = b64ToBytes(sec.salt);
  const key = await deriveKey(password, salt, sec.iter);

  let decrypted: string;
  try {
    decrypted = await decrypt(sec.verifyIv, sec.verifyCiphertext, key);
  } catch {
    return false; // 错 key / 篡改密文都抛 OperationError
  }
  if (decrypted !== VERIFIER_PLAINTEXT) return false;

  await writeSessionKey(key);
  await scheduleAutoLockAlarm();
  return true;
}

/**
 * 立即上锁。清掉 session key + 自动锁 alarm。
 *
 * 被 chrome.alarms / chrome.idle / 手动「立即锁定」按钮调用。
 */
export async function lock(): Promise<void> {
  const r = rt();
  await r.session.remove(SESSION_DERIVED_KEY);
  await r.session.remove(SESSION_UNLOCKED_AT);
  if (r.alarm) await r.alarm.clear(ALARM_NAME);
}

/**
 * 自动锁检查。任何 surface 启动时调一次：
 * - 如果当前 unlocked 但 `unlockedAt + lockMinutes <= now`，上锁
 * - lockMinutes === 0 表示不超时，跳过
 *
 * 返回是否触发了上锁。
 */
export async function checkAutoLock(): Promise<boolean> {
  const r = rt();
  const state = await getLockState();
  if (state !== 'unlocked') return false;

  const sess = await r.session.get(SESSION_UNLOCKED_AT);
  const unlockedAt = sess[SESSION_UNLOCKED_AT] as number | undefined;
  if (!unlockedAt) return false;

  const prefs = await r.vault.getPrefs();
  const minutes = prefs.lockMinutes;
  if (minutes === 0) return false;

  const elapsedMin = (r.now() - unlockedAt) / 60_000;
  if (elapsedMin >= minutes) {
    await lock();
    return true;
  }
  return false;
}

/**
 * 修改密码。失败（密码错）返回 false。
 *
 * 流程：unlock(oldPw) 拿到 old key → 派生 new key → 用 new key 重加密
 * verifier 和所有 secret → 写新 sec 记录 → 更新 session key。
 */
export async function changePassword(oldPw: string, newPw: string): Promise<boolean> {
  const r = rt();
  const ok = await unlock(oldPw);
  if (!ok) return false;

  const sess = await r.session.get(SESSION_DERIVED_KEY);
  const oldKey = b64ToBytes(sess[SESSION_DERIVED_KEY] as string);

  const newSalt = randomSalt();
  const newKey = await deriveKey(newPw, newSalt, PBKDF2_ITER);
  const { iv: verifyIv, ciphertext: verifyCiphertext } = await encrypt(
    VERIFIER_PLAINTEXT,
    newKey,
  );
  const sec: SecRecord = {
    kdf: 'PBKDF2-SHA256',
    iter: PBKDF2_ITER,
    salt: bytesToB64(newSalt),
    verifyIv,
    verifyCiphertext,
  };
  await r.sync.set({ [SEC_KEY]: sec });

  // 用 new key 重新加密所有 secret：先 old key 解密，再 new key 加密
  const accounts = await r.vault.list();
  for (const acc of accounts) {
    if (!isEncryptedSecret(acc.secret)) continue;
    const plain = await revealSecret(acc.secret, oldKey);
    const { iv, ciphertext } = await encrypt(plain, newKey);
    await r.vault.update(acc.id, { secret: serializeEncrypted(iv, ciphertext) });
  }

  await writeSessionKey(newKey);
  await scheduleAutoLockAlarm();
  return true;
}

/**
 * 关闭加密。验证密码后解密所有 secret，再删 sec 记录和 session key。
 * 失败（密码错）返回 false。
 */
export async function disableEncryption(password: string): Promise<boolean> {
  const r = rt();
  const ok = await unlock(password);
  if (!ok) return false;

  const sess = await r.session.get(SESSION_DERIVED_KEY);
  const key = b64ToBytes(sess[SESSION_DERIVED_KEY] as string);

  // 解密所有 secret 回写 vault
  const accounts = await r.vault.list();
  for (const acc of accounts) {
    if (!isEncryptedSecret(acc.secret)) continue;
    const plain = await revealSecret(acc.secret, key);
    await r.vault.update(acc.id, { secret: plain });
  }

  await r.sync.remove(SEC_KEY);
  await r.session.remove(SESSION_DERIVED_KEY);
  await r.session.remove(SESSION_UNLOCKED_AT);
  if (r.alarm) await r.alarm.clear(ALARM_NAME);
  return true;
}

/**
 * 监听锁状态变化。返回卸载函数。
 *
 * 实际触发时机：sync.sec 创建 / 删除，或 session.derivedKey 写入 / 删除。
 */
export function onLockChange(cb: (state: LockState) => void): () => void {
  return rt().onChange(cb);
}

// ------------------------------------------------------------- 私有

async function writeSessionKey(key: Uint8Array): Promise<void> {
  const r = rt();
  await r.session.set({
    [SESSION_DERIVED_KEY]: bytesToB64(key),
    [SESSION_UNLOCKED_AT]: r.now(),
  });
}

async function scheduleAutoLockAlarm(): Promise<void> {
  const r = rt();
  if (!r.alarm) return;
  const prefs = await r.vault.getPrefs();
  const minutes = prefs.lockMinutes;
  if (minutes === 0) return;
  await r.alarm.clear(ALARM_NAME);
  await r.alarm.create(ALARM_NAME, { delayInMinutes: minutes });
}