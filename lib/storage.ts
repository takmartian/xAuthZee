import { browser } from 'wxt/browser';
import { createVault, type StorageArea } from './vault';

/**
 * 与浏览器绑定的仓库实例。
 *
 * 单独拆出这个文件，是为了让 lib/vault.ts 保持零浏览器依赖 —— 那边可以直接
 * 用 node --test 跑，不需要 mock 整个 extension API。
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
