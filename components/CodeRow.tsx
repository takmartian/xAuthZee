import { memo, useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import type { Account } from '@/lib/model';
import { generateCode, groupCode } from '@/lib/totp';
import { isSharedHost, normalizeHost, registrableDomain } from '@/lib/domain';
import { Ring } from './Ring';
import { MoreIcon } from './Icon';
import styles from './CodeRow.module.css';

/** 行点击结果 —— 决定右上角 toast 显示什么文案 */
export type CopyResult = 'filled' | 'copied' | 'failed';

export interface CodeRowProps {
  account: Account;
  /** 当前时间（毫秒），由父组件每帧重算并传入 —— 倒计时环靠这个更新 */
  now: number;
  /** 当前 tab 的 host，null 表示拿不到（菜单里「绑定当前网站」会变成只读提示） */
  currentHost: string | null;
  onCopy: (account: Account) => Promise<CopyResult>;
  onDelete: (account: Account) => void;
  /** 绑一个域名到账号（追加去重） */
  onBindDomain: (account: Account, domain: string) => void;
  /** 从账号里删一个绑定 */
  onUnbindDomain: (account: Account, domain: string) => void;
}

function CodeRowInner({
  account,
  now,
  currentHost,
  onCopy,
  onDelete,
  onBindDomain,
  onUnbindDomain,
}: CodeRowProps) {
  const [toast, setToast] = useState<'filled' | 'copied' | 'failed' | null>(null);

  const { code, nextCode, progress, secondsRemaining } = generateCode(account, now);
  // 周期即将结束时给个明显颜色提示 —— TOTP 倒计时环通常用红色
  const expiring = secondsRemaining <= 3;

  /**
   * 周期翻转迁移动画：
   *
   * 不靠 `key={code}` 重挂载来触发 CSS 动画 —— 那会让当前码和下一个码同时
   * 重新 fade-in，看起来像「两个码各闪一下」，并没有「下一个码升上来替换
   * 当前码」的视觉。
   *
   * 改用显式状态机：
   *   idle      —— 正常渲染当前码 + 下一个码
   *   flipping  —— 周期刚翻转（约 0.5s 内），同时渲染：
   *               (1) 老的当前码 X：从原位淡出并向上推出
   *               (2) 新的当前码 Y：等于「翻转前的下一个码」，从下一个码
   *                   的位置（slotHeight 之下）升起，落到当前码位置
   *               (3) 新的下一个码 Z：从更下方淡入到下一个码位置
   *   idle 之后自然衔接，因为 Y = 翻转前的 nextCode，用户能直观看到
   *   「Y 是从下方升上来的」。
   */
  const prevCodeRef = useRef(code);
  const [flip, setFlip] = useState<{
    phase: 'idle' | 'flipping';
    oldCurrent: string;
  }>({ phase: 'idle', oldCurrent: code });

  useEffect(() => {
    if (prevCodeRef.current !== code) {
      // 周期翻转。记录下被替换掉的旧值，0.5s 后回到 idle。
      setFlip({ phase: 'flipping', oldCurrent: prevCodeRef.current });
      prevCodeRef.current = code;
      const id = window.setTimeout(() => {
        setFlip((f) => (f.phase === 'flipping' ? { phase: 'idle', oldCurrent: code } : f));
      }, 500);
      return () => window.clearTimeout(id);
    }
  }, [code]);

  const handleClick = async () => {
    const result = await onCopy(account);
    if (result === 'filled') {
      setToast('filled');
    } else if (result === 'copied') {
      setToast('copied');
    } else {
      setToast('failed');
    }
    window.setTimeout(() => setToast(null), 1200);
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
          <div className={styles.codeStack}>
            <div className={styles.codeSlot}>
              {/* idle 时只渲染当前码；flipping 时只渲染正在淡出的旧当前码 */}
              {flip.phase === 'flipping' ? (
                <span
                  key={`leaving-${flip.oldCurrent}`}
                  className={styles.codeLeaving}
                  aria-hidden
                >
                  {groupCode(flip.oldCurrent)}
                </span>
              ) : (
                <span
                  className={styles.code}
                  style={expiring ? { color: 'var(--xz-danger)' } : undefined}
                >
                  {groupCode(code)}
                </span>
              )}
            </div>
            <div className={styles.nextCodeSlot}>
              {flip.phase === 'flipping' ? (
                <span
                  key={`next-${nextCode}`}
                  className={styles.nextCodeEntering}
                  aria-label="next code"
                >
                  {groupCode(nextCode)}
                </span>
              ) : (
                <span className={styles.nextCode} aria-label="next code">
                  {groupCode(nextCode)}
                </span>
              )}
            </div>
            {/* 迁移层：flipping 时把「新的当前码 = 翻转前的 nextCode」从 next slot
                升上来，叠加在 codeSlot 上。绝对定位不会撑高父容器。 */}
            {flip.phase === 'flipping' && (
              <span
                key={`migrating-${code}`}
                className={styles.migratingCode}
                style={expiring ? { color: 'var(--xz-danger)' } : undefined}
              >
                {groupCode(code)}
              </span>
            )}
          </div>
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
        <RowMenu
          account={account}
          currentHost={currentHost}
          onBindDomain={(d) => onBindDomain(account, d)}
          onUnbindDomain={(d) => onUnbindDomain(account, d)}
          onDelete={() => onDelete(account)}
        />
      </div>

      {toast && (
        <div
          className={`${styles.copiedToast} ${
            toast === 'filled'
              ? styles.toastFilled
              : toast === 'failed'
                ? styles.toastFailed
                : ''
          }`}
        >
          {toast === 'filled' && t('rowFilled')}
          {toast === 'copied' && t('rowCopied')}
          {toast === 'failed' && t('rowFailed')}
        </div>
      )}
    </div>
  );
}

/**
 * 行尾「...」菜单。
 *
 * 三个 section（按场景动态生成内容，可能为空）：
 *  1. 当前网站绑定 —— 候选绑定项 + 解绑当前 host（如果有）
 *  2. 其他已绑域名 —— 该账号绑过的、不在当前 host 的其它域名
 *  3. 账号操作 —— 删除账号（危险操作）
 *
 * mousedown 拦截，避免菜单点开后点击事件穿透关闭菜单。
 */
function RowMenu({
  account,
  currentHost,
  onBindDomain,
  onUnbindDomain,
  onDelete,
}: {
  account: Account;
  currentHost: string | null;
  onBindDomain: (domain: string) => void;
  onUnbindDomain: (domain: string) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击外面或 Esc 关闭菜单
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const host = currentHost ? normalizeHost(currentHost) : '';
  const registrable = host ? registrableDomain(host) : '';
  // 共享域名（octocat.github.io）：精确匹配 + registrable 退回精确
  const shared = host ? isSharedHost(host) : false;
  const exactBound = host;
  const registrableBound = shared ? host : registrable;

  // 三个候选域名（绑过的就不再列）
  const candidates: Array<{ domain: string; mode: 'exact' | 'registrable' | 'shared' }> = [];
  if (host && !account.domains.includes(exactBound)) {
    candidates.push({ domain: exactBound, mode: 'exact' });
  }
  if (
    registrableBound &&
    registrableBound !== exactBound &&
    !account.domains.includes(registrableBound)
  ) {
    candidates.push({ domain: registrableBound, mode: shared ? 'shared' : 'registrable' });
  }
  // 已经绑过 host 的话，提供「解绑 <host>」入口
  const boundHere = host && account.domains.includes(host);

  // 其他已绑域名（不是当前 host 的），也能从这里删
  const otherBindings = account.domains.filter((d) => d !== host);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((v) => !v);
  };

  const handleDelete = () => {
    setOpen(false);
    onDelete();
  };

  return (
    <div className={styles.menuWrap} ref={ref}>
      <button
        type="button"
        className={styles.iconButton}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={handleToggle}
        title={t('rowMore')}
        aria-label={t('rowMore')}
        aria-expanded={open}
      >
        <MoreIcon />
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          {/* Section 1：当前网站绑定 */}
          <div className={styles.menuSection}>
            <div className={styles.menuSectionHeader}>{t('rowMenuSectionCurrent')}</div>
            {!host && (
              <div className={styles.menuHint}>{t('rowMenuNoHost')}</div>
            )}
            {host && candidates.length === 0 && !boundHere && (
              <div className={styles.menuHint}>{t('rowMenuNoCandidates')}</div>
            )}
            {candidates.map((c) => (
              <button
                key={c.domain}
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  onBindDomain(c.domain);
                  setOpen(false);
                }}
              >
                <span className={styles.menuItemDomain}>{c.domain}</span>
                <span className={styles.menuItemMode}>
                  {c.mode === 'exact' && t('rowMenuBindExact')}
                  {c.mode === 'registrable' && t('rowMenuBindRegistrable')}
                  {c.mode === 'shared' && t('rowMenuBindShared')}
                </span>
              </button>
            ))}
            {boundHere && (
              <button
                type="button"
                role="menuitem"
                className={`${styles.menuItem} ${styles.menuItemDanger}`}
                onClick={() => {
                  onUnbindDomain(host);
                  setOpen(false);
                }}
              >
                <span className={styles.menuItemDomain}>{t('rowMenuUnbind', host)}</span>
              </button>
            )}
          </div>

          {/* Section 2：其他已绑域名（仅在有内容时显示） */}
          {otherBindings.length > 0 && (
            <>
              <div className={styles.menuDivider} />
              <div className={styles.menuSection}>
                <div className={styles.menuSectionHeader}>
                  {t('rowMenuSectionOtherBindings')}
                </div>
                {otherBindings.map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="menuitem"
                    className={`${styles.menuItem} ${styles.menuItemDanger}`}
                    onClick={() => {
                      onUnbindDomain(d);
                      setOpen(false);
                    }}
                    title={t('rowMenuUnbindTitle')}
                  >
                    <span className={styles.menuItemDomain}>{d}</span>
                    <span className={styles.menuItemMode}>{t('rowMenuRemove')}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Section 3：账号操作（危险） */}
          <div className={styles.menuDivider} />
          <div className={styles.menuSection}>
            <button
              type="button"
              role="menuitem"
              className={`${styles.menuItem} ${styles.menuItemDanger}`}
              onClick={handleDelete}
              title={t('rowDelete')}
            >
              <span className={styles.menuItemDomain}>{t('rowDelete')}</span>
              <span className={styles.menuItemMode}>{t('rowMenuAccount')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// memo：避免父组件每秒重渲染时，所有行都被迫重渲染整个 React 树。
// now 变了父组件确实要刷新，但只有变了的那一行应该真的重算 code。
// 父组件用 account.id 作为 key，并把这个 key 放到依赖里 —— React 默认
// 对 props 做浅比较，now 是 number，直接比即可。
export const CodeRow = memo(CodeRowInner);