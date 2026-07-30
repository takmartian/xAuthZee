import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { decodeImageData } from '@/lib/qr/decode';

/**
 * 二维码框选遮罩（M2 阶段：仅做解码，不做 UI 选区）。
 *
 * registration: 'runtime' —— 不写进 manifest 的静态 content_scripts，
 * 而是用户点「扫描二维码」时由 background 通过 scripting.executeScript
 * 按需注入。这样这段代码只在 activeTab 授权下、且只在用户主动发起时
 * 才会进入页面，安装时也不会因此多出权限警告。
 *
 * 真正的框选 UI（M5）会在这里挂上 drag-to-select 遮罩、把选区回传给
 * background，再由 background 截屏后回到这里裁剪 + 解码。
 */

interface DecodeRequest {
  type: 'm2-decode-qr';
  dataUrl: string;
}

export default defineContentScript({
  registration: 'runtime',
  matches: [],

  main() {
    console.info('[XAuthZee] qrselect injected');

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const req = message as DecodeRequest | undefined;
      if (req?.type !== 'm2-decode-qr') return;

      decodeDataUrl(req.dataUrl)
        .then((text) => sendResponse({ text }))
        .catch((err: unknown) => {
          console.error('[XAuthZee] decode failed', err);
          sendResponse({
            text: null,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    });
  },
});

/**
 * 把 dataURL → ImageData → jsQR。
 *
 * 不复用 decodeImageData 之外的 canvas 工具类，因为这只是个一次性
 * helper，没必要抽出来。性能上 decodeImageData 是热点（M5 里会
 * 频繁触发），但 dataURL → ImageData 只在每次扫描走一次，可以内联。
 */
async function decodeDataUrl(dataUrl: string): Promise<string | null> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('cannot get 2d context');
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  bitmap.close();
  return decodeImageData({
    data: imageData.data,
    width: imageData.width,
    height: imageData.height,
  });
}