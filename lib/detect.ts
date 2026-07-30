/**
 * OTP 输入框识别规则。
 *
 * 两层规则：
 *
 * **一层（标准信号，几乎不会误伤）**：
 *   - `autocomplete="one-time-code"`（W3C 标准信号，Chrome 本身在 SMS 短信
 *     验证码自动填充也用这个）。
 *   - `id` 或 `name` 完全等于 `otp` / `totp` / `2fa` / `mfa`。
 *   - `class` 包含 `otp` / `totp`（不区分大小写）。
 *
 * **二层（关键词命中，可关闭）**：
 *   - `id` / `name` / `aria-label` / `placeholder` / 关联 `<label>` 的文本
 *     命中关键词表：验证码|动态码|OTP|TOTP|2FA|MFA|one-time|security code|
 *     verification code|authenticator。
 *   - 同时命中「反关键词」则排除：coupon|promo|zip|postal|password|hidden|
 *     隐藏|密码|优惠券|邮编。
 *
 * 反关键词是为了避免误伤：不少电商站搜索框叫 "coupon code"、登录密码框
 * 带 "verification" 字样。光看正向关键词命中率很高，但配合反关键词就稳。
 *
 * 六宫格识别：检测一个容器内有 4-8 个 `maxlength=1` 的输入框，整体识别
 * 为六宫格；返回 'six-grid' 让填充逻辑走逐格填入路径。
 */

export type FieldKind = 'otp' | 'six-grid' | 'none';

const LAYER1_AUTOCOMPLETE = new Set(['one-time-code']);
const LAYER1_ID_NAME = new Set(['otp', 'totp', '2fa', 'mfa', 'one-time-code']);
const LAYER1_CLASS = /(^|[\s_-])(otp|totp|2fa|mfa|one-time-code)([\s_-]|$)/i;
const LAYER1_INPUTMODE = new Set(['numeric']);

const LAYER2_KEYWORDS = [
  'otp',
  'totp',
  '2fa',
  'mfa',
  'one-time',
  'one time',
  'one time code',
  'one-time-code',
  'verification code',
  'security code',
  'authenticator',
  '动态码',
  '动态验证码',
  '验证码',
  '两步验证',
  '两步',
];

const LAYER2_NEGATIVE = [
  'coupon',
  'promo',
  'promotion',
  'zip',
  'postal',
  'password',
  'passwd',
  'hidden',
  'pwd',
  '优惠券',
  '折扣',
  '邮编',
  '密码',
  '隐藏',
];

interface DetectionContext {
  /** 宿主页的 host，决定 disabledHosts 命中与否 */
  host: string;
  /** 偏好：是否启用宽松识别 */
  broadDetection: boolean;
  /** 这些 host 上整体禁用（精确匹配 host，不是 registrable） */
  disabledHosts: readonly string[];
}

/**
 * 检测一个 focusin 事件的目标元素是不是 OTP 输入框。
 *
 * 命中时返回字段类型（'otp' 单输入框 / 'six-grid' 六宫格），
 * 不命中返回 'none'。
 */
export function detectOtpField(
  el: EventTarget | null,
  ctx: DetectionContext,
): FieldKind {
  if (!ctx.host || ctx.disabledHosts.includes(ctx.host)) return 'none';
  if (!(el instanceof HTMLElement)) return 'none';
  // 找不到 <input> 就退出 —— focusin 可能落在 label / div 上
  const input = findInput(el);
  if (!input) return 'none';
  if (!isFillableInput(input)) return 'none';

  // 一层命中
  if (matchesLayer1(input)) return classifyShape(input);

  // 二层只在偏好打开时走
  if (!ctx.broadDetection) return 'none';
  if (matchesLayer2(input) && !matchesNegative(input)) {
    return classifyShape(input);
  }

  return 'none';
}

/** 沿父链找一个真正的 <input> / <textarea> */
function findInput(el: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
  if (el instanceof HTMLInputElement) return el;
  if (el instanceof HTMLTextAreaElement) return el;
  // label 标签有时会包住 input —— 沿 closest 找一下
  const closest = el.closest('input, textarea') as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  return closest;
}

function isFillableInput(el: HTMLElement): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  const type = (el.type || 'text').toLowerCase();
  // text / tel / search / number / password（少见但有的站密码字段带
  // autocomplete=one-time-code） / url / email 都可以填
  const allowed = ['text', 'tel', 'search', 'number', 'password', 'url', 'email', ''];
  if (!allowed.includes(type)) return false;
  if (el.disabled || el.readOnly) return false;
  if (!el.isConnected) return false;
  // 不可见元素跳过。检测 offsetParent 是不是真的可读 —— 一些 layout 引擎
  // stub（jsdom 等）会让它返回 null 但又不可靠；这里用「getter 是否抛错」
  // 守护一下：真实浏览器不抛，stub 引擎抛了就当 layout 不可用放行。
  let offsetParent: Element | null;
  try {
    offsetParent = el.offsetParent;
  } catch {
    return true;
  }
  if (offsetParent === null) {
    const position = getComputedStyle(el).position;
    if (position !== 'fixed') return false;
  }
  return true;
}

function matchesLayer1(input: HTMLInputElement): boolean {
  const ac = (input.autocomplete || '').toLowerCase().trim();
  if (LAYER1_AUTOCOMPLETE.has(ac)) return true;
  const id = (input.id || '').toLowerCase();
  const name = (input.name || '').toLowerCase();
  if (LAYER1_ID_NAME.has(id)) return true;
  if (LAYER1_ID_NAME.has(name)) return true;
  const cls = input.className || '';
  if (typeof cls === 'string' && LAYER1_CLASS.test(cls)) return true;
  if (input.inputMode && LAYER1_INPUTMODE.has(input.inputMode)) {
    // inputmode=numeric 单独不足以证明是 OTP，但配合 maxlength=6/7/8
    // 也能作为一层信号
    const len = input.maxLength;
    if (len >= 6 && len <= 8) return true;
  }
  return false;
}

function matchesLayer2(input: HTMLInputElement): boolean {
  const haystack = collectTextContext(input).toLowerCase();
  if (!haystack) return false;
  return LAYER2_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()));
}

function matchesNegative(input: HTMLInputElement): boolean {
  const haystack = collectTextContext(input).toLowerCase();
  return LAYER2_NEGATIVE.some((kw) => haystack.includes(kw.toLowerCase()));
}

function collectTextContext(input: HTMLInputElement): string {
  const parts: string[] = [];
  if (input.id) parts.push(input.id);
  if (input.name) parts.push(input.name);
  if (input.placeholder) parts.push(input.placeholder);
  if (input.getAttribute('aria-label')) parts.push(input.getAttribute('aria-label')!);
  if (input.getAttribute('aria-labelledby')) {
    const labelledBy = document.getElementById(input.getAttribute('aria-labelledby')!);
    if (labelledBy?.textContent) parts.push(labelledBy.textContent);
  }
  if (input.labels) {
    for (const label of Array.from(input.labels)) parts.push(label.textContent ?? '');
  }
  return parts.join(' ');
}

/**
 * 单输入框 vs 六宫格。
 *
 * 六宫格：父容器内有 4-8 个 `maxlength=1` 的兄弟 <input>。每个兄弟也都
 * 要走 isFillableInput 校验。
 */
function classifyShape(input: HTMLInputElement): FieldKind {
  // 输入框本身可能就是单格 —— 检查兄弟
  const parent = input.parentElement;
  if (!parent) return 'otp';
  const siblings = Array.from(parent.querySelectorAll('input'));
  const single = siblings.filter((s) => {
    if (s === input) return false;
    if (s.maxLength !== 1) return false;
    if (s.disabled || s.readOnly) return false;
    const type = (s.type || 'text').toLowerCase();
    return ['text', 'tel', 'number', ''].includes(type);
  });
  // 自身也算一格；4-8 格的容器视为六宫格
  const total = single.length + 1;
  if (total >= 4 && total <= 8) return 'six-grid';
  return 'otp';
}

/**
 * 从六宫格里找出全部格子输入框，按 DOM 顺序返回。
 * 失败时返回空数组（调用方降级为 'otp' 单格处理）。
 */
export function findGridCells(rootInput: HTMLInputElement): HTMLInputElement[] {
  const parent = rootInput.parentElement;
  if (!parent) return [];
  const all = Array.from(parent.querySelectorAll('input')).filter(
    (s): s is HTMLInputElement => s instanceof HTMLInputElement,
  );
  const cells = all.filter((s) => s.maxLength === 1 && !s.disabled && !s.readOnly);
  if (cells.length < 4 || cells.length > 8) return [];
  return cells;
}