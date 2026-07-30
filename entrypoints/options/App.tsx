import { useEffect, useMemo, useState } from 'react';
import { t } from '@/lib/i18n';
import { vault, watchVault } from '@/lib/storage';
import type { Account } from '@/lib/model';
import { CloseIcon } from '@/components/Icon';
import styles from './App.module.css';

/**
 * 设置页 —— M6 阶段先做「域名绑定管理」。
 *
 * 按域名聚合展示：每个域名下列出绑定了它的账号（issuer + label），
 * 点 × 解绑。后续 M9 会在这一页里加主密码、导入导出和高级偏好。
 *
 * 跨账号聚合的意义：同一个域名被多个人或同一个人的多个账号绑定的情况
 * 不算罕见（个人 GitHub + 工作 GitHub），按域名聚合比按账号聚合更直观。
 */
export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);

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

  // domain -> 绑定到该域名的账号列表
  const grouped = useMemo(() => {
    const map = new Map<string, Account[]>();
    for (const a of accounts) {
      for (const d of a.domains) {
        const list = map.get(d);
        if (list) list.push(a);
        else map.set(d, [a]);
      }
    }
    // 排序：先按域名字典序，再按账号 issuer + label
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [accounts]);

  const handleUnbind = async (account: Account, domain: string) => {
    await vault.update(account.id, {
      domains: account.domains.filter((d) => d !== domain),
    });
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{t('optionsBindingsTitle')}</h1>
      <p className={styles.subtitle}>{t('optionsBindingsSubtitle')}</p>

      {grouped.length === 0 ? (
        <p className={styles.placeholder}>{t('optionsBindingsEmpty')}</p>
      ) : (
        <ul className={styles.list}>
          {grouped.map(([domain, list]) => (
            <li key={domain} className={styles.item}>
              <div className={styles.domain}>{domain}</div>
              <ul className={styles.accounts}>
                {list.map((a) => (
                  <li key={a.id} className={styles.account}>
                    <span className={styles.accountName}>
                      {a.issuer || a.label}
                      {a.issuer && a.label ? ` (${a.label})` : ''}
                    </span>
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={() => void handleUnbind(a, domain)}
                      title={t('optionsBindingsRemove')}
                      aria-label={t('optionsBindingsRemove')}
                    >
                      <CloseIcon />
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}