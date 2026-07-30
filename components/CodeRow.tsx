import { memo, useState } from 'react';
import { t } from '@/lib/i18n';
import type { Account } from '@/lib/model';
import { generateCode, groupCode } from '@/lib/totp';
import { Ring } from './Ring';
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from './Icon';
import styles from './CodeRow.module.css';

export interface CodeRowProps {
  account: Account;
  /** 当前时间（毫秒），由父组件每帧重算并传入 —— 倒计时环靠这个更新 */
  now: number;
  /** 是否当前 popup 第一个条目（在某些 UI 里用于去边角） */
  isFirst: boolean;
  isLast: boolean;
  onCopy: (account: Account) => void;
  onDelete: (account: Account) => void;
  onMoveUp: (account: Account) => void;
  onMoveDown: (account: Account) => void;
}

function CodeRowInner({
  account,
  now,
  isFirst,
  isLast,
  onCopy,
  onDelete,
  onMoveUp,
  onMoveDown,
}: CodeRowProps) {
  const [copied, setCopied] = useState(false);

  const { code, progress, secondsRemaining } = generateCode(account, now);
  // 周期即将结束时给个明显颜色提示 —— TOTP 倒计时环通常用红色
  const expiring = secondsRemaining <= 3;

  const handleClick = () => {
    onCopy(account);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  // 排版规则：issuer 作粗体标题，label 作灰色副标。
  // 两者都有时不要写成 "GitHub (rex@ex.com)" + "rex@ex.com" ——
  // 那样 label 出现两次，视觉冗余。
  // 如果只有 label 没有 issuer，就把 label 当标题，避免出现完全空白的行。
  const title = account.issuer || account.label;
  const sub = account.issuer && account.label ? account.label : '';

  return (
    <div className={styles.row}>
      <button
        type="button"
        className={styles.codeButton}
        onClick={handleClick}
        title={t('rowClickToFill')}
      >
        <div className={styles.head}>
          <span className={styles.title} title={title}>
            {title}
          </span>
          {sub && <span className={styles.sub}>{sub}</span>}
        </div>

        <div className={styles.body}>
          <span
            className={styles.code}
            style={expiring ? { color: 'var(--xz-danger)' } : undefined}
          >
            {groupCode(code)}
          </span>
          <div className={styles.ringWrap}>
            <Ring
              progress={progress}
              size={22}
              strokeWidth={2.4}
              color={expiring ? 'var(--xz-danger)' : 'var(--xz-accent)'}
              label={`${secondsRemaining} 秒`}
            />
            <span className={styles.seconds}>{secondsRemaining}</span>
          </div>
        </div>
      </button>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.iconButton}
          disabled={isFirst}
          onClick={() => onMoveUp(account)}
          title={t('rowReorderUp')}
          aria-label={t('rowReorderUp')}
        >
          <ChevronUpIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          disabled={isLast}
          onClick={() => onMoveDown(account)}
          title={t('rowReorderDown')}
          aria-label={t('rowReorderDown')}
        >
          <ChevronDownIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onDelete(account)}
          title={t('rowDelete')}
          aria-label={t('rowDelete')}
        >
          <TrashIcon />
        </button>
      </div>

      {copied && <div className={styles.copiedToast}>{t('rowCopied')}</div>}
    </div>
  );
}

// memo：避免父组件每秒重渲染时，所有行都被迫重渲染整个 React 树。
// now 变了父组件确实要刷新，但只有变了的那一行应该真的重算 code。
// 父组件用 account.id 作为 key，并把这个 key 放到依赖里 —— React 默认
// 对 props 做浅比较，now 是 number，直接比即可。
export const CodeRow = memo(CodeRowInner);