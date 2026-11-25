import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import type { Account } from '@/lib/model';
import { buildOtpauthUri } from '@/lib/otpauth-uri';
import { buildQrMatrix, qrMatrixToPath, QR_QUIET_ZONE } from '@/lib/qr';
import { CloseIcon } from './Icon';
import styles from './QrModal.module.css';

/**
 * 二维码弹窗：把这个账号的 otpauth:// 链接变成二维码，方便用别的验证器
 * （Google Authenticator、1Password 等）扫码接手。
 *
 * 之所以放在 popup 里而不是单独开页：
 * - popup 关掉就没了，独立页得自己记地址
 * - 内容不大，220px 左右的二维码手机扫得动
 *
 * 弹窗里同时给出「复制密钥」和「复制链接」两个按钮：
 * - 复制密钥 → Base32 那一串，粘进 Google Authenticator 的「手动输入密钥」框
 * - 复制链接 → 整条 otpauth:// 链接，粘进支持链接导入的验证器（1Password 等）
 *
 * Esc / 点遮罩关闭；锁定态根本到不了这里（popup 在锁定时只渲染 UnlockScreen）。
 */
export interface QrModalProps {
  account: Account;
  onClose: () => void;
}

export function QrModal({ account, onClose }: QrModalProps) {
  const [copied, setCopied] = useState<'secret' | 'link' | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const uri = useMemo(() => buildOtpauthUri(account), [account]);
  const matrix = useMemo(() => (uri ? buildQrMatrix(uri) : null), [uri]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Esc 关闭。放在 capture 阶段，避免被输入框之类的先截走。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // 复制成功的提示 1.2 秒后自动消失
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(null), 1200);
    return () => window.clearTimeout(id);
  }, [copied]);

  const copy = async (what: 'secret' | 'link', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  };

  const title = account.issuer || account.label;
  const sub = account.issuer && account.label ? account.label : '';

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={t('qrTitle')}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <div className={styles.titleBox}>
            <span className={styles.title}>{title}</span>
            {sub && <span className={styles.sub}>{sub}</span>}
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            onClick={onClose}
            title={t('qrClose')}
            aria-label={t('qrClose')}
          >
            <CloseIcon size={14} />
          </button>
        </div>

        {matrix && uri ? (
          <>
            <div className={styles.qrWrap}>
              <svg
                className={styles.qr}
                viewBox={`-${QR_QUIET_ZONE} -${QR_QUIET_ZONE} ${matrix.size + QR_QUIET_ZONE * 2} ${matrix.size + QR_QUIET_ZONE * 2}`}
                shapeRendering="crispEdges"
                role="img"
                aria-label={t('qrTitle')}
              >
                <rect
                  className={styles.qrBg}
                  x={`-${QR_QUIET_ZONE}`}
                  y={`-${QR_QUIET_ZONE}`}
                  width={matrix.size + QR_QUIET_ZONE * 2}
                  height={matrix.size + QR_QUIET_ZONE * 2}
                />
                <path className={styles.qrFg} d={qrMatrixToPath(matrix)} />
              </svg>
            </div>

            <div className={styles.field}>
              <div className={styles.fieldLabel}>{t('qrSecretLabel')}</div>
              <code className={styles.fieldValue}>{account.secret}</code>
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => void copy('secret', account.secret)}
              >
                {t('qrCopySecret')}
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => void copy('link', uri)}
              >
                {t('qrCopyLink')}
              </button>
            </div>

            {copied && (
              <div className={styles.toast} role="status">
                {copied === 'secret' ? t('qrCopiedSecret') : t('qrCopiedLink')}
              </div>
            )}
          </>
        ) : (
          <p className={styles.error}>{t('qrFailed')}</p>
        )}
      </div>
    </div>
  );
}
