import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { decodeImageData } from '@/lib/qr/decode';
import { selectionToCaptureRect, clampRectToImage } from '@/lib/qr/scale';
import { prepareSelection, type SelectionError } from '@/lib/qr/select';
import { parseOtpauthUri, OtpUriError, type ParseErrorCode } from '@/lib/totp';
import { mountOverlay, type OverlayHandle, type SelectionResult } from './Overlay';
// Vite 的 ?inline 把 CSS 文件作为字符串打进 bundle，避免运行时再去
// fetch web_accessible 资源（runtime.getURL 不允许拿 CSS 路径）。
import overlayCss from './overlay.css?inline';

/**
 * 二维码框选遮罩（M5：完整产品化）。
 *
 * 流程：
 *   1. background 注入本脚本（每次扫描都重新注入 —— runtime 注册
 *      的脚本，WXT 会自动让旧实例 abort）
 *   2. 挂上浮层，监听用户拖拽
 *   3. 拖拽结束 → 让 background 截屏
 *   4. background 把 dataURL 发回来 → 我们按选区裁剪 + jsQR 解码
 *   5. 成功：弹确认卡片，用户点添加 → 入库
 *      失败：弹错误卡片，可重试或取消
 *   6. 任意一步 Esc 都退出整个流程
 *
 * 真实使用场景下 jsQR 在 50ms 内完成，加 PNG 解码 + canvas 绘制通常
 * 总开销 < 200ms，可以接受。如果以后要支持超慢设备，再考虑加个
 * Web Worker 把 jsQR 丢进去。
 */

interface CaptureResponse {
  dataUrl: string;
  captureWidth: number;
  captureHeight: number;
}

interface SaveRequest {
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

interface SaveResponse {
  ok: boolean;
  error?: string;
}

export default defineContentScript({
  registration: 'runtime',
  matches: [],

  async main() {
    console.info('[XAuthZee] qrselect injected');

    const overlay = mountOverlay();
    let overlayHost: HTMLDivElement | null = null;

    // 监听来自 background 的「开始扫描」消息 —— 实际现在的 main() 被
    // 调用就意味着 background 触发了扫描，但保留这个监听是为了将来
    // 在被注入后但还没显示浮层前能收到一个异步开始信号。
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const req = message as { type?: string };
      if (req?.type === 'qrselect-show') {
        if (!overlayHost) mountOntoHost(overlay);
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });

    // 注入脚本的同时 background 已经在等我们回报结果，但 WXT 注入到
    // 现在 main() 执行之间还有一个 microtask；显式 mount 一次以保证
    // 视觉上立即可见。
    mountOntoHost(overlay);

    // 监听拖拽完成事件
    document.addEventListener(
      'xz-selection-done',
      (ev) => {
        const detail = (ev as CustomEvent<SelectionResult>).detail;
        void handleSelection(overlay, detail);
      },
      { once: false },
    );

    // 监听 Esc 取消（在拖拽过程中）
    document.addEventListener(
      'xz-selection-cancel',
      () => {
        overlay.destroy();
      },
      { once: true },
    );
  },
});

function mountOntoHost(overlay: OverlayHandle) {
  const host = document.createElement('div');
  host.id = 'xauthzee-qrselect-host';
  // 内容脚本里直接挂 Shadow DOM，不走 createShadowRootUi
  // （WXT 那个是给常驻 content script 用的，按需注入这一层是多余的）
  const shadow = host.attachShadow({ mode: 'open' });

  // overlay.css 通过 ?inline 直接打成字符串进 bundle。
  // 比 link/runtime.getURL 路径都干净 —— 后者还会撞上 web_accessible
  // 资源的配额统计，每次启动都得多发一次 fetch。
  const style = document.createElement('style');
  style.textContent = overlayCss;
  shadow.append(style);

  shadow.append(overlay.root);
  document.documentElement.append(host);
  return host;
}

async function handleSelection(
  overlay: OverlayHandle,
  selection: SelectionResult,
) {
  // 1) 校验选区
  const prepared = prepareSelection(
    selection.rect,
    { width: selection.viewport.width, height: selection.viewport.height },
  );
  if ('error' in prepared) {
    await showSelectionError(overlay, prepared.error);
    return;
  }

  // 2) 让 background 截屏
  overlay.setBusy('截屏并解码…');
  const captured = await requestCapture(prepared.rect).catch((err: unknown) => {
    throw new Error(`截屏失败：${err instanceof Error ? err.message : String(err)}`);
  });

  // 3) 裁剪 + 解码
  const result = await decodeInContent(captured.dataUrl, {
    cssRect: prepared.rect,
    cssViewport: selection.viewport,
    captureSize: { width: captured.captureWidth, height: captured.captureHeight },
  });

  if (!result.text) {
    await showSelectionError(overlay, 'decode_failed');
    return;
  }

  // 4) 解析 otpauth URI
  let parsed;
  try {
    parsed = parseOtpauthUri(result.text);
  } catch (err) {
    if (err instanceof OtpUriError) {
      await showOtpUriError(overlay, err.code);
      return;
    }
    throw err;
  }

  // 5) 显示确认卡片
  const choice = await overlay.showConfirm({
    title: '扫到一个二维码',
    fields: [
      { label: '服务方', value: parsed.issuer || '（未填）' },
      { label: '账号', value: parsed.label || '（未填）' },
      {
        label: '参数',
        value: `${parsed.algorithm} · ${parsed.digits} 位 · ${parsed.period}s`,
        mono: true,
      },
    ],
    confirmLabel: '添加',
    cancelLabel: '取消',
  });

  if (choice !== 'confirm') {
    overlay.destroy();
    return;
  }

  // 6) 入库
  overlay.setBusy('正在保存…');
  const save = await saveAccount({
    issuer: parsed.issuer,
    label: parsed.label,
    secret: parsed.secret,
    algorithm: parsed.algorithm,
    digits: parsed.digits,
    period: parsed.period,
  });

  if (!save.ok) {
    await showSelectionError(overlay, 'save_failed', save.error);
    return;
  }

  overlay.destroy();
}

async function showSelectionError(
  overlay: OverlayHandle,
  code: SelectionError | 'decode_failed' | 'save_failed' | 'malformed',
  detail?: string,
) {
  const messages: Record<typeof code, { title: string; body: string }> = {
    selection_outside: {
      title: '选区超出可视范围',
      body: '把框选范围画在页面可见区域内。',
    },
    selection_too_small: {
      title: '选区太小了',
      body: '二维码至少要 50 像素宽才容易识别，再拖大一些。',
    },
    decode_failed: {
      title: '没找到二维码',
      body: '确认二维码在框选范围内、清晰且没有被遮挡。',
    },
    save_failed: {
      title: '保存失败',
      body: detail ? `错误：${detail}` : '请稍后再试。',
    },
    malformed: {
      title: '二维码内容无法识别',
      body: '这张二维码不是 otpauth:// 格式，可能来自其他用途。',
    },
  };
  const m = messages[code];
  const choice = await overlay.showError({
    title: m.title,
    message: m.body,
    retryLabel: '再试一次',
    cancelLabel: '取消',
  });
  if (choice === 'retry') {
    // 重置 overlay 状态，让用户可以重新框选
    resetOverlayToIdle(overlay);
  } else {
    overlay.destroy();
  }
}

async function showOtpUriError(overlay: OverlayHandle, code: ParseErrorCode) {
  const messages: Record<ParseErrorCode, { title: string; body: string }> = {
    not_otpauth: {
      title: '不是 2FA 二维码',
      body: '这张二维码不是 otpauth:// 格式，可能来自其他用途。',
    },
    hotp_unsupported: {
      title: '不支持 HOTP',
      body: '本扩展只支持基于时间（TOTP）的验证码。HOTP（基于计数器）暂不支持。',
    },
    migration_unsupported: {
      title: '不支持批量迁移',
      body: '这是 Google Authenticator 的批量迁移码。请在 Google Authenticator 里逐个导出。',
    },
    malformed: {
      title: '二维码内容无法识别',
      body: '二维码损坏或扫描不完整。',
    },
  };
  const m = messages[code];
  const choice = await overlay.showError({
    title: m.title,
    message: m.body,
    retryLabel: '再试一次',
    cancelLabel: '取消',
  });
  if (choice === 'retry') resetOverlayToIdle(overlay);
  else overlay.destroy();
}

function resetOverlayToIdle(overlay: OverlayHandle) {
  // 重置 hint 文本与选区，回到可拖拽状态
  const hint = overlay.root.querySelector('.xz-hint') as HTMLElement | null;
  if (hint) {
    hint.style.display = '';
    hint.textContent = '';
    hint.innerHTML = '框选二维码  ·  Esc 取消';
  }
  const mask = overlay.root.querySelector('.xz-mask') as HTMLElement | null;
  if (mask) mask.classList.remove('xz-cutout');
  const card = overlay.root.querySelector('.xz-card');
  if (card) card.remove();
}

/** 拿截屏。让 background 做 captureVisibleTab 然后发回来 */
async function requestCapture(rect: { x: number; y: number; w: number; h: number }): Promise<CaptureResponse> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('no active tab');
  const res = (await browser.runtime.sendMessage({
    type: 'm2-qrselect-region',
    tabId: tab.id,
    windowId: tab.windowId,
    rect,
  })) as CaptureResponse | undefined;
  if (!res?.dataUrl) throw new Error('background returned no capture');
  return res;
}

/** 裁剪 + 解码。解出来的 text 可能是 null（没找到 QR） */
async function decodeInContent(
  dataUrl: string,
  ctx: {
    cssRect: { x: number; y: number; w: number; h: number };
    cssViewport: { width: number; height: number };
    captureSize: { width: number; height: number };
  },
): Promise<{ text: string | null }> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  // 选区（CSS 像素）→ 截屏图（设备像素）
  const captureRect = selectionToCaptureRect(ctx.cssRect, ctx.cssViewport, ctx.captureSize);
  const clamped = clampRectToImage(captureRect, bitmap.width, bitmap.height);

  const canvas = document.createElement('canvas');
  canvas.width = clamped.w;
  canvas.height = clamped.h;
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  if (!c2d) throw new Error('cannot get 2d context');
  c2d.drawImage(
    bitmap,
    clamped.x,
    clamped.y,
    clamped.w,
    clamped.h,
    0,
    0,
    clamped.w,
    clamped.h,
  );
  const imageData = c2d.getImageData(0, 0, clamped.w, clamped.h);
  bitmap.close();

  const text = decodeImageData({
    data: imageData.data,
    width: imageData.width,
    height: imageData.height,
  });
  return { text };
}

async function saveAccount(
  draft: SaveRequest['draft'],
): Promise<SaveResponse> {
  const res = (await browser.runtime.sendMessage({
    type: 'm2-qrselect-save',
    draft,
  })) as SaveResponse | undefined;
  return res ?? { ok: false, error: '后台无响应' };
}