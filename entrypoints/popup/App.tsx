import { useState } from 'react';
import { t } from '@/lib/i18n';
import { browser } from 'wxt/browser';
import styles from './App.module.css';

/**
 * M2 阶段：极简 popup，只为了打通「点扫描 → 截屏 → 解码」链路。
 * 真正的列表 UI 与倒计时环放在 M4。
 */
export default function App() {
  const [status, setStatus] = useState<ScanStatus>({ kind: 'idle' });

  async function onScan() {
    setStatus({ kind: 'working', phase: '截屏并解码…' });
    try {
      const res = await browser.runtime.sendMessage({ type: 'm2-scan-qr' });
      const r = res as ScanResult | undefined;
      if (!r) {
        setStatus({ kind: 'error', message: '后台无响应' });
        return;
      }
      if (r.error) {
        setStatus({ kind: 'error', message: r.error });
        return;
      }
      setStatus({
        kind: 'done',
        text: r.text,
        captureWidth: r.captureWidth,
        captureHeight: r.captureHeight,
      });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className={styles.root}>
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

      <div className={styles.empty}>
        {status.kind === 'idle' && (
          <>
            <p className={styles.emptyTitle}>{t('popupEmpty')}</p>
            <p className={styles.emptyHint}>{t('popupEmptyHint')}</p>
          </>
        )}
        {status.kind === 'working' && (
          <p className={styles.emptyTitle}>{status.phase}</p>
        )}
        {status.kind === 'done' && (
          <div className={styles.result}>
            {status.text ? (
              <>
                <p className={styles.resultLabel}>解码结果</p>
                <code className={styles.resultText}>{status.text}</code>
                {status.captureWidth && (
                  <p className={styles.resultMeta}>
                    截屏 {status.captureWidth} × {status.captureHeight}
                  </p>
                )}
              </>
            ) : (
              <p className={styles.emptyTitle}>没找到二维码</p>
            )}
          </div>
        )}
        {status.kind === 'error' && (
          <p className={styles.emptyTitle} style={{ color: 'var(--xz-danger)' }}>
            {status.message}
          </p>
        )}
      </div>

      <footer className={styles.footer}>
        <button className={styles.primary} onClick={onScan} disabled={status.kind === 'working'}>
          {t('actionScanQr')}
        </button>
        <button className={styles.secondary} disabled>
          {t('actionManualAdd')}
        </button>
      </footer>
    </div>
  );
}

interface ScanStatus {
  kind: 'idle' | 'working' | 'done' | 'error';
  phase?: string;
  text?: string | null;
  message?: string;
  captureWidth?: number;
  captureHeight?: number;
}

interface ScanResult {
  text: string | null;
  captureWidth?: number;
  captureHeight?: number;
  error?: string;
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