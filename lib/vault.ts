import {
  DEFAULT_PREFS,
  dedupeDomains,
  newAccountId,
  normalizeDraft,
  type Account,
  type AccountDraft,
  type Prefs,
} from './model.ts';

/**
 * 账号仓库。
 *
 * 不直接引用 browser.storage，而是接收一个 StorageArea —— 既让单元测试能注入
 * 假实现，也方便 M8 在外面套一层加解密。与浏览器绑定的实例见 lib/storage.ts。
 *
 * 键布局（一个账号一条，而不是塞进一个大 blob）：
 *   index          string[]，账号 id 的显示顺序
 *   prefs          Prefs
 *   acct:<id>      Account
 *
 * 这么拆的原因是 storage.sync 的配额限制：单条 8KB、总量 100KB、最多 512 条。
 * 存成一个大 blob 的话，几十个账号就会撞上单条 8KB 上限；而且改任何一个账号
 * 都要重写全部数据，既浪费写配额，多设备同步时也更容易互相覆盖。
 * 拆开之后单条约 300 字节，改一个账号只写一条，重排序只写 index 一条。
 */

export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  getBytesInUse?(keys?: string | string[] | null): Promise<number>;
}

export const K_INDEX = 'index';
export const K_PREFS = 'prefs';
export const acctKey = (id: string) => `acct:${id}`;

/** chrome.storage.sync 的配额。用于容量提示与写入节流 */
export const SYNC_QUOTA = {
  totalBytes: 102_400,
  bytesPerItem: 8_192,
  maxItems: 512,
  writesPerMinute: 120,
  writesPerHour: 1_800,
} as const;

export interface VaultOptions {
  /** 连续修改的合并窗口。太短起不到合并作用，太长会让 popup 关闭时来不及落盘 */
  debounceMs?: number;
  now?: () => number;
}

export interface UsageReport {
  bytes: number;
  items: number;
  bytesLimit: number;
  itemsLimit: number;
  /** 已用比例 0..1，取字节数与条目数中更紧张的那个 */
  ratio: number;
}

export function createVault(area: StorageArea, options: VaultOptions = {}) {
  const debounceMs = options.debounceMs ?? 250;
  const now = options.now ?? (() => Date.now());

  /** 待写入缓冲。键 -> 值；值为 undefined 表示待删除 */
  const pending = new Map<string, unknown>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  /** 实际发出的 set/remove 调用时间戳，用于逼近 sync 的写频率限制 */
  const writeLog: number[] = [];
  let setCalls = 0;

  // ------------------------------------------------------------ 读取

  /** 读全量并叠加尚未落盘的改动，让界面看到乐观更新后的状态 */
  async function snapshot(): Promise<Record<string, unknown>> {
    const stored = await area.get(null);
    for (const [key, value] of pending) {
      if (value === undefined) delete stored[key];
      else stored[key] = value;
    }
    return stored;
  }

  function collect(raw: Record<string, unknown>): Account[] {
    const byId = new Map<string, Account>();
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith('acct:') && value) byId.set(key.slice(5), value as Account);
    }

    const order = Array.isArray(raw[K_INDEX]) ? (raw[K_INDEX] as string[]) : [];
    const result: Account[] = [];
    for (const id of order) {
      const account = byId.get(id);
      if (account) {
        result.push(account);
        byId.delete(id);
      }
    }
    // index 里没提到的账号补在末尾。多设备同步或写入中断都可能造成这种不一致，
    // 与其丢失数据不如兜住 —— 用户会看到顺序不对，但不会看到账号凭空消失。
    for (const account of byId.values()) result.push(account);

    return result;
  }

  async function list(): Promise<Account[]> {
    return collect(await snapshot());
  }

  async function get(id: string): Promise<Account | undefined> {
    const raw = await snapshot();
    return raw[acctKey(id)] as Account | undefined;
  }

  async function getPrefs(): Promise<Prefs> {
    const raw = await snapshot();
    return { ...DEFAULT_PREFS, ...((raw[K_PREFS] as Partial<Prefs>) ?? {}) };
  }

  // ------------------------------------------------------------ 写入

  function stage(key: string, value: unknown) {
    pending.set(key, value);
    if (timer === undefined) timer = setTimeout(() => void flush(), debounceMs);
  }

  /**
   * 逼近 storage.sync 的写频率限制。
   *
   * 超限时 Chrome 会直接让 set() 报错，而不是排队，所以宁可自己先等。
   * 正常使用根本碰不到这个上限，会碰到的是导入备份、批量加解密迁移这类场景。
   */
  async function throttle(): Promise<void> {
    const cutoffMinute = now() - 60_000;
    const cutoffHour = now() - 3_600_000;
    while (writeLog.length && writeLog[0]! < cutoffHour) writeLog.shift();

    const lastMinute = writeLog.filter((t) => t >= cutoffMinute);
    // 留 20% 余量：同一个账号可能在多个设备上同时写入
    if (lastMinute.length >= SYNC_QUOTA.writesPerMinute * 0.8) {
      const wait = 60_000 - (now() - lastMinute[0]!) + 50;
      await new Promise((r) => setTimeout(r, Math.max(wait, 0)));
    }
  }

  /** 把缓冲里的改动合并成一次 set + 一次 remove 落盘 */
  async function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (inFlight) return inFlight;
    if (pending.size === 0) return;

    const batch = new Map(pending);
    pending.clear();

    inFlight = (async () => {
      const toSet: Record<string, unknown> = {};
      const toRemove: string[] = [];
      for (const [key, value] of batch) {
        if (value === undefined) toRemove.push(key);
        else toSet[key] = value;
      }

      try {
        if (Object.keys(toSet).length) {
          await throttle();
          writeLog.push(now());
          setCalls++;
          await area.set(toSet);
        }
        if (toRemove.length) {
          await throttle();
          writeLog.push(now());
          await area.remove(toRemove);
        }
      } catch (err) {
        // 落盘失败就把改动放回缓冲，下一次 flush 重试。
        // 直接丢弃会让用户以为改动已保存，重启后才发现丢了。
        for (const [key, value] of batch) if (!pending.has(key)) pending.set(key, value);
        throw err;
      } finally {
        inFlight = undefined;
      }
    })();

    return inFlight;
  }

  async function add(draft: AccountDraft): Promise<Account> {
    const normalized = normalizeDraft(draft);
    const raw = await snapshot();
    const order = Array.isArray(raw[K_INDEX]) ? [...(raw[K_INDEX] as string[])] : [];

    const account: Account = {
      id: newAccountId(),
      issuer: normalized.issuer,
      label: normalized.label,
      secret: normalized.secret,
      algorithm: normalized.algorithm,
      digits: normalized.digits,
      period: normalized.period,
      domains: normalized.domains ?? [],
      createdAt: now(),
    };

    order.push(account.id);
    stage(acctKey(account.id), account);
    stage(K_INDEX, order);

    return account;
  }

  async function update(id: string, patch: Partial<Omit<Account, 'id'>>): Promise<void> {
    const current = await get(id);
    if (!current) return;

    const next: Account = { ...current, ...patch };
    if (patch.domains) next.domains = dedupeDomains(patch.domains);

    stage(acctKey(id), next);
  }

  async function remove(id: string): Promise<void> {
    const raw = await snapshot();
    const order = Array.isArray(raw[K_INDEX]) ? (raw[K_INDEX] as string[]) : [];

    stage(acctKey(id), undefined);
    stage(
      K_INDEX,
      order.filter((x) => x !== id),
    );
  }

  /** 重排序只改 index 一条，不动任何账号记录 */
  async function reorder(ids: string[]): Promise<void> {
    stage(K_INDEX, [...ids]);
  }

  async function setPrefs(patch: Partial<Prefs>): Promise<void> {
    stage(K_PREFS, { ...(await getPrefs()), ...patch });
  }

  // ------------------------------------------------------------ 容量

  async function usage(): Promise<UsageReport> {
    const raw = await snapshot();
    const items = Object.keys(raw).length;

    let bytes: number;
    if (area.getBytesInUse) {
      bytes = await area.getBytesInUse(null);
    } else {
      // 与 Chrome 的算法一致：键名长度 + 值序列化后的长度
      bytes = Object.entries(raw).reduce(
        (sum, [k, v]) => sum + k.length + JSON.stringify(v).length,
        0,
      );
    }

    return {
      bytes,
      items,
      bytesLimit: SYNC_QUOTA.totalBytes,
      itemsLimit: SYNC_QUOTA.maxItems,
      ratio: Math.max(bytes / SYNC_QUOTA.totalBytes, items / SYNC_QUOTA.maxItems),
    };
  }

  return {
    list,
    get,
    add,
    update,
    remove,
    reorder,
    getPrefs,
    setPrefs,
    flush,
    usage,
    /** 仅供测试：统计实际发生的 set() 次数，用于验证写入合并是否生效 */
    _setCalls: () => setCalls,
  };
}

export type Vault = ReturnType<typeof createVault>;
