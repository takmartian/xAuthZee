import { useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { ValidationError, normalizeSecret, dedupeDomains } from '@/lib/model';
import { draftFromSecret } from '@/lib/totp';
import { CloseIcon } from './Icon';
import styles from './AddDialog.module.css';

interface AddDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (draft: {
    issuer: string;
    label: string;
    secret: string;
  }) => Promise<void>;
}

function describeError(code: ValidationError['code']): string {
  switch (code) {
    case 'secret_empty':
      return t('errSecretEmpty');
    case 'secret_charset':
      return t('errSecretCharset');
    case 'secret_too_short':
      return t('errSecretTooShort');
    case 'label_empty':
      return t('errLabelEmpty');
    default:
      return t('errUnknown') + code;
  }
}

export function AddDialog({ open, onClose, onSave }: AddDialogProps) {
  const [issuer, setIssuer] = useState('');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  // 打开时把焦点放到第一个字段，并把上次的值清空
  useEffect(() => {
    if (!open) return;
    setIssuer('');
    setLabel('');
    setSecret('');
    setError(null);
    setSaving(false);
    // 等动画下一帧再聚焦
    const id = window.setTimeout(() => firstField.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  // Esc 关闭，Cmd/Ctrl+Enter 提交
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // 在保存之前做一次完整校验，错误直接显示。
    // vault.add() 也会校验，但错误信息更接近用户输入，
    // 在 UI 层先校验能给用户更短的反馈链路。
    try {
      const draft = draftFromSecret({
        issuer: issuer.trim(),
        label: label.trim(),
        secret,
      });
      if (!draft.issuer && !draft.label) {
        throw new ValidationError('label_empty');
      }
      setSaving(true);
      await onSave({
        issuer: draft.issuer,
        label: draft.label,
        secret: draft.secret,
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        setError(describeError(err.code));
      } else {
        // normalizeSecret 在 raw 为空时也是抛 ValidationError('secret_empty')，
        // 这里兜住真正的意外异常（比如存储写入失败）
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  };

  // 兼容 TypeScript strict：normalizeSecret 在 dialog 里其实只是被校验，
  // 真正的归一化在 vault.add() 里。这里调用一下是为了触发同样的错误码。
  void normalizeSecret;
  void dedupeDomains;

  return (
    <div
      className={styles.scrim}
      onClick={(e) => {
        // 点遮罩本身（不是内容）才关闭
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('addDialogTitle')}
    >
      <form className={styles.panel} onSubmit={handleSubmit}>
        <header className={styles.header}>
          <h2 className={styles.title}>{t('addDialogTitle')}</h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label={t('addDialogCancel')}
            tabIndex={-1}
          >
            <CloseIcon />
          </button>
        </header>

        <div className={styles.body}>
          <label className={styles.field}>
            <span className={styles.label}>{t('addDialogIssuer')}</span>
            <input
              ref={firstField}
              type="text"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder={t('addDialogIssuerHint')}
              className={styles.input}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{t('addDialogLabel')}</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('addDialogLabelHint')}
              className={styles.input}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{t('addDialogSecret')}</span>
            <textarea
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={t('addDialogSecretHint')}
              className={styles.textarea}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              rows={2}
            />
          </label>

          {error && <div className={styles.error}>{error}</div>}
        </div>

        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.secondary}
            onClick={onClose}
            disabled={saving}
          >
            {t('addDialogCancel')}
          </button>
          <button
            type="submit"
            className={styles.primary}
            disabled={saving || !secret}
          >
            {saving ? t('addDialogSaving') : t('addDialogSave')}
          </button>
        </footer>
      </form>
    </div>
  );
}