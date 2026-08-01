/**
 * popup 锁闸门。
 *
 * 当 lockState === 'locked' 时替代整个 popup 内容：密码输入框 +
 * 解锁按钮 + 错误提示。解锁成功由父组件通过 onUnlocked 回调刷新
 * 锁状态后切换回主界面。
 *
 * **M10：5 次错误自动 wipe**。组件维护三个本地状态：
 * - `attempts`：当前已失败次数，用于控制警告行显隐（>=1 才显示）
 * - `resetAt`：窗口归零时间戳（ms）。60s 间隔刷新「将在 X 分钟后重置」
 *   副标题，到了 `now >= resetAt` 就清掉整个 error 行（用户看到红色
 *   消失就知道计数器已归零）
 *
 * 设计上让组件自己处理「提交中」「错密码」「wipe 完成」「counter 归零」
 * 四种 UI 状态，父组件只需要提供 onSubmit 回调（返回 UnlockResult）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import type { UnlockResult } from '@/lib/lock';
import styles from './UnlockScreen.module.css';

export interface UnlockScreenProps {
  /** 提交密码。返回 UnlockResult：ok=true 解锁成功；wiped=true vault 已清空 */
  onSubmit: (password: string) => Promise<UnlockResult>;
  /** 解锁成功 / wipe 后通知父组件切换到主界面（lockState 会变 unlocked 或 plaintext） */
  onUnlocked: () => void;
}

export function UnlockScreen({ onSubmit, onUnlocked }: UnlockScreenProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorSub, setErrorSub] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [resetAt, setResetAt] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // 渲染时的时间戳 —— 60s interval 触发更新用于倒计时文案刷新
  const [, setNowTick] = useState(0);

  // 屏幕打开时自动 focus —— 用户最常见的动作是直接打字
  useEffect(() => {
    ref.current?.focus();
  }, []);

  // 60s 间隔刷新倒计时文案。注意：不复用父组件的 1s tick，避免 60 倍无谓渲染
  useEffect(() => {
    if (resetAt === null) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [resetAt]);

  // 每次渲染时检查窗口是否已归零。归零就清掉整个 error 行（attempts 也清零，
  // 让警告行消失）—— 用户看到红色消失就明白计数器已重置
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (resetAt === null) return;
    if (Date.now() >= resetAt) {
      setError(null);
      setErrorSub(null);
      setResetAt(null);
      setAttempts(0);
    }
  }, [resetAt, error, errorSub]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (submitting || !password) return;
      setSubmitting(true);
      setError(null);
      setErrorSub(null);
      const result = await onSubmit(password);
      setSubmitting(false);
      if (result.ok) {
        onUnlocked();
        // 不清空 password —— onUnlocked 会切走整个屏幕
      } else if (result.wiped) {
        // 5 次错误上限已触发 wipe。展示 wipe 文案 + 切回主界面（此时空）
        setError(t('unlockWiped'));
        setErrorSub(null);
        setAttempts(5);
        onUnlocked();
      } else {
        // 普通错误：显示「还剩 N 次」+ 「将在 X 分钟后重置」
        setError(t('unlockAttemptsLeft', String(result.attemptsLeft ?? 0)));
        setErrorSub(t('unlockAttemptsResetIn', String(Math.ceil(((result.resetAt ?? 0) - Date.now()) / 60_000))));
        setAttempts(5 - (result.attemptsLeft ?? 0));
        setResetAt(result.resetAt ?? null);
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

      {/* 警告行：首次错误后才显示，符合 1Password / Bitwarden 的做法 */}
      {attempts >= 1 && (
        <div className={styles.warn} role="alert">
          {t('unlockWarnHeader')}
        </div>
      )}

      <form className={styles.form} onSubmit={handleSubmit}>
        <input
          ref={ref}
          type="password"
          className={styles.input}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError(null);
            if (errorSub) setErrorSub(null);
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
            {errorSub && <div className={styles.errorSub}>{errorSub}</div>}
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