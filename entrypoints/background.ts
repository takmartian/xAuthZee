import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { vault } from '@/lib/storage';

/**
 * Service Worker 消息路由。
 *
 * 当前承担：
 *   1. popup 点「扫描二维码」 → 注入 qrselect.content（M5：选区 UI）
 *   2. content 框选完 → 截屏 → 把 dataURL + 尺寸回给 content
 *   3. content 解析完 → 入库 → 把结果回给 content
 *
 * 把 vault 放在 background 而不是 content script，是因为 vault 内部
 * 用 chrome.storage.sync —— content script 也能用，但会让内容脚本
 * 多一个 import 路径；统一在 background 收口更清楚。
 */

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
    }
  });
});

function reportError(sendResponse: (r: unknown) => void, tag: string) {
  return (err: unknown) => {
    console.error(`[XAuthZee] bg: ${tag} error`, err);
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  };
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