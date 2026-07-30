import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '@/lib/i18n';
import { vault, watchVault } from '@/lib/storage';
import type { Account } from '@/lib/model';
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

  const handleCopy = useCallback(async (account: Account) => {
    const { code } = await import('@/lib/totp').then((m) =>
      m.generateCode(account, Date.now()),
    );
    // navigator.clipboard 在 popup 上下文里需要 focus —— popup 默认 focused，
    // 通常没问题。极少数场景下（用户刚切回 popup 的瞬间）可能失败，
    // 但用户能看到复制状态会恢复。
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // 静默：M7 里会改成先尝试填充，clipboard 是兜底。
    }
  }, []);

  const handleDelete = useCallback(async (account: Account) => {
    await vault.remove(account.id);
  }, []);

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
    setScanStatus({ kind: 'working', phase: '截屏并解码…' });
    try {
      const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (!tab?.id || tab.windowId === undefined) {
        throw new Error('popup 找不到当前标签页');
      }
      const res = await browser.runtime.sendMessage({
        type: 'm2-scan-qr',
        tabId: tab.id,
        windowId: tab.windowId,
      });
      const r = res as ScanResult | undefined;
      if (!r) throw new Error('后台无响应');
      if (r.error) throw new Error(r.error);
      const text = r.text;
      if (!text) throw new Error('没找到二维码');
      // QR 解出来了 — M5 会把这段接成产品化的确认卡片，
      // 这里先直接入库（M4 验证链路用）
      const parsed = await import('@/lib/totp').then((m) => m.parseOtpauthUri(text));
      await vault.add(parsed);
      setScanStatus({ kind: 'done' });
    } catch (err) {
      setScanStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // 1.5 秒后把扫描状态清掉，恢复按钮
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

  return (
    <div className={styles.root}>
      <Header />

      <div className={styles.list} role="list">
        {accounts.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{t('popupEmpty')}</p>
            <p className={styles.emptyHint}>{t('popupEmptyHint')}</p>
          </div>
        ) : (
          accounts.map((account, i) => (
            <CodeRow
              key={account.id}
              account={account}
              now={now}
              isFirst={i === 0}
              isLast={i === accounts.length - 1}
              onCopy={handleCopy}
              onDelete={handleDelete}
              onMoveUp={(a) => void handleMove(a, 'up')}
              onMoveDown={(a) => void handleMove(a, 'down')}
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

interface ScanResult {
  text: string | null;
  captureWidth?: number;
  captureHeight?: number;
  error?: string;
}