/**
 * 设置页 · 安全 section。
 *
 * 四种操作：
 *   - 明文 → 启用主密码加密（输两次密码 → setupEncryption）
 *   - 已解锁 → 立即锁定 / 修改密码 / 关闭加密
 *   - 已锁定 → 提示去 popup 解锁（不展示可改密的入口，避免误操作）
 *   - 任意状态 → 改自动锁超时（lockMinutes）
 *
 * 设计：所有交互都内联展开（启用 / 修改 / 关闭），不弹模态。简单粗暴，
 * 设置页本来就只是偶尔来一次。
 */

import { useCallback, useState } from 'react';
import { t } from '@/lib/i18n';
import {
  setupEncryption,
  changePassword,
  disableEncryption,
  type LockState,
} from '@/lib/lock';
import styles from './App.module.css';

interface SecuritySectionProps {
  lockState: LockState;
  prefs: { lockMinutes: number };
  onLockNow: () => void;
  onPrefsChange: (patch: { lockMinutes?: number }) => void;
}

const AUTO_LOCK_OPTIONS: Array<{ value: number; labelKey: 'optionsAutoLockOption' | 'optionsAutoLockNever' }> = [
  { value: 5, labelKey: 'optionsAutoLockOption' },
  { value: 15, labelKey: 'optionsAutoLockOption' },
  { value: 30, labelKey: 'optionsAutoLockOption' },
  { value: 60, labelKey: 'optionsAutoLockOption' },
  { value: 0, labelKey: 'optionsAutoLockNever' },
];

export function SecuritySection({
  lockState,
  prefs,
  onLockNow,
  onPrefsChange,
}: SecuritySectionProps) {
  const [mode, setMode] = useState<'idle' | 'enable' | 'change' | 'disable'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    setMode('idle');
    setError(null);
  }, []);

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{t('optionsSecurityTitle')}</h2>
      <p className={styles.subtitle}>{t('optionsSecuritySubtitle')}</p>

      {/* 当前状态 */}
      <p className={styles.placeholder}>
        {lockState === 'plaintext' && t('optionsSecurityStatePlaintext')}
        {lockState === 'unlocked' && t('optionsSecurityStateUnlocked')}
        {lockState === 'locked' && t('optionsSecurityStateLocked')}
      </p>

      {/* 自动锁超时 —— 任意状态都可改 */}
      <label className={styles.toggle}>
        <span>{t('optionsAutoLockMinutes')}</span>
        <select
          className={styles.select}
          value={prefs.lockMinutes}
          onChange={(e) => onPrefsChange({ lockMinutes: Number(e.target.value) })}
        >
          {AUTO_LOCK_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.labelKey === 'optionsAutoLockNever'
                ? t(o.labelKey)
                : t(o.labelKey, String(o.value))}
            </option>
          ))}
        </select>
      </label>

      {/* 操作按钮 —— 按状态显示 */}
      {lockState === 'plaintext' && (
        <div className={styles.securityActions}>
          {mode !== 'enable' && (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                setError(null);
                setMode('enable');
              }}
            >
              {t('optionsEnableEncryption')}
            </button>
          )}
          {mode === 'enable' && (
            <EnableForm
              busy={busy}
              error={error}
              onCancel={close}
              onSubmit={async (pw) => {
                setBusy(true);
                setError(null);
                try {
                  await setupEncryption(pw);
                  setMode('idle');
                } catch (e) {
                  setError(t('optionsEncryptionFailed', e instanceof Error ? e.message : String(e)));
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}
        </div>
      )}

      {lockState === 'unlocked' && (
        <div className={styles.securityActions}>
          {mode === 'idle' && (
            <>
              <button type="button" className={styles.secondaryButton} onClick={onLockNow}>
                {t('optionsLockNow')}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  setError(null);
                  setMode('change');
                }}
              >
                {t('optionsChangePassword')}
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => {
                  setError(null);
                  setMode('disable');
                }}
              >
                {t('optionsDisableEncryption')}
              </button>
            </>
          )}
          {mode === 'change' && (
            <ChangeForm
              busy={busy}
              error={error}
              onCancel={close}
              onSubmit={async (oldPw, newPw) => {
                setBusy(true);
                setError(null);
                const ok = await changePassword(oldPw, newPw);
                setBusy(false);
                if (!ok) {
                  setError(t('optionsWrongPassword'));
                  return;
                }
                setMode('idle');
              }}
            />
          )}
          {mode === 'disable' && (
            <DisableForm
              busy={busy}
              error={error}
              onCancel={close}
              onSubmit={async (pw) => {
                setBusy(true);
                setError(null);
                const ok = await disableEncryption(pw);
                setBusy(false);
                if (!ok) {
                  setError(t('optionsWrongPassword'));
                  return;
                }
                setMode('idle');
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 子表单

function EnableForm({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (pw: string) => Promise<void>;
}) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && pw !== confirm;

  const submit = async () => {
    if (!pw || mismatch || busy) return;
    await onSubmit(pw);
    setPw('');
    setConfirm('');
  };

  return (
    <form
      className={styles.securityForm}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        type="password"
        className={styles.addHostInput}
        placeholder={t('optionsNewPassword')}
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        autoComplete="new-password"
        disabled={busy}
        spellCheck={false}
      />
      <input
        type="password"
        className={styles.addHostInput}
        placeholder={t('optionsConfirmPassword')}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        disabled={busy}
        spellCheck={false}
      />
      {mismatch && <div className={styles.formError}>{t('optionsPasswordMismatch')}</div>}
      {error && <div className={styles.formError}>{error}</div>}
      <div className={styles.formActions}>
        <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>
          {t('addDialogCancel')}
        </button>
        <button
          type="submit"
          className={styles.primaryButton}
          disabled={!pw || mismatch || busy}
        >
          {t('optionsEnableEncryption')}
        </button>
      </div>
    </form>
  );
}

function ChangeForm({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (oldPw: string, newPw: string) => Promise<void>;
}) {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && newPw !== confirm;

  return (
    <form
      className={styles.securityForm}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!oldPw || !newPw || mismatch || busy) return;
        await onSubmit(oldPw, newPw);
        setOldPw('');
        setNewPw('');
        setConfirm('');
      }}
    >
      <input
        type="password"
        className={styles.addHostInput}
        placeholder={t('optionsCurrentPassword')}
        value={oldPw}
        onChange={(e) => setOldPw(e.target.value)}
        autoComplete="current-password"
        disabled={busy}
        spellCheck={false}
      />
      <input
        type="password"
        className={styles.addHostInput}
        placeholder={t('optionsNewPassword')}
        value={newPw}
        onChange={(e) => setNewPw(e.target.value)}
        autoComplete="new-password"
        disabled={busy}
        spellCheck={false}
      />
      <input
        type="password"
        className={styles.addHostInput}
        placeholder={t('optionsConfirmPassword')}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        disabled={busy}
        spellCheck={false}
      />
      {mismatch && <div className={styles.formError}>{t('optionsPasswordMismatch')}</div>}
      {error && <div className={styles.formError}>{error}</div>}
      <div className={styles.formActions}>
        <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>
          {t('addDialogCancel')}
        </button>
        <button
          type="submit"
          className={styles.primaryButton}
          disabled={!oldPw || !newPw || mismatch || busy}
        >
          {t('optionsChangePassword')}
        </button>
      </div>
    </form>
  );
}

function DisableForm({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (pw: string) => Promise<void>;
}) {
  const [pw, setPw] = useState('');

  return (
    <form
      className={styles.securityForm}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!pw || busy) return;
        await onSubmit(pw);
        setPw('');
      }}
    >
      <input
        type="password"
        className={styles.addHostInput}
        placeholder={t('optionsCurrentPassword')}
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        autoComplete="current-password"
        disabled={busy}
        spellCheck={false}
      />
      {error && <div className={styles.formError}>{error}</div>}
      <div className={styles.formActions}>
        <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>
          {t('addDialogCancel')}
        </button>
        <button
          type="submit"
          className={styles.dangerButton}
          disabled={!pw || busy}
        >
          {t('optionsDisableEncryption')}
        </button>
      </div>
    </form>
  );
}