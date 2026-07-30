import { t } from '@/lib/i18n';
import { browser } from 'wxt/browser';
import styles from './App.module.css';

export default function App() {
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
        <p className={styles.emptyTitle}>{t('popupEmpty')}</p>
        <p className={styles.emptyHint}>{t('popupEmptyHint')}</p>
      </div>

      <footer className={styles.footer}>
        <button className={styles.primary} disabled>
          {t('actionScanQr')}
        </button>
        <button className={styles.secondary} disabled>
          {t('actionManualAdd')}
        </button>
      </footer>
    </div>
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
