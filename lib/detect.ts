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
 *   - **maxlength=1 + 4-8 个 maxlength=1 兄弟簇** —— React Aria 等组件库
 *     经常把每个 OTP 格子裹一层 wrapper，input 自身没任何 id/name/label，
 *     但 maxlength=1 的紧密簇是独一无二的信号（日期选择器也算 maxlength=1
 *     但通常不在 4-8 范围内或被其他信号否决）。
 *
 * **二层（关键词命中，可关闭）**：
 *   - `id` / `name` / `aria-label` / `placeholder` / 关联 `<label>` / 父
 *     元素 `aria-labelledby` 的文本命中关键词表：验证码|动态码|OTP|TOTP|
 *     2FA|MFA|one-time|security code|verification code|authenticator。
 *   - 同时命中「反关键词」则排除：coupon|promo|zip|postal|password|hidden|
 *     隐藏|密码|优惠券|邮编。
 *
 * 反关键词是为了避免误伤：不少电商站搜索框叫 "coupon code"、登录密码框
 * 带 "verification" 字样。光看正向关键词命中率很高，但配合反关键词就稳。
 *
 * 六宫格识别：4-8 个 `maxlength=1` 的输入框紧密簇（无论是否各自裹 wrapper）。
 * 实现上沿父链向上找 —— 直接父只看到 1 个，wrapper 之上才看到 6 个。
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

  // 一层命中（maxlength=1 簇也算 —— React Aria 等组件库把每个格子裹一层，
  // input 自己没任何 id/name/label，但紧密的 maxlength=1 簇是独有的 OTP 信号）
  if (input.maxLength === 1) {
    const cluster = findGridCluster(input);
    if (cluster.length >= 4 && cluster.length <= 8) return 'six-grid';
  }
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
  // aria-label 是直接字符串，不是 ID 引用
  const ownLabel = input.getAttribute('aria-label');
  if (ownLabel) parts.push(ownLabel);
  collectAriaRefs(input, 'aria-labelledby', parts);
  collectAriaRefs(input, 'aria-describedby', parts);

  // React Aria 等组件库把 aria-labelledby / aria-describedby 挂在包裹 div 上，
  // 而不是 input 自己。沿父链向上读 1-2 层，把它们的文本也吸进来。
  let el: HTMLElement | null = input.parentElement;
  for (let depth = 0; el && depth < 2; depth++) {
    collectAriaRefs(el, 'aria-labelledby', parts);
    collectAriaRefs(el, 'aria-describedby', parts);
    el = el.parentElement;
  }

  if (input.labels) {
    for (const label of Array.from(input.labels)) parts.push(label.textContent ?? '');
  }
  return parts.join(' ');
}

/** 读取元素的 aria-labelledby / aria-describedby 引用的所有节点文本（空格分隔的 ID 列表）。 */
function collectAriaRefs(el: Element, attr: string, parts: string[]): void {
  const value = el.getAttribute(attr);
  if (!value) return;
  for (const id of value.split(/\s+/)) {
    if (!id) continue;
    const ref = document.getElementById(id);
    if (ref?.textContent) parts.push(ref.textContent);
  }
}

/**
 * 单输入框 vs 六宫格。
 *
 * 六宫格：父链向上找，最内层能装下 4-8 个 `maxlength=1` 的 <input> 视为
 * 六宫格。React Aria 等组件库把每个格子裹一层 wrapper，直接父只看到 1
 * 个 input，所以要向上找真正的「组容器」。
 */
function classifyShape(input: HTMLInputElement): FieldKind {
  const cluster = findGridCluster(input);
  if (cluster.length >= 4 && cluster.length <= 8) return 'six-grid';
  return 'otp';
}

/**
 * 从六宫格里找出全部格子输入框，按 DOM 顺序返回。
 * 失败时返回空数组（调用方降级为 'otp' 单格处理）。
 */
export function findGridCells(rootInput: HTMLInputElement): HTMLInputElement[] {
  const cluster = findGridCluster(rootInput);
  if (cluster.length >= 4 && cluster.length <= 8) return cluster;
  return [];
}

/**
 * 沿父链向上找 4-8 个 maxlength=1 的输入框簇。
 *
 * 1. 直接父只看到自己 → 不是六宫格
 * 2. wrapper 之上才看到 6 个 → 命中
 * 3. depth 上限 3 —— 太远的祖先里可能有同名网格（页面里同时存在两套六宫格
 *    的概率几乎为 0），避免误伤
 *
 * 返回的数组按 DOM 顺序，且一定包含 input 本身。
 */
function findGridCluster(input: HTMLInputElement): HTMLInputElement[] {
  let parent: HTMLElement | null = input.parentElement;
  for (let depth = 0; parent && depth < 3; depth++) {
    const candidates: HTMLInputElement[] = [];
    const all = parent.querySelectorAll('input');
    for (const s of Array.from(all)) {
      if (
        s instanceof HTMLInputElement &&
        s.maxLength === 1 &&
        !s.disabled &&
        !s.readOnly
      ) {
        candidates.push(s);
      }
    }
    if (candidates.length >= 4 && candidates.length <= 8 && candidates.includes(input)) {
      return candidates;
    }
    parent = parent.parentElement;
  }
  return [];
}