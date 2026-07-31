import { browser } from 'wxt/browser';
import { createVault, type StorageArea, type Vault } from './vault';

/**
 * 与浏览器绑定的仓库实例。
 *
 * 单独拆出这个文件，是为了让 lib/vault.ts 保持零浏览器依赖 —— 那边可以直接
 * 用 node --test 跑，不需要 mock 整个 extension API。
 *
 * **MV3 content script 限制**：chrome.storage.sync / session 在 content script
 * 上下文里是访问不了的（抛 "Access to storage is not allowed from this context"）。
 * content script 想读写账号库，必须通过 `chrome.runtime.sendMessage` 问
 * background。`createMessageSyncArea` / `createMessageVault` 就是这个代理。
 */

const syncArea: StorageArea = {
  get: (keys) => browser.storage.sync.get(keys ?? null),
  set: (items) => browser.storage.sync.set(items),
  remove: (keys) => browser.storage.sync.remove(keys),
  getBytesInUse: (keys) => browser.storage.sync.getBytesInUse(keys ?? null),
};

export const vault = createVault(syncArea);

/**
 * 监听数据变化。
 *
 * popup、设置页、内容脚本各自持有独立的 vault 实例，彼此看不到对方的写入；
 * 跨设备同步推下来的改动更是完全在扩展之外发生。统一靠 storage.onChanged
 * 通知界面重新读取，比在各处手工刷新可靠。
 */
export function watchVault(callback: () => void): () => void {
  const handler = (_changes: unknown, areaName: string) => {
    if (areaName === 'sync') callback();
  };
  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}

// ------------------------------------------------------------- content script 代理
//
// MV3 content script 不能直接碰 chrome.storage.sync。改用 sendMessage 问
// background；background 那边跑同一个 createVault 的实例（直接装的 syncArea），
// 真实读写由 background 完成。
//
// 协议见 entrypoints/background.ts 的 `xz-vault-proxy` 路由。

interface VaultProxyRequest {
  type: 'xz-vault-proxy';
  op: 'get' | 'set' | 'remove' | 'getBytesInUse';
  keys?: string | string[] | null;
  items?: Record<string, unknown>;
}

interface VaultProxyResponse {
  ok: true;
  data?: Record<string, unknown>;
  bytes?: number;
}
interface VaultProxyError {
  ok: false;
  error: string;
}

async function sendVaultProxy(req: Omit<VaultProxyRequest, 'type'>): Promise<Record<string, unknown> | number> {
  const res = (await browser.runtime.sendMessage({
    type: 'xz-vault-proxy',
    ...req,
  } as VaultProxyRequest)) as VaultProxyResponse | VaultProxyError | undefined;
  if (!res) throw new Error('vault proxy: no response');
  if (!res.ok) throw new Error(`vault proxy: ${res.error}`);
  if (req.op === 'getBytesInUse') return res.bytes ?? 0;
  return res.data ?? {};
}

/**
 * 给 content script 用的 sync area 替身。每个方法都问 background。
 */
export function createMessageSyncArea(): StorageArea {
  return {
    get: (keys) => sendVaultProxy({ op: 'get', keys: keys ?? null }) as Promise<Record<string, unknown>>,
    set: (items) => sendVaultProxy({ op: 'set', items }) as Promise<Record<string, unknown>>,
    remove: (keys) => sendVaultProxy({ op: 'remove', keys }) as Promise<Record<string, unknown>>,
    getBytesInUse: (keys) => sendVaultProxy({ op: 'getBytesInUse', keys: keys ?? null }) as Promise<number>,
  };
}

/**
 * content script 用的 vault 实例，所有读写都走消息代理。
 *
 * 注意：这不是 module-level 单例。因为 content script 共享同一个全局
 * 上下文，但代理本身无状态，所以即使每次 main() 重新创建一个也无所谓。
 * 返回的 vault 仍然能享受 debounce、quota 节流等逻辑。
 */
export function createMessageVault(): Vault {
  return createVault(createMessageSyncArea());
}

/**
 * content script 用的 watchVault 替身。background 那边 storage.onChanged
 * 触发后会向所有处于活动状态的 tab 广播（这是 MV3 的默认行为），所以
 * content 一侧也能监听。
 */
export function watchVaultViaMessage(callback: () => void): () => void {
  const handler = (_changes: unknown, areaName: string) => {
    if (areaName === 'sync') callback();
  };
  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}
