import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { vault } from '@/lib/storage';
import { setLockRuntime, checkAutoLock, lock } from '@/lib/lock';

/**
 * Service Worker 消息路由。
 *
 * 当前承担：
 *   1. popup 点「扫描二维码」 → 注入 qrselect.content（M5：选区 UI）
 *   2. content 框选完 → 截屏 → 把 dataURL + 尺寸回给 content
 *   3. content 解析完 → 入库 → 把结果回给 content
 *   4. 主密码自动锁的触发链路（M8）
 *
 * 把 vault 放在 background 而不是 content script，是因为 vault 内部
 * 用 chrome.storage.sync —— content script 也能用，但会让内容脚本
 * 多一个 import 路径；统一在 background 收口更清楚。
 */

// ------------------------------------------------------------ M8 自动锁触发

// chrome 类型 stub —— WXT build 期间用 fake-browser mock，运行时真
// chrome 一定有。alarms.onAlarm / idle.onStateChanged.addListener 在
// fake-browser 里抛 not implemented，所以包 try/catch 兜底。
interface ChromeWithLifecycle {
  alarms?: {
    create(name: string, info: { delayInMinutes: number }): Promise<void>;
    clear(name: string): Promise<void>;
    onAlarm?: {
      addListener(cb: (alarm: { name: string }) => void): unknown;
    };
  };
  idle?: {
    onStateChanged?: {
      addListener(cb: (state: 'locked' | 'idle' | 'active') => void): unknown;
    };
  };
}
const chromeGlobal = (globalThis as { chrome?: ChromeWithLifecycle }).chrome;

/** 给 lock.ts 装上 runtime —— 必须先装，后面的 checkAutoLock 才能跑 */
setLockRuntime({
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
  alarm: chromeGlobal?.alarms
    ? {
        async create(name, info) {
          await chromeGlobal.alarms!.create(name, info);
        },
        async clear(name) {
          await chromeGlobal.alarms!.clear(name);
        },
      }
    : null,
  now: () => Date.now(),
  onChange(cb) {
    const handler = async (
      _changes: unknown,
      area: string,
    ) => {
      // 只有 sec（sync）或 derivedKey（session）变化才跟锁状态有关
      if (area !== 'sync' && area !== 'session') return;
      const { getLockState } = await import('@/lib/lock');
      cb(await getLockState());
    };
    browser.storage.onChanged.addListener(handler);
    return () => browser.storage.onChanged.removeListener(handler);
  },
});

// SW 启动时立刻跑一次时间戳校验（覆盖「idle 15 分钟后 SW 才被回收」
// 这种 alarm 没机会触发的窗口）。如果触发了上锁，alarm 也会在 lock()
// 内部 clear 掉。
void checkAutoLock();

// 自动锁 alarm —— SW 还活着时按 lockMinutes 触发
try {
  chromeGlobal?.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm.name === 'xz-auto-lock') {
      void lock();
    }
  });
} catch {
  /* build-time fake-browser 不支持；运行时 chrome 一定有 */
}
// 系统锁屏 → 立即上锁
try {
  chromeGlobal?.idle?.onStateChanged?.addListener((state) => {
    if (state === 'locked') {
      void lock();
    }
  });
} catch {
  /* 同上 */
}

type AnyRequest =
  | { type: 'm2-scan-qr'; tabId: number; windowId: number }
  | {
      type: 'm2-qrselect-region';
      tabId: number;
      windowId: number;
      rect: { x: number; y: number; w: number; h: number };
    }
  | {
      type: 'm2-qrselect-save';
      draft: {
        issuer: string;
        label: string;
        secret: string;
        algorithm: 'SHA1' | 'SHA256' | 'SHA512';
        digits: number;
        period: number;
      };
    }
  // M8-j：content script 走消息代理读写 storage。
  | {
      type: 'xz-vault-proxy';
      op: 'get' | 'set' | 'remove' | 'getBytesInUse' | 'list' | 'update' | 'getPrefs' | 'setPrefs';
      keys?: string | string[] | null;
      items?: Record<string, unknown>;
      id?: string;
      patch?: Record<string, unknown>;
    }
  | {
      type: 'xz-lock-proxy';
      area: 'sync' | 'session';
      op: 'get' | 'set' | 'remove';
      key?: string;
      items?: Record<string, unknown>;
    };

interface SaveDraft {
  issuer: string;
  label: string;
  secret: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: number;
  period: number;
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const req = message as AnyRequest | undefined;
    if (!req) return;

    switch (req.type) {
      case 'm2-scan-qr':
        console.info('[XAuthZee] bg: inject request tabId=', req.tabId);
        handleInject(req.tabId).then((r) => {
          console.info('[XAuthZee] bg: inject ok');
          sendResponse(r);
        }).catch(reportError(sendResponse, 'inject'));
        return true;
      case 'm2-qrselect-region':
        // 不再信任请求里的 windowId —— content script 发请求时 sender.tab
        // 才是权威来源。sender.tab.id / sender.tab.windowId 在 popup 关闭
        // 之后依然有效，因为 onMessage 的 sender 是 Chrome 自己注入的。
        const winId = sender.tab?.windowId;
        const tabId = sender.tab?.id;
        console.info('[XAuthZee] bg: capture from sender tabId=', tabId, 'windowId=', winId);
        if (winId === undefined) {
          sendResponse({ ok: false, error: 'no sender window' });
          return false;
        }
        handleCapture(winId).then((r) => {
          console.info('[XAuthZee] bg: capture ok', r.captureWidth, 'x', r.captureHeight);
          sendResponse(r);
        }).catch(reportError(sendResponse, 'capture'));
        return true;
      case 'm2-qrselect-save':
        handleSave(req.draft).then(sendResponse).catch(reportError(sendResponse, 'save'));
        return true;
      // -------- M8-j：content script 走代理读写 sync / session
      case 'xz-vault-proxy':
        handleVaultProxy(req).then(sendResponse).catch(reportError(sendResponse, 'vault-proxy'));
        return true;
      case 'xz-lock-proxy':
        handleLockProxy(req).then(sendResponse).catch(reportError(sendResponse, 'lock-proxy'));
        return true;
    }
  });
});

function reportError(sendResponse: (r: unknown) => void, tag: string) {
  return (err: unknown) => {
    console.error(`[XAuthZee] bg: ${tag} error`, err);
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  };
}

/**
 * 把 content script 的 sync storage 读写接回真 storage。
 *
 * 调用方：lib/storage.ts 的 createMessageSyncArea / createMessageVault，
 * 还有 lib/lock-runtime.ts 的 installContentLockRuntime。
 */
async function handleVaultProxy(
  req: Extract<AnyRequest, { type: 'xz-vault-proxy' }>,
): Promise<unknown> {
  switch (req.op) {
    case 'get':
      return {
        ok: true as const,
        data: (await browser.storage.sync.get(req.keys ?? null)) as Record<string, unknown>,
      };
    case 'set':
      if (req.items) await browser.storage.sync.set(req.items);
      return { ok: true as const, data: {} };
    case 'remove':
      if (req.keys) await browser.storage.sync.remove(req.keys);
      return { ok: true as const, data: {} };
    case 'getBytesInUse':
      return {
        ok: true as const,
        bytes: await browser.storage.sync.getBytesInUse(req.keys ?? null),
      };
    case 'list':
      return { ok: true as const, accounts: await vault.list() };
    case 'update': {
      if (!req.id || !req.patch) throw new Error('vault-proxy update: missing id/patch');
      await vault.update(req.id, req.patch as Partial<Parameters<typeof vault.update>[1]>);
      return { ok: true as const };
    }
    case 'getPrefs':
      return { ok: true as const, prefs: await vault.getPrefs() };
    case 'setPrefs':
      if (req.patch) await vault.setPrefs(req.patch as Parameters<typeof vault.setPrefs>[0]);
      return { ok: true as const };
  }
}

/**
 * 把 content script 的 storage.sync / session 读 + sec 状态机读写接回真 storage。
 *
 * 直接转发到 background 自己的 storage（不走 lock.ts 状态机 —— 因为
 * 调用方已经是要读 sec / session.derivedKey，不是要触发状态转移）。
 */
async function handleLockProxy(
  req: Extract<AnyRequest, { type: 'xz-lock-proxy' }>,
): Promise<unknown> {
  const area = req.area === 'sync' ? browser.storage.sync : browser.storage.session;
  switch (req.op) {
    case 'get':
      return {
        ok: true as const,
        data: (await area.get(req.key)) as Record<string, unknown>,
      };
    case 'set':
      if (req.items) await area.set(req.items);
      return { ok: true as const, data: {} };
    case 'remove':
      if (req.key) await area.remove(req.key);
      return { ok: true as const, data: {} };
  }
}

/** 注入 qrselect.content —— 实际的选区 UI 由 content 脚本自己挂载 */
async function handleInject(tabId: number) {
  await browser.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ['/content-scripts/qrselect.js'],
  });
  return { ok: true };
}

/** 截屏 + 解析宽高 */
async function handleCapture(windowId: number) {
  const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  const { width, height } = parsePngDimensions(dataUrl);
  return { ok: true, dataUrl, captureWidth: width, captureHeight: height };
}

/** 入库 */
async function handleSave(draft: SaveDraft) {
  const account = await vault.add(draft);
  return { ok: true, accountId: account.id };
}

/**
 * 从 PNG dataURL 的头 24 字节里直接解析宽高，避免把整张图解码出来。
 */
function parsePngDimensions(dataUrl: string): { width: number; height: number } {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('malformed data URL');
  const bin = atob(dataUrl.slice(comma + 1));
  if (bin.length < 24) throw new Error('PNG too short');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}