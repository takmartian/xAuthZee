/**
 * 把验证码写到输入框里。
 *
 * **绕开 React 受控组件**：直接 `el.value = code` 会被 React 的 onChange
 * 拦截重置回 state，所以走原生 value setter + dispatch input 事件。
 * 标准做法：拿 HTMLInputElement.prototype 上的原生 setter，把值塞进去，
 * 再派发一个 input 事件让 React 同步到 state。
 *
 * **事件类型**：React Aria v3 的 OTP 组件用 `nativeEvent instanceof
 * InputEvent` 和 `nativeEvent.data` 来识别真实输入，泛 `Event('input')`
 * 会被当作 IME 合成或非受信任事件跳过。同时一些 OTP 实现用 keydown 启
 * 动输入跟踪 / 推进焦点，所以一并派发。composed: true 让事件穿过
 * Shadow DOM 边界。
 *
 * **六宫格**：每个格子 maxlength=1，逐格填入并逐格派发事件，让网站
 * 自己的「输入后自动跳下一格」逻辑能正常触发。失败回退到「整段 paste
 * 到第一个格子 + 派发 paste 事件」。
 */

import { findGridCells } from './detect.ts';

export type FillResult =
  | { ok: true; mode: 'single' | 'grid' | 'paste' }
  | { ok: false; reason: 'not_input' | 'disabled' | 'readonly' | 'detached' | 'wrong_length' };

/** 把 code 写进 el。失败返回具体原因，让调用方降级到 clipboard。 */
export function fillInto(el: EventTarget | null, code: string): FillResult {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
    return { ok: false, reason: 'not_input' };
  }
  if (el.disabled) return { ok: false, reason: 'disabled' };
  if (el.readOnly) return { ok: false, reason: 'readonly' };
  if (!el.isConnected) return { ok: false, reason: 'detached' };
  if (!(el instanceof HTMLInputElement)) {
    // <textarea> 没有 maxLength 限制，直接写
    writeValue(el, code);
    return { ok: true, mode: 'single' };
  }

  // 六宫格路径：兄弟里有 4-8 个 maxlength=1 的 input
  const cells = findGridCells(el);
  if (cells.length > 0) {
    // code 比格子数多 = 输入框实际不是六宫格（可能是 8 位 + 站点要求 6），
    // 这种情况下拒绝更好，避免截断到错误位数。
    if (code.length > cells.length) {
      return { ok: false, reason: 'wrong_length' };
    }
    // code 比格子少（例如格子 6 个但 code 5 位 = 网站不该用 5 位 TOTP）
    // 我们只填前 N 格，不补 0，避免站点把 0 当成合法字符。
    fillGrid(cells, code);
    return { ok: true, mode: 'grid' };
  }

  // 单输入框路径：maxLength 校验
  const max = el.maxLength;
  if (max > 0 && max < code.length) {
    // 截断到 maxLength —— 一些站 maxlength=8 但 TOTP 是 6 位也允许
    writeValue(el, code.slice(0, max));
    return { ok: true, mode: 'single' };
  }
  writeValue(el, code);
  return { ok: true, mode: 'single' };
}

/** 走原生 setter 写值，再派发 keydown + input + change。
 *
 * keydown 是给 React Aria 等 OTP 组件的「输入起点」信号；InputEvent
 * （而非泛 Event）让 onChange 能通过 nativeEvent.data 拿到写入值。
 */
function writeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // keydown 先发 —— 真实按键的时序是 keydown → 字符插入 → input。
  // OTP 组件的 focus 推进 / 输入跟踪通常挂在 keydown 上。
  try {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        composed: true,
        key: value.length === 1 ? value : '',
      }),
    );
  } catch {
    /* 极旧环境没有 KeyboardEvent，忽略 */
  }

  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    // 极少数环境（极旧的 IE）拿不到 setter，回退到直接赋值
    el.value = value;
  }

  // InputEvent + data + composed —— React Aria 的 OTP 用 nativeEvent.data
  // 而非 target.value 读刚写入的值，泛 Event 没有 data 字段。
  try {
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, data: value }),
    );
  } catch {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 逐格填入六宫格。
 *
 * 逐格派发 input 事件而不是一次写完 —— 大多数六宫格组件靠监听单个
 * input 的 input 事件触发「跳下一格」逻辑，全写完再统一派发反而把它们
 * 的状态机搞乱。
 */
function fillGrid(cells: HTMLInputElement[], code: string) {
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const ch = code[i] ?? '';
    writeValue(cell, ch);
  }
}

/**
 * 备选：模拟 paste 到第一个格子。如果 fillInto 因为某些原因失败
 * （比如 React 受控组件把 input 事件当异步），这里再派发 paste 试试。
 */
export function pasteInto(el: EventTarget | null, code: string): FillResult {
  if (!(el instanceof HTMLInputElement)) {
    return fillInto(el, code);
  }
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, code);
  else el.value = code;
  // ClipboardEvent 在 jsdom（测试）和一些老 Safari 下不可用，
  // 退化路径：直接 dispatch 一个 input 事件 —— 大多数站点的 onPaste
  // 监听都至少能从 value 里读到。
  let dt: DataTransfer | undefined;
  try {
    dt = new DataTransfer();
    dt.setData('text/plain', code);
  } catch {
    dt = undefined;
  }
  let evt: Event;
  try {
    evt = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      ...(dt ? { clipboardData: dt } : {}),
    } as ClipboardEventInit);
  } catch {
    evt = new Event('paste', { bubbles: true, cancelable: true });
  }
  el.dispatchEvent(evt);
  // 不管 paste 事件有没有 handler，input 事件也要派发（让 React/Vue
  // 同步 state）。
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true, mode: 'paste' };
}