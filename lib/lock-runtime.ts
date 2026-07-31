/**
 * 把 lock.ts 的 runtime 单例装上真实 browser API。
 *
 * popup / options / content script 都各自装一份（运行时互不共享），
 * 它们装出来的 runtime 共享同一份 `browser.storage.sync` / `session`，
 * 所以锁状态自动跨 surface 同步。
 *
 * 入口顺序：
 *   import 'wxt/browser';   // 全局注入
 *   import { installLockRuntime, getDerivedKey } from '@/lib/lock-runtime';
 *   installLockRuntime();
 *
 * **Alarm 仅 background 装**：popup / options / content 不调度自动锁
 * alarm，但能读到 session.derivedKey 解密 secret。
 */

import { browser } from 'wxt/browser';
import {
  setLockRuntime,
  getLockState,
  checkAutoLock,
  type LockRuntime,
  type LockState,
} from './lock.ts';
import { b64ToBytes } from './crypto.ts';
import { vault } from './storage.ts';

let installed = false;

export function installLockRuntime(): void {
  if (installed) return;
  installed = true;

  const runtime: LockRuntime = {
    sync: {
      async get(key) {
        return (await browser.storage.sync.get(key)) as Record<string, unknown>;
      },
      async set(items) {
        await browser.storage.sync.set(items);
      },
      async remove(key) {
        await browser.storage.sync.remove(key);
      },
    },
    session: {
      async get(key) {
        return (await browser.storage.session.get(key)) as Record<string, unknown>;
      },
      async set(items) {
        await browser.storage.session.set(items);
      },
      async remove(key) {
        await browser.storage.session.remove(key);
      },
    },
    vault: {
      list: () => vault.list(),
      update: (id, patch) => vault.update(id, patch),
      getPrefs: () => vault.getPrefs(),
      setPrefs: (patch) => vault.setPrefs(patch),
    },
    // popup / options / content 不持有 alarm —— 自动锁只在 background 调度
    alarm: null,
    now: () => Date.now(),
    onChange(cb) {
      const handler = async (_changes: unknown, area: string) => {
        if (area !== 'sync' && area !== 'session') return;
        cb(await getLockState());
      };
      browser.storage.onChanged.addListener(handler);
      return () => browser.storage.onChanged.removeListener(handler);
    },
  };

  setLockRuntime(runtime);
}

/**
 * 读 session 里的派生 key。locked 时返回 null。
 *
 * 调用方：popup 显示验证码、content 填入 OTP 之前、handleAddSave 加密
 * 新账号时都通过这里拿 key。
 */
export async function getDerivedKey(): Promise<Uint8Array | null> {
  const session = await browser.storage.session.get('derivedKey');
  const k = session.derivedKey;
  if (typeof k !== 'string') return null;
  return b64ToBytes(k);
}

/**
 * 读 session.derivedKey + 解出 Uint8Array key。
 *
 * 跟 getDerivedKey 一样，但多一步：locked 时返回 null 让调用方
 * 决定怎么处理（一般是返回明文空 secret 或抛错）。
 */
export async function getLockStateForUI(): Promise<LockState> {
  return getLockState();
}

/**
 * SW / popup 启动时跑一次，覆盖「idle 后 SW 才被回收」的窗口。
 *
 * 返回是否触发了上锁。
 */
export async function autoLockIfOverdue(): Promise<boolean> {
  return checkAutoLock();
}