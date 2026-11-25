/**
 * 列表顺序：域名置顶 + 手动拖拽排序。
 *
 * 存储层只有一个真相：vault 的 `index`（账号 id 数组）。它既是「用户排好的
 * 顺序」，也是 collect() 兜底补全的依据 —— 所以任何一次重排都必须写回
 * **完整** 的 id 数组。少写一个 id，collect() 就会把它当成「index 没提到的
 * 账号」补到末尾，表现为「我一拖，置顶那个账号掉到最底下」。
 *
 * 而置顶项按需求不参与排序：命中当前站点绑定的账号永远显示在最上面。于是
 * 重排的正确做法不是「把可见列表原样写回 index」（那会把置顶项的位置也
 * 固化进去，换一个站点打开顺序就莫名其妙地变了），而是：
 *
 *   1. 找出 index 中属于非置顶项的那些下标（下称「可重排槽位」）
 *   2. 只把这些槽位的内容换成新的非置顶顺序
 *   3. 置顶项在原槽位上一动不动
 *
 * 这样「在 A 站点拖出来的顺序」只影响非置顶项之间的相对次序，切到别的
 * 站点或清空搜索时不会出现意外的位置变化。
 *
 * 本文件全是纯函数，不碰浏览器 API，可以直接 node --test 跑。
 */

export interface Split {
  /** 命中当前站点的账号 id，按 index 原序 */
  pinned: string[];
  /** 其余账号 id，按 index 原序 —— 只有这部分参与拖拽排序 */
  rest: string[];
}

/**
 * 按「是否命中当前站点」把 index 拆成置顶段与非置顶段，各自保持原序。
 *
 * pinnedIds 传空集合时结果就是 `{pinned: [], rest: [...index]}`，对应
 * 「没有当前 tab host」或「搜索中不做置顶」两种情况。
 */
export function splitPinned(
  indexIds: readonly string[],
  pinnedIds: ReadonlySet<string>,
): Split {
  const pinned: string[] = [];
  const rest: string[] = [];
  for (const id of indexIds) {
    if (pinnedIds.has(id)) pinned.push(id);
    else rest.push(id);
  }
  return { pinned, rest };
}

/**
 * 把下标 from 的元素挪到下标 to，返回新数组（不改原数组）。
 *
 * 语义是「先摘出来，再插到 to」，也就是 to 是摘除之后的位置 —— 与用户在
 * 列表里看到的「插入到第 to 个位置」直觉一致。越界的 to 会被夹到合法区间，
 * 这样「往置顶块上方拖」自然落到非置顶区的第一位。
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length) return out;
  const [picked] = out.splice(from, 1);
  const clamped = Math.max(0, Math.min(to, out.length));
  out.splice(clamped, 0, picked!);
  return out;
}

/**
 * 把新的非置顶顺序写回完整 index，置顶项的槽位保持不变。
 *
 * 防御性处理（多设备同步可能送来奇怪的输入）。核心不变量：**输出永远是输入
 * 同一批 id 的一个排列** —— 不重不丢。违反这个不变量的代价很实在：漏掉一个
 * id，collect() 就把它当「index 没提到的账号」补到列表末尾，用户看到的是一
 * 拖之后某个账号凭空跑到了最底下。
 *
 * - newRestOrder 里出现不属于可重排槽位的 id → 忽略
 * - 重复 id → 只认第一次出现
 * - newRestOrder 比槽位数短 → 没被点到的账号按原有相对次序填进剩余槽位
 *   （不是「保留原值」：原值可能是个已经被挪走的 id，直接留下会产生重复）
 */
export function applyRestOrder(
  fullIndex: readonly string[],
  pinnedIds: ReadonlySet<string>,
  newRestOrder: readonly string[],
): string[] {
  const slots: number[] = [];
  for (let i = 0; i < fullIndex.length; i++) {
    if (!pinnedIds.has(fullIndex[i]!)) slots.push(i);
  }

  const allowed = new Set(slots.map((i) => fullIndex[i]!));
  const out = [...fullIndex];
  const used = new Set<string>();
  let k = 0;
  for (const id of newRestOrder) {
    if (k >= slots.length) break;
    if (!allowed.has(id) || used.has(id)) continue;
    out[slots[k]!] = id;
    used.add(id);
    k++;
  }

  // 剩余槽位用「没被点到的原账号」按原序补齐，保证输出仍是同一批 id 的排列
  for (let i = 0; i < fullIndex.length && k < slots.length; i++) {
    const id = fullIndex[i]!;
    if (!allowed.has(id) || used.has(id)) continue;
    out[slots[k++]!] = id;
    used.add(id);
  }
  return out;
}

/**
 * 根据指针纵坐标算出「应该插到第几个」。
 *
 * 规则：数一下有多少行的垂直中心在指针之上，那个数就是目标下标。行高不齐
 * （有 sub 的行更高）也不会抖，因为比较的是中心点而不是行首。
 *
 * **centers 必须排除正在被拖的那一行**。moveItem 的 to 是「摘除之后」的位置，
 * 而指针相对被拖行自己的中心移动本来就意味着要跨过它 —— 把它算进来会白跳一格
 * （往下挪一位却落到隔一个的位置）。排除之后合法区间正好是 0..centers.length，
 * 其中 centers.length 表示「放到最后」。
 */
export function slotForPointerY(
  centers: readonly number[],
  pointerY: number,
): number {
  let n = 0;
  for (const c of centers) {
    if (c < pointerY) n++;
  }
  return Math.max(0, Math.min(n, centers.length));
}

/** 按给定 id 顺序重排账号数组；index 里没有的账号保持原有相对次序补在末尾 */
export function orderByIds<T extends { id: string }>(
  items: readonly T[],
  ids: readonly string[],
): T[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  const out: T[] = [];
  for (const id of ids) {
    const hit = byId.get(id);
    if (hit) {
      out.push(hit);
      byId.delete(id);
    }
  }
  for (const rest of byId.values()) out.push(rest);
  return out;
}
