/**
 * M7 单元测试：OTP 输入框识别规则。
 *
 *   node --test tests/detect.test.ts
 *
 * lib/detect.ts 是纯函数，没有浏览器依赖；测试用 jsdom 模拟 DOM。
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { detectOtpField, findGridCells } from '../lib/detect.ts';

let dom: JSDOM;
let document: Document;
let window: Window;

beforeEach(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  document = dom.window.document;
  // jsdom 的 Window 类型缺几个 DOM 类 —— 用 any-cast 后赋值给 globalThis，
  // 这样 detect.ts 拿到的 window/document 都是 jsdom 实例，调用 jQuery-
  // 风格的方法不会出 prototype 不一致的问题。
  window = dom.window as unknown as Window;
  const g = globalThis as Record<string, unknown>;
  const w = dom.window as unknown as Record<string, unknown>;
  g.window = window;
  g.document = document;
  g.HTMLElement = w.HTMLElement;
  g.HTMLInputElement = w.HTMLInputElement;
  g.HTMLTextAreaElement = w.HTMLTextAreaElement;
  g.EventTarget = w.EventTarget;
  g.getComputedStyle = (w.getComputedStyle as (...args: unknown[]) => unknown).bind(window);

  // jsdom 的 offsetParent getter 在 prototype chain 上，调用时返回 null
  // 但不抛错 —— detect.ts 的可见性判断（offsetParent === null && position
  // !== 'fixed'）会被误伤。把检测退化为「始终有 parent」即可。这只是测试
  // 替身，不影响生产代码逻辑。
  const docEl = document.documentElement;
  const HTMLElementProto = (w.HTMLElement as { prototype: object }).prototype;
  if (!Object.getOwnPropertyDescriptor(HTMLElementProto, '__xz_offsetParentPatched')) {
    Object.defineProperty(HTMLElementProto, 'offsetParent', {
      configurable: true,
      get() {
        return docEl;
      },
    });
    Object.defineProperty(HTMLElementProto, '__xz_offsetParentPatched', {
      value: true,
    });
  }
});

function ctx(host = 'example.com') {
  return { host, broadDetection: true, disabledHosts: [] as readonly string[] };
}

function makeInput(attrs: Record<string, string>): HTMLInputElement {
  const el = document.createElement('input');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

describe('detectOtpField — layer 1', () => {
  test('autocomplete=one-time-code hits', () => {
    const el = makeInput({ autocomplete: 'one-time-code', type: 'text' });
    assert.equal(detectOtpField(el, ctx()), 'otp');
  });

  test('id=otp hits', () => {
    const el = makeInput({ id: 'otp', type: 'text' });
    assert.equal(detectOtpField(el, ctx()), 'otp');
  });

  test('name=totp hits', () => {
    const el = makeInput({ name: 'totp', type: 'text' });
    assert.equal(detectOtpField(el, ctx()), 'otp');
  });

  test('class containing otp hits', () => {
    const el = makeInput({ class: 'my-otp-input', type: 'text' });
    assert.equal(detectOtpField(el, ctx()), 'otp');
  });

  test('inputmode=numeric + maxlength=6 hits', () => {
    const el = makeInput({ inputmode: 'numeric', maxlength: '6', type: 'text' });
    assert.equal(detectOtpField(el, ctx()), 'otp');
  });

  test('inputmode=numeric but maxlength=10 does not hit layer 1', () => {
    const el = makeInput({ inputmode: 'numeric', maxlength: '10', type: 'text' });
    assert.equal(detectOtpField(el, ctx()), 'none');
  });
});

describe('detectOtpField — layer 2', () => {
  test('placeholder=动态验证码 hits', () => {
    const el = makeInput({ placeholder: '动态验证码', type: 'text' });
    assert.equal(detectOtpField(el, ctx()), 'otp');
  });

  test('aria-label=verification code hits', () => {
    const el = makeInput({ 'aria-label': 'verification code', type: 'text' });
    assert.equal(detectOtpField(el, ctx()), 'otp');
  });

  test('coupon code filtered by negative keywords', () => {
    const el = makeInput({ placeholder: 'coupon code', type: 'text' });
    assert.equal(detectOtpField(el, ctx()), 'none');
  });

  test('disabled field does not hit', () => {
    const el = makeInput({ autocomplete: 'one-time-code', type: 'text', disabled: '' });
    assert.equal(detectOtpField(el, ctx()), 'none');
  });

  test('broadDetection=false skips layer 2', () => {
    const el = makeInput({ placeholder: '动态验证码', type: 'text' });
    assert.equal(
      detectOtpField(el, { host: 'example.com', broadDetection: false, disabledHosts: [] }),
      'none',
    );
  });

  test('disabled host does not hit even for layer 1', () => {
    const el = makeInput({ autocomplete: 'one-time-code', type: 'text' });
    assert.equal(
      detectOtpField(el, {
        host: 'blocked.example.com',
        broadDetection: true,
        disabledHosts: ['blocked.example.com'],
      }),
      'none',
    );
  });
});

describe('detectOtpField — six-grid', () => {
  test('6 sibling inputs with maxlength=1 → six-grid', () => {
    const wrap = document.createElement('div');
    wrap.id = 'otp-grid';
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('input');
      c.setAttribute('maxlength', '1');
      c.setAttribute('autocomplete', 'one-time-code');
      wrap.append(c);
    }
    document.body.append(wrap);
    const first = wrap.querySelector('input')!;
    assert.equal(detectOtpField(first, ctx()), 'six-grid');
  });

  test('4 cells → six-grid', () => {
    const wrap = document.createElement('div');
    for (let i = 0; i < 4; i++) {
      const c = document.createElement('input');
      c.setAttribute('maxlength', '1');
      c.setAttribute('autocomplete', 'one-time-code');
      wrap.append(c);
    }
    document.body.append(wrap);
    const first = wrap.querySelector('input')!;
    assert.equal(detectOtpField(first, ctx()), 'six-grid');
  });

  test('9 cells → otp (out of six-grid range)', () => {
    const wrap = document.createElement('div');
    for (let i = 0; i < 9; i++) {
      const c = document.createElement('input');
      c.setAttribute('maxlength', '1');
      c.setAttribute('autocomplete', 'one-time-code');
      wrap.append(c);
    }
    document.body.append(wrap);
    const first = wrap.querySelector('input')!;
    assert.equal(detectOtpField(first, ctx()), 'otp');
  });

  test('React Aria 风格：每个格子裹一层 wrapper，没有 id/name/aria-label 文本信号', () => {
    // 复刻 FinPass / Keycloak 的 React Aria OTP 结构：
    //   <hgroup id="r9">Enter OTP</hgroup>
    //   <div aria-labelledby="r9">         ← 父链第 1 层
    //     <div>                              ← cell wrapper
    //       <div aria-labelledby="r9">       ← 父链第 0 层（input 的直接父）
    //         <input maxlength="1" aria-label=":r8:" />   ← 没有任何 otp 关键词
    //       </div>
    //     </div>
    //     ... × 6
    //   </div>
    const heading = document.createElement('hgroup');
    heading.id = 'r9';
    heading.textContent = 'Enter OTP';
    const outer = document.createElement('div');
    outer.setAttribute('aria-labelledby', 'r9');
    for (let i = 0; i < 6; i++) {
      const wrap = document.createElement('div');
      const inner = document.createElement('div');
      inner.setAttribute('aria-labelledby', 'r9');
      const c = document.createElement('input');
      c.setAttribute('type', 'text');
      c.setAttribute('maxlength', '1');
      c.setAttribute('aria-label', ':r8:'); // 跟 React Aria 生成的一样
      inner.append(c);
      wrap.append(inner);
      outer.append(wrap);
    }
    document.body.append(heading, outer);
    const first = outer.querySelector('input')!;
    assert.equal(detectOtpField(first, ctx()), 'six-grid');
  });

  test('每个格子裹一层 wrapper 但只有 3 个 → 不是 six-grid', () => {
    // maxlength=1 簇必须是 4-8，否则不是 OTP 网格
    const outer = document.createElement('div');
    for (let i = 0; i < 3; i++) {
      const wrap = document.createElement('div');
      const c = document.createElement('input');
      c.setAttribute('maxlength', '1');
      wrap.append(c);
      outer.append(wrap);
    }
    document.body.append(outer);
    const first = outer.querySelector('input')!;
    assert.equal(detectOtpField(first, ctx()), 'none');
  });
});

describe('detectOtpField — layer 2 aria chain', () => {
  test('父元素 aria-labelledby 指向「Enter OTP」文本 → 命中 layer 2', () => {
    // React Aria 把 aria-labelledby 挂在包裹 div 上，input 自身没关键词
    const label = document.createElement('h1');
    label.id = 'heading-otp';
    label.textContent = 'Enter OTP';
    const wrapper = document.createElement('div');
    wrapper.setAttribute('aria-labelledby', 'heading-otp');
    const el = document.createElement('input');
    el.setAttribute('type', 'text');
    wrapper.append(el);
    document.body.append(label, wrapper);
    assert.equal(detectOtpField(el, ctx()), 'otp');
  });

  test('aria-describedby 引用的错误消息也参与匹配', () => {
    const hint = document.createElement('span');
    hint.id = 'otp-hint';
    hint.textContent = 'Please enter your one-time code';
    const el = document.createElement('input');
    el.setAttribute('type', 'text');
    el.setAttribute('aria-describedby', 'otp-hint');
    document.body.append(hint, el);
    assert.equal(detectOtpField(el, ctx()), 'otp');
  });
});

describe('findGridCells', () => {
  test('returns all six cells in order', () => {
    const wrap = document.createElement('div');
    const cells: HTMLInputElement[] = [];
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('input');
      c.setAttribute('maxlength', '1');
      cells.push(c);
      wrap.append(c);
    }
    document.body.append(wrap);
    const found = findGridCells(cells[0]!);
    assert.equal(found.length, 6);
    assert.deepEqual(found, cells);
  });

  test('skips disabled cells', () => {
    const wrap = document.createElement('div');
    const cells: HTMLInputElement[] = [];
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('input');
      c.setAttribute('maxlength', '1');
      if (i === 2) c.setAttribute('disabled', '');
      cells.push(c);
      wrap.append(c);
    }
    document.body.append(wrap);
    const found = findGridCells(cells[0]!);
    assert.equal(found.length, 5);
  });

  test('empty when no grid', () => {
    const el = makeInput({ autocomplete: 'one-time-code', type: 'text' });
    assert.equal(findGridCells(el).length, 0);
  });

  test('React Aria wrapper：每个 cell 各裹一层也能正确返回 6 个', () => {
    const outer = document.createElement('div');
    const cells: HTMLInputElement[] = [];
    for (let i = 0; i < 6; i++) {
      const wrap = document.createElement('div');
      const c = document.createElement('input');
      c.setAttribute('maxlength', '1');
      cells.push(c);
      wrap.append(c);
      outer.append(wrap);
    }
    document.body.append(outer);
    const found = findGridCells(cells[0]!);
    assert.equal(found.length, 6);
    assert.deepEqual(found, cells);
  });
});