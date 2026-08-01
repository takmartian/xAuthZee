/**
 * M8 主密码锁状态机。M10 加上 5 次错误自动 wipe。
 *
 * 三态：`plaintext`（未启用加密）/ `locked`（已启用但当前未解锁）/
 * `unlocked`（已启用且 session 里挂着派生 key）。
 *
 * **持久化布局**：
 * - `storage.sync` 上的 `sec` 记录：salt + verifier 密文 + KDF 参数 +
 *   M10 计数器（attempts / lastAttemptAt）
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
 * **M10 暴力破解防护**：unlock 失败时 sec.attempts+1、lastAttemptAt=now；
 * 60 分钟内没有再失败，attempts 视作归零（下次失败时按 1 重新累加）。
 * 达到 MAX_ATTEMPTS=5 触发 wipeVaultAndReset：清空所有账号 + index +
 * sec + session，lockState 回到 plaintext。**prefs 保留** —— 用户重置
 * 后大概率会重新启用加密，保留 lockMinutes 让预选更顺手。
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

/** 锁状态 + UI 用的「还没拿到状态」标记 */
export type LockUiState = LockState | 'loading';

/**
 * M10：密码错误自动 wipe 阈值。
 *
 * 密码管理器的事实标准是 5-10 次 + 5-60 分钟重置窗口。这里选 5 次 + 60 分钟：
 * - 5 次足够挡住低强度密码的暴力穷举（PBKDF2 100k 迭代 + 5 次 ≈ 1 秒窗口）
 * - 60 分钟窗口对误触友好，但攻击者每分钟只能重试 1 次
 */
export const MAX_ATTEMPTS = 5;
export const RESET_WINDOW_MS = 60 * 60 * 1000;

/** unlock() 的返回值。wiped=true 时 attemptsLeft/resetAt 无意义 */
export interface UnlockResult {
  ok: boolean;
  /** 密码错误达到阈值，vault 已被自动清空 —— UI 应切回 plaintext */
  wiped?: boolean;
  /** 密码错误后还剩几次机会（wiped=false 时才有意义） */
  attemptsLeft?: number;
  /** 窗口何时归零（ms 时间戳）。attemptsLeft>0 时有意义 */
  resetAt?: number;
}

/** getAttempts() 的返回值。attempts=0 时 resetAt 不返回 */
export interface AttemptsInfo {
  attempts: number;
  resetAt?: number;
}

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

/** vault 的最小子集 —— list / update / clearAll / 偏好读写 */
export interface VaultLike {
  list(): Promise<Account[]>;
  update(id: string, patch: Partial<Account>): Promise<void>;
  /** 清空所有账号 + index，prefs 保留。给 5 次错误 wipe 用 */
  clearAll(): Promise<void>;
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
 * 用密码解锁。返回 `UnlockResult`：
 *
 * - `ok: true`：解锁成功。session 里挂上了派生 key，可以读 secret
 * - `wiped: true`：密码错且达到 5 次阈值，vault 已被自动清空。lockState
 *   回到 plaintext。UI 应切回主界面（此时是空的）
 * - 否则 `ok: false, wiped: false`：密码错但还有机会。`attemptsLeft` 告诉
 *   UI 还有几次，`resetAt` 是窗口何时归零（毫秒时间戳）
 *
 * **不抛错**：失败场景都收在返回值里，UI 不需要 try/catch。
 * **竞态**：如果进来时 sec 已被另一 surface 删了（wipe 完成），直接返回
 * `wiped: true`，让 UI 切回 plaintext 即可。
 */
export async function unlock(password: string): Promise<UnlockResult> {
  const r = rt();
  const secBag = await r.sync.get(SEC_KEY);
  const sec = secBag[SEC_KEY] as SecRecord | undefined;
  // sec 已被另一 surface 删掉 —— 当作 wiped 处理，让 UI 切回 plaintext
  if (!sec) return { ok: false, wiped: true };

  const salt = b64ToBytes(sec.salt);
  const key = await deriveKey(password, salt, sec.iter);

  let decrypted: string;
  let ok: boolean;
  try {
    decrypted = await decrypt(sec.verifyIv, sec.verifyCiphertext, key);
    ok = decrypted === VERIFIER_PLAINTEXT;
  } catch {
    ok = false; // 错 key / 篡改密文都抛 OperationError
  }

  if (ok) {
    // 成功：attempts 清零写回（如果非零），然后正常解锁
    if (sec.attempts || sec.lastAttemptAt) {
      await r.sync.set({
        [SEC_KEY]: { ...sec, attempts: 0, lastAttemptAt: 0 },
      });
    }
    await writeSessionKey(key);
    await scheduleAutoLockAlarm();
    return { ok: true };
  }

  // 失败：先看窗口是否已过期，过期则在内存里把 attempts 视作 0
  // （不主动写回 sec —— read-with-write 竞争，下一次 unlock 失败时会写）
  const now = r.now();
  const windowExpired =
    sec.lastAttemptAt !== undefined && now > sec.lastAttemptAt + RESET_WINDOW_MS;
  const baseAttempts = windowExpired ? 0 : sec.attempts ?? 0;
  const newAttempts = baseAttempts + 1;
  const newSec: SecRecord = { ...sec, attempts: newAttempts, lastAttemptAt: now };

  // 写失败也得继续走 wipe —— 不能因为 sync 写挂了就放过攻击者
  try {
    await r.sync.set({ [SEC_KEY]: newSec });
  } catch {
    /* fall through */
  }

  if (newAttempts >= MAX_ATTEMPTS) {
    await wipeVaultAndReset();
    return { ok: false, wiped: true };
  }

  return {
    ok: false,
    wiped: false,
    attemptsLeft: MAX_ATTEMPTS - newAttempts,
    resetAt: now + RESET_WINDOW_MS,
  };
}

/**
 * 读当前错误次数。**纯读**，不写回 sec（避免 read-with-write 竞争）。
 *
 * 60 分钟窗口判定完全在内存里完成，下一次 unlock 失败时才把归零后的值
 * 写回 sec。`unlock` 路径上会主动判断 `lastAttemptAt + RESET_WINDOW_MS`
 * 是否过期并按需重置 attempts，所以这里懒归零不会让计数器卡住。
 */
export async function getAttempts(): Promise<AttemptsInfo> {
  const r = rt();
  const secBag = await r.sync.get(SEC_KEY);
  const sec = secBag[SEC_KEY] as SecRecord | undefined;
  if (!sec) return { attempts: 0 };

  const baseAttempts = sec.attempts ?? 0;
  const lastAt = sec.lastAttemptAt;
  if (lastAt !== undefined && r.now() > lastAt + RESET_WINDOW_MS) {
    return { attempts: 0 };
  }
  if (baseAttempts === 0) return { attempts: 0 };
  return {
    attempts: baseAttempts,
    resetAt: lastAt !== undefined ? lastAt + RESET_WINDOW_MS : undefined,
  };
}

/**
 * 全量 wipe：清空所有账号 + index + sec + session key + 取消 alarm。
 *
 * 复用 `lock()` 处理 session + alarm，避免重复实现漂移。vault.clearAll 走
 * stage 通道，需要等 flush 完成才能确保数据落盘，所以这里 await clearAll
 * 后再 remove sec —— 顺序保证「先有 wipe 后有 sec 删除」的因果。
 *
 * **prefs 保留**：lockMinutes 等下次 setupEncryption 时按原值预选。
 */
export async function wipeVaultAndReset(): Promise<void> {
  const r = rt();
  // 先清 session + alarm（快速路径，让 lockState 立即变 plaintext）
  await lock();
  // 然后清 vault —— 必须落盘，否则 unlock 返回 wiped:true 后 UI 切到 plaintext
  // 时还会看到残留账号
  await r.vault.clearAll();
  // 最后删 sec 记录
  await r.sync.remove(SEC_KEY);
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
  const result = await unlock(oldPw);
  // wiped=true 时旧密码对应的 secret 已经清空，肯定改不了 —— 视为失败
  if (!result.ok) return false;

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
  const result = await unlock(password);
  // wiped=true 时旧密码对应的 secret 已清空，无法 disable —— 视为失败
  if (!result.ok) return false;

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