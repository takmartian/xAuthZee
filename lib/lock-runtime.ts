/**
 * 把 lock.ts 的 runtime 单例装上真实 browser API。
 *
 * popup / options / background 装的是**直连** runtime（直接调
 * browser.storage.sync / session）。
 * content script 装的是**消息代理** runtime —— 因为 MV3 content script
 * 不能访问 chrome.storage.sync / session，必须通过 chrome.runtime.sendMessage
 * 问 background。两者装出来的 runtime 共享同一份 storage，所以锁状态
 * 自动跨 surface 同步。
 *
 * 入口顺序：
 *   import 'wxt/browser';   // 全局注入
 *   import { installLockRuntime, getDerivedKey } from '@/lib/lock-runtime';
 *   installLockRuntime();   // popup / options / background
 *   // 或
 *   installContentLockRuntime();  // content script
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

// runtime 引用留在本模块，供 getDerivedKey 跨 surface 复用：popup 端
// 装的是直连 runtime（直接走 browser.storage.session），content 端装
// 的是消息代理 runtime（sendMessage 问 background）。两边都把
// 装好的对象 save 起来，getDerivedKey 通过它读 session。
let sessionReader: {
  get: (key: string) => Promise<Record<string, unknown>>;
} | null = null;

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
      clearAll: () => vault.clearAll(),
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

  sessionReader = runtime.session;
  setLockRuntime(runtime);
}

// ------------------------------------------------------------- content script 运行时

let contentInstalled = false;

/**
 * 给 content script 装的 lock runtime。所有 storage 操作都通过
 * `chrome.runtime.sendMessage` 问 background；background 那边跑
 * 同一个 setLockRuntime 装出来的直连 runtime。
 *
 * 背景路由见 entrypoints/background.ts 的 `xz-lock-proxy` 消息。
 *
 * **注意**：content script 装的 runtime 没有 vault.list / vault.update 实参
 * —— 它只是一个轻量代理。locked 态下 content 端不需要写 vault，浮层展示
 * 只需要 list / getPrefs / getDerivedKey 中转。
 */
export function installContentLockRuntime(): void {
  if (contentInstalled) return;
  contentInstalled = true;

  const runtime: LockRuntime = {
    sync: {
      async get(key) {
        return messageStorageProxy('sync', 'get', key);
      },
      async set(items) {
        await messageStorageProxy('sync', 'set', undefined, items);
      },
      async remove(key) {
        await messageStorageProxy('sync', 'remove', key);
      },
    },
    session: {
      async get(key) {
        return messageStorageProxy('session', 'get', key);
      },
      async set(items) {
        await messageStorageProxy('session', 'set', undefined, items);
      },
      async remove(key) {
        await messageStorageProxy('session', 'remove', key);
      },
    },
    vault: {
      // 走跟 sync 一样的消息代理，但 op 换成 vault.list 等
      list: () => messageVaultList(),
      update: async (id, patch) => {
        await messageVaultUpdate(id, patch);
      },
      // M10：wipeVaultAndReset 只在 popup / options / background 触发（它们都用
      // 直连 runtime）。content 端不会调用，但接口要满足 —— 给个 noop
      clearAll: async () => {},
      getPrefs: () => messageVaultGetPrefs(),
      setPrefs: async (patch) => {
        await messageVaultSetPrefs(patch);
      },
    },
    // content 不调度 alarm
    alarm: null,
    now: () => Date.now(),
    // content 端不直接监听 browser.storage.onChanged：MV3 content script
    // 访问 storage 命名空间会抛 "Access to storage is not allowed from this
    // context"。锁 / 账号库变化由 background 主动通过 tabs.sendMessage 广播
    // `xz-storage-changed` 通知，content 端用 runtime.onMessage 收。
    onChange(_cb) {
      return () => {};
    },
  };

  sessionReader = runtime.session;
  setLockRuntime(runtime);
}

// ---------- 消息代理 helpers ----------

interface LockProxyRequest {
  type: 'xz-lock-proxy';
  area: 'sync' | 'session';
  op: 'get' | 'set' | 'remove';
  key?: string;
  items?: Record<string, unknown>;
}

interface LockProxyOk {
  ok: true;
  data?: Record<string, unknown>;
}
interface LockProxyErr {
  ok: false;
  error: string;
}

async function messageStorageProxy(
  area: 'sync' | 'session',
  op: 'get' | 'set' | 'remove',
  key?: string,
  items?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await browser.runtime.sendMessage({
    type: 'xz-lock-proxy',
    area,
    op,
    key,
    items,
  } as LockProxyRequest)) as LockProxyOk | LockProxyErr | undefined;
  if (!res) throw new Error('lock proxy: no response');
  if (!res.ok) throw new Error(`lock proxy: ${res.error}`);
  return res.data ?? {};
}

interface VaultProxyRequest {
  type: 'xz-vault-proxy';
  op: 'list' | 'update' | 'getPrefs' | 'setPrefs';
  id?: string;
  patch?: Record<string, unknown>;
}

interface VaultProxyOk {
  ok: true;
  data?: Record<string, unknown> | number;
  accounts?: AccountLite[];
  prefs?: { lockMinutes: number };
}
interface VaultProxyErr {
  ok: false;
  error: string;
}

interface AccountLite {
  id: string;
  issuer: string;
  label: string;
  secret: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: number;
  period: number;
  domains: string[];
  createdAt: number;
}

async function messageVaultList(): Promise<AccountLite[]> {
  const res = (await browser.runtime.sendMessage({
    type: 'xz-vault-proxy',
    op: 'list',
  } as VaultProxyRequest)) as VaultProxyOk | VaultProxyErr | undefined;
  if (!res || !res.ok) throw new Error('vault proxy: list failed');
  return res.accounts ?? [];
}

async function messageVaultUpdate(id: string, patch: Record<string, unknown>): Promise<void> {
  const res = (await browser.runtime.sendMessage({
    type: 'xz-vault-proxy',
    op: 'update',
    id,
    patch,
  } as VaultProxyRequest)) as VaultProxyOk | VaultProxyErr | undefined;
  if (!res || !res.ok) throw new Error('vault proxy: update failed');
}

async function messageVaultGetPrefs(): Promise<{ lockMinutes: number }> {
  const res = (await browser.runtime.sendMessage({
    type: 'xz-vault-proxy',
    op: 'getPrefs',
  } as VaultProxyRequest)) as VaultProxyOk | VaultProxyErr | undefined;
  if (!res || !res.ok) throw new Error('vault proxy: getPrefs failed');
  return res.prefs ?? { lockMinutes: 15 };
}

async function messageVaultSetPrefs(patch: Record<string, unknown>): Promise<void> {
  const res = (await browser.runtime.sendMessage({
    type: 'xz-vault-proxy',
    op: 'setPrefs',
    patch,
  } as VaultProxyRequest)) as VaultProxyOk | VaultProxyErr | undefined;
  if (!res || !res.ok) throw new Error('vault proxy: setPrefs failed');
}

/**
 * 读 session 里的派生 key。locked 时返回 null。
 *
 * 调用方：popup 显示验证码、content 填入 OTP 之前、handleAddSave 加密
 * 新账号时都通过这里拿 key。
 *
 * **跨 surface 自适应**：通过本模块缓存的 `sessionReader` 读取 —— 它
 * 装的是直连 runtime 就走 browser.storage.session，装的是消息代理
 * runtime 就走 sendMessage。所以 popup / content 都能正常调用。
 */
export async function getDerivedKey(): Promise<Uint8Array | null> {
  if (!sessionReader) return null;
  const sess = await sessionReader.get('derivedKey');
  const k = sess.derivedKey;
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
