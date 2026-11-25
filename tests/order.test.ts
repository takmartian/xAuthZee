/**
 * 拖拽排序单元测试：lib/order.ts。
 *
 *   node --test tests/order.test.ts
 *
 * 重点盯的是那个最容易写错的点：重排之后写回 index 时，被域名置顶的账号
 * 必须留在它原来的槽位上。写错的表现不是「顺序不对」这种小毛病，而是
 * 「一拖，置顶那个账号跑到列表最底下」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRestOrder,
  moveItem,
  orderByIds,
  slotForPointerY,
  splitPinned,
} from '../lib/order.ts';
import { createVault, K_INDEX, type StorageArea } from '../lib/vault.ts';

// ---------------------------------------------------------------- 纯函数

describe('splitPinned', () => {
  test('两段各自保持 index 原序', () => {
    const s = splitPinned(['a', 'b', 'c', 'd'], new Set(['c']));
    assert.deepEqual(s.pinned, ['c']);
    assert.deepEqual(s.rest, ['a', 'b', 'd']);
  });

  test('没有命中项时全部落在非置顶段', () => {
    const s = splitPinned(['a', 'b'], new Set());
    assert.deepEqual(s.pinned, []);
    assert.deepEqual(s.rest, ['a', 'b']);
  });

  test('index 里不存在的 id 不会凭空冒出来', () => {
    const s = splitPinned(['a'], new Set(['zz']));
    assert.deepEqual(s.pinned, []);
    assert.deepEqual(s.rest, ['a']);
  });
});

describe('moveItem', () => {
  test('to 是摘除之后的位置', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
    assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  });

  test('不改原数组', () => {
    const src = ['a', 'b', 'c'];
    moveItem(src, 0, 2);
    assert.deepEqual(src, ['a', 'b', 'c']);
  });

  test('越界的 to 夹到合法区间 —— 这就是「往置顶块上方拖落到第一位」', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, -5), ['c', 'a', 'b']);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 99), ['b', 'c', 'a']);
  });

  test('from 越界时原样返回', () => {
    assert.deepEqual(moveItem(['a'], 7, 0), ['a']);
  });
});

describe('applyRestOrder', () => {
  test('核心：只换非置顶槽位，置顶项原地不动', () => {
    // index = a b c d e，其中 b 命中域名被置顶（它在 index 里的槽位是 1）
    // 可见的非置顶顺序是 a c d e；用户把 d 拖到最前面 => d a c e
    const out = applyRestOrder(['a', 'b', 'c', 'd', 'e'], new Set(['b']), ['d', 'a', 'c', 'e']);
    assert.deepEqual(out, ['d', 'b', 'a', 'c', 'e']);
    // b 还在下标 1，既没被顶到首位也没掉到末尾
    assert.equal(out[1], 'b');
    assert.equal(new Set(out).size, 5);
  });

  test('多个置顶项时各自的槽位都保住', () => {
    const out = applyRestOrder(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      new Set(['b', 'e']),
      ['f', 'd', 'c', 'a'],
    );
    assert.equal(out[1], 'b');
    assert.equal(out[4], 'e');
    assert.deepEqual(out, ['f', 'b', 'd', 'c', 'e', 'a']);
  });

  test('无置顶项时等价于整表按新顺序写回', () => {
    assert.deepEqual(applyRestOrder(['a', 'b', 'c'], new Set(), ['c', 'a', 'b']), ['c', 'a', 'b']);
  });

  test('忽略不属于可重排槽位的 id、重复 id，并按长度截断多余项', () => {
    const out = applyRestOrder(['a', 'b', 'c', 'd'], new Set(['b']), ['x', 'd', 'd', 'c', 'a', 'y']);
    // x / y 不在槽位集合里被跳过；第二个 d 重复被跳过
    assert.deepEqual(out, ['d', 'b', 'c', 'a']);
  });

  test('新顺序比槽位短时，没点到的账号按原序补位（不重不丢）', () => {
    const out = applyRestOrder(['a', 'b', 'c'], new Set(), ['c']);
    assert.deepEqual(out, ['c', 'a', 'b']);
    assert.equal(new Set(out).size, 3);
  });

  test('置顶项存在时补位也不会把它挤走', () => {
    const out = applyRestOrder(['a', 'b', 'c', 'd'], new Set(['b']), ['d']);
    assert.equal(out[1], 'b');
    assert.deepEqual(out, ['d', 'b', 'a', 'c']);
  });

  test('空新顺序等价于什么都不改', () => {
    assert.deepEqual(applyRestOrder(['a', 'b'], new Set(), []), ['a', 'b']);
  });
});

describe('slotForPointerY', () => {
  test('指针在所有行之上时插到第一位', () => {
    assert.equal(slotForPointerY([100, 140, 180], 20), 0);
  });

  test('指针在所有行之下时插到末尾（centers 已排除被拖行，故可等于长度）', () => {
    assert.equal(slotForPointerY([100, 140, 180], 900), 3);
  });

  test('排除被拖行后，向下挪一格不会多跳一格', () => {
    // 列表 a b c，正在拖 a。b/c 的中心是 140/180，指针停在 150 => 落在第 1 位
    const slot = slotForPointerY([140, 180], 150);
    assert.equal(slot, 1);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, slot), ['b', 'a', 'c']);
  });

  test('指针在最上面那行之上时等价于移到首位', () => {
    const slot = slotForPointerY([140, 180], 60);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, slot), ['c', 'a', 'b']);
  });

  test('按行的垂直中心判定，行高不齐也不会抖', () => {
    // 第二行特别高（有副标题），中心在 160
    assert.equal(slotForPointerY([100, 160, 200], 130), 1);
    assert.equal(slotForPointerY([100, 160, 200], 175), 2);
  });
});

describe('orderByIds', () => {
  test('按 ids 重排，ids 没提到的补在末尾', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(orderByIds(items, ['c', 'a']).map((x) => x.id), ['c', 'a', 'b']);
  });

  test('ids 里指向不存在的账号时忽略', () => {
    const items = [{ id: 'a' }];
    assert.deepEqual(orderByIds(items, ['zz', 'a']).map((x) => x.id), ['a']);
  });
});

// -------------------------------------------------- 与 vault 的联动（真写入）

function fakeArea() {
  const data: Record<string, unknown> = {};
  const area: StorageArea = {
    async get() {
      return structuredClone(data);
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const k of [keys].flat()) delete data[k];
    },
  };
  return { area, data };
}

const draft = (issuer: string) => ({
  issuer,
  label: '',
  secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1' as const,
  digits: 6,
  period: 30,
});

describe('拖拽结果落盘到 vault', () => {
  test('重排后所有账号都还在，且只有 index 一条被改写', async () => {
    const { area, data } = fakeArea();
    let setKeys: string[] = [];
    const wrapped: StorageArea = {
      get: (k) => area.get(k),
      async set(items) {
        setKeys = Object.keys(items);
        await area.set(items);
      },
      remove: (k) => area.remove(k),
    };
    const v = createVault(wrapped, { debounceMs: 0, now: () => 1 });

    const a = await v.add(draft('A'));
    const b = await v.add(draft('B'));
    const c = await v.add(draft('C'));
    const d = await v.add(draft('D'));
    const e = await v.add(draft('E'));
    await v.flush();
    void data;

    // b 命中当前站点被置顶。可见顺序 = b | a c d e
    const base = [a.id, b.id, c.id, d.id, e.id];
    const pinned = new Set([b.id]);
    const visibleRest = [a.id, c.id, d.id, e.id];

    // 用户把 e 从末尾拖到非置顶区第一位
    const newRest = moveItem(visibleRest, visibleRest.indexOf(e.id), 0);
    const full = applyRestOrder(base, pinned, newRest);
    await v.reorder(full);
    await v.flush();

    const listed = await v.list();
    assert.deepEqual(listed.map((x) => x.id), full);
    // 五个账号一个不少
    assert.equal(listed.length, 5);
    // b 仍在原来的槽位 1，没有因为这次拖动被固化到首位或末尾
    assert.equal(full[1], b.id);
    // 重排序只该写 index 这一条
    assert.deepEqual(setKeys, [K_INDEX]);

    // 再按同样的规则渲染一次：b 依旧置顶，其余按新顺序
    const s = splitPinned(full, pinned);
    assert.deepEqual(s.pinned, [b.id]);
    assert.deepEqual(s.rest, [e.id, a.id, c.id, d.id]);
  });

  test('反复拖动不会丢账号也不会产生重复', async () => {
    const { area } = fakeArea();
    const v = createVault(area, { debounceMs: 0, now: () => 1 });
    const ids: string[] = [];
    for (const n of ['A', 'B', 'C', 'D']) ids.push((await v.add(draft(n))).id);
    await v.flush();

    let index = [...ids];
    const pinned = new Set([ids[1]!]);
    // 模拟十次随机拖动
    for (let i = 0; i < 10; i++) {
      const s = splitPinned(index, pinned);
      const from = (i * 3) % s.rest.length;
      const to = (i * 7) % s.rest.length;
      index = applyRestOrder(index, pinned, moveItem(s.rest, from, to));
      await v.reorder(index);
      await v.flush();
    }

    const listed = (await v.list()).map((x) => x.id).sort();
    assert.deepEqual(listed, [...ids].sort());
    const after = await v.list();
    assert.equal(new Set(after.map((x) => x.id)).size, ids.length);
    // 被置顶的那个始终停在它最初的槽位
    assert.equal(index[1], ids[1]);
  });
});
