import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '@/lib/i18n';
import { vault, watchVault } from '@/lib/storage';
import type { Account } from '@/lib/model';
import { anyMatch } from '@/lib/domain';
import { CodeRow, type CopyResult } from '@/components/CodeRow';
import { AddDialog } from '@/components/AddDialog';
import { UnlockScreen } from '@/components/UnlockScreen';
import { QrIcon, KeyboardIcon, SearchIcon } from '@/components/Icon';
import {
  installLockRuntime,
  getDerivedKey,
  autoLockIfOverdue,
} from '@/lib/lock-runtime';
import {
  getLockState,
  onLockChange,
  unlock as lockUnlock,
  type LockUiState,
} from '@/lib/lock';
import { migrateSecret, revealAccounts, stripSecrets } from '@/lib/secrets';
import styles from './App.module.css';

/**
 * popup 主界面。
 *
 * 几个值得说的设计决定：
 *
 * 1. 现在用 setInterval 每秒刷新一次，驱动倒计时环。够用。
 *    改成 requestAnimationFrame 会更丝滑但 popup 一秒才刷新一次
 *    也看不出差别，而且 rAF 在 popup 切到后台时会被节流，不划算。
 *
 * 2. 列表直接从 vault.list() 读取，watchVault() 监听跨设备同步。
 *    不维护本地副本 —— vault 内部已经做了乐观更新，本地写入立刻
 *    可见，远程写入通过 storage.onChanged 触发回调。
 *
 * 3. 点击行：先尝试填充当前 tab 上的 OTP 输入框，失败回退到复制。
 *
 * 4. 搜索框：popup 一打开就自动 focus —— 用户最常见的操作是「打开找
 *    第一个账号的验证码」，让键盘直接可用。搜索范围覆盖 issuer + label
 *    子串匹配，大小写不敏感。搜索状态下命中域名绑定的账号不再置顶
 *    （用户既然在搜，就不再按位置组织）。
 */
export default function App() {
  // 锁状态：'loading' 初始；之后由 runtime 决定
  const [lockState, setLockState] = useState<LockUiState>('loading');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus>({ kind: 'idle' });
  // 当前标签页的 host，给菜单里「绑定当前网站」用。null 表示没有
  // （比如 popup 是从 action 菜单里打开的，没有具体 tab）。
  const [currentHost, setCurrentHost] = useState<string | null>(null);
  // 搜索关键词。空 = 不过滤。
  const [query, setQuery] = useState('');

  // 装 lock runtime + 初次 lockState + 监听变化 + 兜底自动锁
  useEffect(() => {
    installLockRuntime();
    let cancelled = false;
    void (async () => {
      // SW 不一定在场，popup 自己再检查一次超时
      try {
        await autoLockIfOverdue();
      } catch {
        /* runtime 可能还没装上，忽略 */
      }
      if (cancelled) return;
      setLockState(await getLockState());
    })();
    const off = onLockChange((s) => {
      if (!cancelled) setLockState(s);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // 加载 accounts —— 根据 lockState 决定是解密、明文、还是 strip
  useEffect(() => {
    if (lockState === 'loading') return;
    let cancelled = false;
    const load = async () => {
      const raw = await vault.list();
      let result: Account[];
      if (lockState === 'unlocked') {
        const key = await getDerivedKey();
        result = key ? await revealAccounts(raw, key) : stripSecrets(raw);
      } else if (lockState === 'locked') {
        result = stripSecrets(raw);
      } else {
        result = raw; // plaintext
      }
      if (!cancelled) setAccounts(result);
    };
    void load();
    const unwatch = watchVault(() => void load());
    return () => {
      cancelled = true;
      unwatch();
    };
  }, [lockState]);

  // 倒计时驱动：每秒重算一次 now，让 CodeRow 里的 Ring 跟着刷新
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // 拿当前 tab 的 host
  useEffect(() => {
    let cancelled = false;
    void browser.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then((tabs) => {
        if (cancelled) return;
        const url = tabs[0]?.url;
        try {
          const host = url ? new URL(url).host : '';
          setCurrentHost(host || null);
        } catch {
          setCurrentHost(null);
        }
      })
      .catch(() => {
        if (!cancelled) setCurrentHost(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopy = useCallback(async (account: Account): Promise<CopyResult> => {
    const { code } = await import('@/lib/totp').then((m) =>
      m.generateCode(account, Date.now()),
    );

    // 1) 优先尝试直接填到当前 tab 上次聚焦的 OTP 输入框
    try {
      const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (tab?.id) {
        const res = (await browser.tabs.sendMessage(tab.id, {
          type: 'otpfill:fill',
          accountId: account.id,
        })) as { ok?: boolean; error?: string } | undefined;
        if (res?.ok) return 'filled';
      }
    } catch {
      // content script 没装、tab 不是 http(s)、权限被拒等都到这里
    }

    // 2) 兜底：复制到剪贴板
    try {
      await navigator.clipboard.writeText(code);
      return 'copied';
    } catch {
      return 'failed';
    }
  }, []);

  const handleDelete = useCallback(async (account: Account) => {
    await vault.remove(account.id);
  }, []);

  const handleBindDomain = useCallback(
    async (account: Account, domain: string) => {
      if (account.domains.includes(domain)) return;
      await vault.update(account.id, { domains: [...account.domains, domain] });
    },
    [],
  );

  const handleUnbindDomain = useCallback(
    async (account: Account, domain: string) => {
      await vault.update(account.id, {
        domains: account.domains.filter((d) => d !== domain),
      });
    },
    [],
  );

  const handleScan = useCallback(async () => {
    setScanStatus({ kind: 'working', phase: '框选二维码…' });
    try {
      const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (!tab?.id || tab.windowId === undefined) {
        throw new Error('popup 找不到当前标签页');
      }
      const res = browser.runtime.sendMessage({
        type: 'm2-scan-qr',
        tabId: tab.id,
        windowId: tab.windowId,
      });
      void res;
      window.close();
    } catch (err) {
      setScanStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      window.setTimeout(() => setScanStatus({ kind: 'idle' }), 1500);
    }
  }, []);

  const handleAddSave = useCallback(
    async (draft: { issuer: string; label: string; secret: string }) => {
      // unlocked 态：先把明文 secret 加密成 enc1: 再入库
      // plaintext 态：直接写明文（现状）
      let secret = draft.secret;
      if (lockState === 'unlocked') {
        const key = await getDerivedKey();
        if (key) secret = await migrateSecret(secret, key);
      }
      await vault.add({
        algorithm: 'SHA1' as const,
        digits: 6,
        period: 30,
        ...draft,
        secret,
      });
      setAddOpen(false);
    },
    [lockState],
  );

  const scanning = scanStatus.kind === 'working';

  /**
   * 搜索 + 域名命中混合排序：
   *  - query 非空：只过滤，不做域名置顶（用户既然在搜，就按搜索结果顺序）
   *  - query 空：命中当前 host 的账号提到顶部
   */
  const visibleAccounts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? accounts.filter((a) => {
          const issuer = a.issuer.toLowerCase();
          const label = a.label.toLowerCase();
          return issuer.includes(q) || label.includes(q);
        })
      : accounts;

    if (q || !currentHost) return filtered;

    const hit: Account[] = [];
    const rest: Account[] = [];
    for (const a of filtered) {
      if (anyMatch(currentHost, a.domains).hit) hit.push(a);
      else rest.push(a);
    }
    return [...hit, ...rest];
  }, [accounts, currentHost, query]);

  // loading 态：runtime 还没装完，避免渲染主界面出现 codes 抖动
  if (lockState === 'loading') {
    return <div className={styles.root} aria-busy="true" />;
  }

  // locked 态用 UnlockScreen 占满整个 popup —— 没有列表、没有 footer、
  // 没有 AddDialog，避免在「看不到 codes」的情况下还显示空账号占位
  if (lockState === 'locked') {
    return (
      <div className={styles.root}>
        <UnlockScreen
          onSubmit={lockUnlock}
          onUnlocked={() => setLockState('unlocked')}
        />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <Header />
      <SearchBar
        value={query}
        onChange={setQuery}
        totalCount={accounts.length}
        matchedCount={visibleAccounts.length}
      />

      <div className={styles.list} role="list">
        {visibleAccounts.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>
              {query ? t('popupSearchEmpty') : t('popupEmpty')}
            </p>
            <p className={styles.emptyHint}>
              {query ? t('popupSearchEmptyHint', query) : t('popupEmptyHint')}
            </p>
          </div>
        ) : (
          visibleAccounts.map((account) => (
            <CodeRow
              key={account.id}
              account={account}
              now={now}
              currentHost={currentHost}
              onCopy={handleCopy}
              onDelete={handleDelete}
              onBindDomain={(a, d) => void handleBindDomain(a, d)}
              onUnbindDomain={(a, d) => void handleUnbindDomain(a, d)}
            />
          ))
        )}
      </div>

      {scanStatus.kind === 'error' && (
        <div className={styles.banner} role="alert">
          {scanStatus.message}
        </div>
      )}

      <Footer
        scanning={scanning}
        scanStatus={scanStatus}
        onScan={() => void handleScan()}
        onManualAdd={() => setAddOpen(true)}
      />

      <AddDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSave={handleAddSave}
      />
    </div>
  );
}

function Header() {
  return (
    <header className={styles.header}>
      <img
        className={styles.logo}
        src={browser.runtime.getURL('/icon/48.png')}
        alt=""
        width={22}
        height={22}
      />
      <span className={styles.title}>{t('extName')}</span>
      <button
        className={styles.iconButton}
        title={t('actionSettings')}
        onClick={() => browser.runtime.openOptionsPage()}
      >
        <GearIcon />
      </button>
    </header>
  );
}

/**
 * 搜索框。打开 popup 时自动 focus，让用户直接打字查找。
 */
function SearchBar({
  value,
  onChange,
  totalCount,
  matchedCount,
}: {
  value: string;
  onChange: (v: string) => void;
  totalCount: number;
  matchedCount: number;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // popup 一打开就 focus —— 用户最常见的动作是「直接打几个字找第一个」
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className={styles.searchWrap}>
      <span className={styles.searchIcon} aria-hidden>
        <SearchIcon />
      </span>
      <input
        ref={ref}
        type="search"
        className={styles.searchInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('popupSearchPlaceholder')}
        // Esc 清空 —— 跟浮层 Esc 关掉的语义一致
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
          }
        }}
        spellCheck={false}
        autoComplete="off"
      />
      {value && (
        <span className={styles.searchCount}>
          {matchedCount}/{totalCount}
        </span>
      )}
    </div>
  );
}

interface FooterProps {
  scanning: boolean;
  scanStatus: ScanStatus;
  onScan: () => void;
  onManualAdd: () => void;
}

function Footer({ scanning, scanStatus, onScan, onManualAdd }: FooterProps) {
  return (
    <footer className={styles.footer}>
      <button
        className={styles.primary}
        onClick={onScan}
        disabled={scanning}
      >
        <QrIcon />
        <span>
          {scanStatus.kind === 'working'
            ? scanStatus.phase
            : t('actionScanQr')}
        </span>
      </button>
      <button className={styles.secondary} onClick={onManualAdd} disabled={scanning}>
        <KeyboardIcon />
        <span>{t('actionManualAdd')}</span>
      </button>
    </footer>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M13 8c0-.3 0-.6-.1-.9l1.2-.9-1.3-2.2-1.4.5c-.5-.4-1-.7-1.5-.9L9.7 2H6.3l-.2 1.6c-.6.2-1.1.5-1.5.9l-1.4-.5-1.3 2.2 1.2.9a5.4 5.4 0 0 0 0 1.8l-1.2.9 1.3 2.2 1.4-.5c.4.4 1 .7 1.5.9l.2 1.6h3.4l.2-1.6c.6-.2 1.1-.5 1.5-.9l1.4.5 1.3-2.2-1.2-.9c.1-.3.1-.6.1-.9Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ScanStatus {
  kind: 'idle' | 'working' | 'done' | 'error';
  phase?: string;
  message?: string;
}