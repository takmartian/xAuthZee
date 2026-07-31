/**
 * popup 锁闸门。
 *
 * 当 lockState === 'locked' 时替代整个 popup 内容：密码输入框 +
 * 解锁按钮 + 错误提示。解锁成功由父组件通过 onUnlocked 回调刷新
 * 锁状态后切换回主界面。
 *
 * 设计上让组件自己处理「提交中」「错密码」「空密码」三种 UI 状态，
 * 父组件只需要提供 onSubmit 回调（密码正确 → onUnlocked；错 → 组
 * 件显示错误，不动 lockState）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import styles from './UnlockScreen.module.css';

export interface UnlockScreenProps {
  /** 提交密码。返回 true 表示解锁成功，false 表示密码错。 */
  onSubmit: (password: string) => Promise<boolean>;
  /** 解锁成功后通知父组件切换到主界面 */
  onUnlocked: () => void;
}

export function UnlockScreen({ onSubmit, onUnlocked }: UnlockScreenProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  // 屏幕打开时自动 focus —— 用户最常见的动作是直接打字
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (submitting || !password) return;
      setSubmitting(true);
      setError(null);
      const ok = await onSubmit(password);
      setSubmitting(false);
      if (ok) {
        onUnlocked();
        // 不清空 password —— onUnlocked 会切走整个屏幕
      } else {
        setError(t('unlockWrongPassword'));
        setPassword('');
        ref.current?.focus();
      }
    },
    [password, submitting, onSubmit, onUnlocked],
  );

  return (
    <div className={styles.root}>
      <div className={styles.iconWrap} aria-hidden>
        <LockIcon />
      </div>
      <h2 className={styles.title}>{t('unlockTitle')}</h2>
      <p className={styles.subtitle}>{t('unlockSubtitle')}</p>

      <form className={styles.form} onSubmit={handleSubmit}>
        <input
          ref={ref}
          type="password"
          className={styles.input}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError(null);
          }}
          placeholder={t('unlockPlaceholder')}
          spellCheck={false}
          autoComplete="current-password"
          disabled={submitting}
          aria-invalid={!!error}
        />

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        <button
          type="submit"
          className={styles.submit}
          disabled={submitting || !password}
        >
          {submitting ? t('unlockSubmitting') : t('unlockSubmit')}
        </button>

        <p className={styles.hint}>
          {t('unlockForgotHint')}
        </p>
      </form>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect
        x="6"
        y="14"
        width="20"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M10 14V9a6 6 0 0 1 12 0v5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="16" cy="21" r="1.6" fill="currentColor" />
      <path d="M16 22.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}