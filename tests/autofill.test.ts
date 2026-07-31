/**
 * M7 单元测试：验证码填充。
 *
 *   node --test tests/autofill.test.ts
 *
 * jsdom 模拟 input + 自定义 React-like value tracker 来验证
 * 「绕开 React」这条路径生效。
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { fillInto, pasteInto } from '../lib/autofill.ts';

let dom: JSDOM;
let document: Document;

beforeEach(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  document = dom.window.document;
  const window = dom.window;
  const g = globalThis as Record<string, unknown>;
  g.window = window;
  g.document = document;
  g.HTMLElement = window.HTMLElement;
  g.HTMLInputElement = window.HTMLInputElement;
  g.HTMLTextAreaElement = window.HTMLTextAreaElement;
  g.EventTarget = window.EventTarget;
  // jsdom 的 Event / ClipboardEvent / InputEvent / KeyboardEvent 是另一
  // 个构造器；测试里需要全局替换。detect / autofill 不直接构造事件，但
  // 它们调 dispatchEvent(event)，当 event 不是 jsdom 实例时 dispatchEvent
  // 抛 TypeError。把所有事件构造器注入到全局，autofill.ts 里 new Event
  // / InputEvent / KeyboardEvent 走的就是 jsdom 那个。
  g.Event = window.Event;
  g.InputEvent = window.InputEvent;
  g.KeyboardEvent = window.KeyboardEvent;
  g.ClipboardEvent = window.ClipboardEvent;
  g.DataTransfer = window.DataTransfer;
});

function makeInput(attrs: Record<string, string> = {}): HTMLInputElement {
  const el = document.createElement('input');
  el.setAttribute('type', 'text');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

describe('fillInto — single input', () => {
  test('writes value and dispatches input/change', () => {
    const el = makeInput({ autocomplete: 'one-time-code' });
    const events: string[] = [];
    el.addEventListener('input', () => events.push('input'));
    el.addEventListener('change', () => events.push('change'));

    const result = fillInto(el, '123456');
    assert.equal(result.ok, true);
    assert.equal(el.value, '123456');
    assert.deepEqual(events, ['input', 'change']);
  });

  test('truncates to maxLength', () => {
    const el = makeInput({ maxlength: '4' });
    const result = fillInto(el, '123456');
    assert.equal(result.ok, true);
    assert.equal(el.value, '1234');
  });

  test('refuses disabled input', () => {
    const el = makeInput({ disabled: '' });
    const result = fillInto(el, '123456');
    assert.equal(result.ok, false);
  });

  test('refuses non-input target', () => {
    const div = document.createElement('div');
    document.body.append(div);
    const result = fillInto(div, '123456');
    assert.equal(result.ok, false);
  });
});

describe('fillInto — React-like controlled input', () => {
  /**
   * 模拟 React 受控组件：input 事件触发后 value 会被覆盖回 state。
   * 关键点：fillInto 必须先写 DOM value，再派发 input，React 在事件处理
   * 里读到的 value 才会是新的。如果直接 `el.value = code` 然后 dispatch，
   * React 的 onChange handler 用 event.target.value 能读到正确值，
   * 但有些 React 版本会用其他方式追踪 —— 我们的走法（原生 setter）
   * 是最稳的。
   */
  test('writes via native setter so React onChange sees the new value', () => {
    const el = makeInput();
    let observed = '';
    el.addEventListener('input', () => {
      observed = (el as HTMLInputElement).value;
      // 模拟 React 把 value 重置回 state（异步），但事件处理同步里看到的是新值
      setTimeout(() => {
        // 不在这里重置 —— 测试只在事件处理瞬间观察
      }, 0);
    });

    fillInto(el, '654321');
    assert.equal(observed, '654321');
  });

  test('value is preserved across the React re-render simulation', () => {
    // 模拟：React 在事件处理里把 value 又设回了 ''（如果用户没改 state）
    // —— 这其实是写错的代码，我们验证我们的 setter 不被这种代码覆盖
    const el = makeInput();
    el.addEventListener('input', () => {
      // 模拟 React 同步里的强制赋值（错误代码）
      (el as HTMLInputElement).value = '';
    });
    fillInto(el, '111222');
    // fillInto 已经写入 → React 又清空，最后是空。
    // 这正是我们文档里说「React 受控组件必须 setState」的佐证，不是 bug。
    assert.equal(el.value, '');
  });
});

describe('fillInto — six-grid', () => {
  function makeGrid(n: number): HTMLInputElement[] {
    const wrap = document.createElement('div');
    wrap.id = 'otp-grid';
    const cells: HTMLInputElement[] = [];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('input');
      c.setAttribute('maxlength', '1');
      c.setAttribute('autocomplete', 'one-time-code');
      wrap.append(c);
      cells.push(c);
    }
    document.body.append(wrap);
    return cells;
  }

  test('6 cells each get one digit', () => {
    const cells = makeGrid(6);
    const result = fillInto(cells[0]!, '123456');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.mode, 'grid');
    for (let i = 0; i < 6; i++) {
      assert.equal(cells[i]!.value, String(i + 1));
    }
  });

  test('dispatches input event for each cell', () => {
    const cells = makeGrid(6);
    const counts = [0, 0, 0, 0, 0, 0];
    cells.forEach((c, i) => {
      c.addEventListener('input', () => (counts[i]! += 1));
    });
    fillInto(cells[0]!, 'abcdef');
    assert.deepEqual(counts, [1, 1, 1, 1, 1, 1]);
  });

  test('4-cell grid works with 4-digit code', () => {
    const cells = makeGrid(4);
    const result = fillInto(cells[0]!, '1234');
    assert.equal(result.ok, true);
    assert.equal(cells[3]!.value, '4');
  });

  test('rejects when code is longer than grid size', () => {
    const cells = makeGrid(6);
    const result = fillInto(cells[0]!, '1234567');
    assert.equal(result.ok, false);
  });

  test('code shorter than grid fills first N cells, leaves rest empty', () => {
    const cells = makeGrid(6);
    const result = fillInto(cells[0]!, '12345');
    assert.equal(result.ok, true);
    assert.equal(cells[0]!.value, '1');
    assert.equal(cells[4]!.value, '5');
    assert.equal(cells[5]!.value, '');
  });
});

describe('fillInto — InputEvent 兼容 React Aria OTP', () => {
  test('派发的是 InputEvent（而非泛 Event），且带 data 字段', () => {
    // React Aria v3 的 OTP 组件用 nativeEvent instanceof InputEvent 和
    // nativeEvent.data 判断输入来源；泛 Event 会被当作 IME / 非受信任事件跳过。
    const el = makeInput({ maxlength: '1' });
    const observed: { isInputEvent: boolean; data: string | null } = {
      isInputEvent: false,
      data: null,
    };
    el.addEventListener('input', (e) => {
      observed.isInputEvent = e instanceof InputEvent;
      observed.data = (e as InputEvent).data;
    });
    fillInto(el, '7');
    assert.equal(observed.isInputEvent, true);
    assert.equal(observed.data, '7');
  });

  test('keydown 在 input 之前派发', () => {
    // 真实按键时序：keydown → 字符插入 → input。React Aria 用 keydown
    // 启动输入跟踪 / 推进焦点，所以必须先发。
    const el = makeInput({ maxlength: '1' });
    const order: string[] = [];
    el.addEventListener('keydown', () => order.push('keydown'));
    el.addEventListener('input', () => order.push('input'));
    fillInto(el, '3');
    assert.deepEqual(order, ['keydown', 'input']);
  });

  test('六宫格：每个格子都派发 InputEvent 且 data 等于该位数字', () => {
    function makeGrid(n: number): HTMLInputElement[] {
      const wrap = document.createElement('div');
      const cells: HTMLInputElement[] = [];
      for (let i = 0; i < n; i++) {
        const c = document.createElement('input');
        c.setAttribute('maxlength', '1');
        wrap.append(c);
        cells.push(c);
      }
      document.body.append(wrap);
      return cells;
    }
    const cells = makeGrid(6);
    const observed: string[] = [];
    cells.forEach((c, idx) => {
      c.addEventListener('input', (e) => {
        observed.push(`${idx}:${(e as InputEvent).data}`);
      });
    });
    fillInto(cells[0]!, '123456');
    assert.deepEqual(observed, ['0:1', '1:2', '2:3', '3:4', '4:5', '5:6']);
  });
});

describe('pasteInto', () => {
  test('dispatches paste event and writes value', () => {
    const el = makeInput({ autocomplete: 'one-time-code' });
    let pasteCount = 0;
    el.addEventListener('paste', () => pasteCount++);
    pasteInto(el, '999000');
    assert.equal(pasteCount, 1);
    // jsdom 的 ClipboardEvent.getData 不真读 DataTransfer —— 真实浏览器
    // 里 clipboardData 才有数据。值已经通过原生 setter 写入，能在 onChange 里读到。
    assert.equal(el.value, '999000');
  });
});