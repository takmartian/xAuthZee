import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';

/**
 * M2 阶段：承载二维码截屏 → 解码的消息路由。
 *
 * 流程：
 *   popup 点「扫描二维码」
 *     → 发消息到 background（附 tabId）
 *       → 注入 qrselect.content（按需注入，不写进 manifest 的静态 content_scripts）
 *       → tabs.captureVisibleTab() 拿整屏 PNG
 *       → 把 dataURL 交给内容脚本解码（jsQR 需要 ImageData，
 *          内容脚本里 canvas 拿得到，background 里 OffscreenCanvas
 *          的兼容性未经确证，所以解码放内容脚本）
 *       → 把解码结果回给 popup
 *
 * 「popup 关闭后 captureVisibleTab 仍能成功」是这一阶段要验证的关键。
 * activeTab 权限在用户点扩展图标那一刻授予，captureVisibleTab 是这个
 * 权限下唯一允许的「事后」动作。
 *
 * tabId 必须由 popup 提供 —— popup 一打开就抢走焦点，宿主页窗口的
 * focused 立刻变成 false，background 反向 windows.getAll().find(focused)
 * 必然拿到 undefined。
 */

interface ScanRequest {
  type: 'm2-scan-qr';
  tabId: number;
}

interface ScanResponse {
  text: string | null;
  captureWidth?: number;
  captureHeight?: number;
  error?: string;
}

export default defineBackground(() => {
  // 注入文件路径相对于扩展根目录。WXT 把 runtime 注册的内容脚本构建为
  // content-scripts/<name>.js 单文件 IIFE，可以直接走 scripting.executeScript
  // 注入。executeScript 返回的 Promise 在脚本的同步部分执行完后 resolve，
  // 包括 main() 顶层的 onMessage 注册，所以紧接着 sendMessage 不会丢。
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const req = message as ScanRequest | undefined;
    if (req?.type !== 'm2-scan-qr') return;

    handleScan(req.tabId).then(sendResponse).catch((err: unknown) => {
      console.error('[XAuthZee] scan failed', err);
      sendResponse({ text: null, error: err instanceof Error ? err.message : String(err) });
    });

    // 返回 true 表示稍后异步 sendResponse，端口保持打开
    return true;
  });
});

async function handleScan(tabId: number): Promise<ScanResponse> {
  console.info('[XAuthZee] scan: injecting qrselect into tab', tabId);

  // 1) 按需注入框选遮罩。当前 M2 阶段它只注册解码监听器；
  //    真正的框选 UI 在 M5 里做。
  await browser.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ['/content-scripts/qrselect.js'],
  });

  // 2) 截屏。captureVisibleTab 必须有 activeTab 或 <all_urls>。
  //    用户点扩展图标这一刻 activeTab 已授予，所以这一步不需要
  //    <all_urls> 就能成功 —— 这正是用 activeTab 而非 <all_urls> 的好处。
  const dataUrl = await browser.tabs.captureVisibleTab(tabId, { format: 'png' });

  // 3) 拿到截屏尺寸。从 data URL 头里解析即可，不必真去解码。
  const { width: captureWidth, height: captureHeight } = parsePngDimensions(dataUrl);

  console.info('[XAuthZee] scan: captured', captureWidth, 'x', captureHeight);

  // 4) 把 dataURL 交给内容脚本解码。返回的 text 是 null（找不到 QR）或
  //    一个字符串（找到了，但还不一定是 otpauth://）。
  const { text, error } = await browser.tabs.sendMessage(tabId, {
    type: 'm2-decode-qr',
    dataUrl,
  });

  return { text: text ?? null, captureWidth, captureHeight, error };
}

/**
 * 从 PNG dataURL 的头 24 字节里直接解析宽高，避免把整张图解码出来。
 *
 * PNG 文件头（十六进制）：
 *   89 50 4E 47 0D 0A 1A 0A   签名
 *   00 00 00 0D               IHDR 长度
 *   49 48 44 52               "IHDR"
 *   WW WW WW WW               宽度（大端）
 *   HH HH HH HH               高度（大端）
 *
 * dataURL 是 "data:image/png;base64,..."，base64 解码后是二进制。
 */
function parsePngDimensions(dataUrl: string): { width: number; height: number } {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('malformed data URL');
  const bin = atob(dataUrl.slice(comma + 1));
  if (bin.length < 24) throw new Error('PNG too short');
  // PNG 头：8 字节签名 + 4 字节 IHDR 长度 + 4 字节 "IHDR" + 4 字节宽 + 4 字节高
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}