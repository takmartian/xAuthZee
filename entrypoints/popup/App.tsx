import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '@/lib/i18n';
import { vault, watchVault } from '@/lib/storage';
import type { Account } from '@/lib/model';
import { anyMatch } from '@/lib/domain';
import { CodeRow } from '@/components/CodeRow';
import { AddDialog } from '@/components/AddDialog';
import { QrIcon, KeyboardIcon } from '@/components/Icon';
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
 * 3. 点击行复制到剪贴板。fill 到当前标签页的输入框（M7）做完后再
 *    升级为「先尝试填充，失败回退到复制」。
 *
 * 4. 重排序目前用上下箭头按钮。拖拽是更好的 UX，但 M5 把框选 UI
 *    做完之后再统一处理这块 —— 一致性比零散优化更重要。
 */
export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus>({ kind: 'idle' });
  // 当前标签页的 host，给菜单里「绑定当前网站」用。null 表示没有
  // （比如 popup 是从 action 菜单里打开的，没有具体 tab）。
  const [currentHost, setCurrentHost] = useState<string | null>(null);

  // 初次加载 + 监听跨设备 / 跨 popup 的变更
  useEffect(() => {
    let cancelled = false;
    void vault.list().then((list) => {
      if (!cancelled) setAccounts(list);
    });
    const unwatch = watchVault(() => {
      void vault.list().then((list) => {
        if (!cancelled) setAccounts(list);
      });
    });
    return () => {
      cancelled = true;
      unwatch();
    };
  }, []);

  // 倒计时驱动：每秒重算一次 now，让 CodeRow 里的 Ring 跟着刷新
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // 拿当前 tab 的 host，给 CodeRow 的「绑定当前网站」菜单用
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

  const handleCopy = useCallback(async (account: Account) => {
    const { code } = await import('@/lib/totp').then((m) =>
      m.generateCode(account, Date.now()),
    );

    // 1) 优先尝试直接填到当前 tab 上次聚焦的 OTP 输入框
    let filled = false;
    try {
      const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (tab?.id) {
        const res = (await browser.tabs.sendMessage(tab.id, {
          type: 'otpfill:fill',
          accountId: account.id,
        })) as { ok?: boolean; error?: string } | undefined;
        if (res?.ok) filled = true;
      }
    } catch {
      // content script 没装、tab 不是 http(s)、权限被拒等都到这里
    }

    if (filled) return;

    // 2) 兜底：复制到剪贴板。navigator.clipboard 在 popup 上下文里需要
    //    focus，少数场景下（刚切回 popup 的瞬间）可能失败 —— 静默。
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* 静默 */
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

  const handleMove = useCallback(
    async (account: Account, direction: 'up' | 'down') => {
      const ids = accounts.map((a) => a.id);
      const i = ids.indexOf(account.id);
      if (i < 0) return;
      const j = direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      const a = ids[i]!;
      const b = ids[j]!;
      ids[i] = b;
      ids[j] = a;
      await vault.reorder(ids);
    },
    [accounts],
  );

  const handleScan = useCallback(async () => {
    setScanStatus({ kind: 'working', phase: '框选二维码…' });
    try {
      const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (!tab?.id || tab.windowId === undefined) {
        throw new Error('popup 找不到当前标签页');
      }
      // 先发请求，再立刻关掉 popup —— 整个扫描流程由 content script 接管，
      // 用户在页面里框选就行。popup 关掉后 activeTab 权限仍然有效，
      // captureVisibleTab 也能照常工作。
      const res = browser.runtime.sendMessage({
        type: 'm2-scan-qr',
        tabId: tab.id,
        windowId: tab.windowId,
      });
      void res; // 不等响应 —— 关 popup
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
      await vault.add({
        algorithm: 'SHA1' as const,
        digits: 6,
        period: 30,
        ...draft,
      });
      setAddOpen(false);
    },
    [],
  );

  const scanning = scanStatus.kind === 'working';

  /**
   * 把命中当前 host 的账号提到顶部，其余保持 index 原顺序。
   * 这里不复用 vault.reorder —— 那会持久化到 storage.sync，对一个
   * 临时视图排序来说代价太高。viewed 顺序只在这一份 accounts 上生效。
   */
  const sortedAccounts = useMemo(() => {
    if (!currentHost) return accounts;
    const hit: Account[] = [];
    const rest: Account[] = [];
    for (const a of accounts) {
      if (anyMatch(currentHost, a.domains).hit) hit.push(a);
      else rest.push(a);
    }
    return [...hit, ...rest];
  }, [accounts, currentHost]);

  return (
    <div className={styles.root}>
      <Header />

      <div className={styles.list} role="list">
        {sortedAccounts.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{t('popupEmpty')}</p>
            <p className={styles.emptyHint}>{t('popupEmptyHint')}</p>
          </div>
        ) : (
          sortedAccounts.map((account, i) => (
            <CodeRow
              key={account.id}
              account={account}
              now={now}
              isFirst={i === 0}
              isLast={i === sortedAccounts.length - 1}
              currentHost={currentHost}
              onCopy={handleCopy}
              onDelete={handleDelete}
              onMoveUp={(a) => void handleMove(a, 'up')}
              onMoveDown={(a) => void handleMove(a, 'down')}
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

interface FooterProps {
  scanning: boolean;
  scanStatus: ScanStatus;
  onScan: () => void;
  onManualAdd: () => void;
}

function Footer({ scanning, scanStatus, onScan, onManualAdd }: FooterProps) {
  const scanningRef = useRef<HTMLDivElement>(null);

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
      <div ref={scanningRef} className={styles.footerSentinel} aria-hidden />
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