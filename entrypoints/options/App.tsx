import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '@/lib/i18n';
import { vault, watchVault } from '@/lib/storage';
import { DEFAULT_PREFS, type Account, type Prefs } from '@/lib/model';
import { CloseIcon } from '@/components/Icon';
import { SecuritySection } from './SecuritySection';
import { TransferSection } from './TransferSection';
import { installLockRuntime } from '@/lib/lock-runtime';
import { getLockState, onLockChange, lock as doLock, type LockState } from '@/lib/lock';
import styles from './App.module.css';

/**
 * 设置页。
 *
 * M6：域名绑定管理（按域名聚合）。
 * M7：聚焦浮层偏好（panelEnabled / broadDetection / disabledHosts）。
 * M8：主密码加密与锁状态。
 */
export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [lockState, setLockState] = useState<LockState>('plaintext');

  useEffect(() => {
    installLockRuntime();
    let cancelled = false;
    void vault.list().then((list) => {
      if (!cancelled) setAccounts(list);
    });
    void vault.getPrefs().then((p) => {
      if (!cancelled) setPrefs(p);
    });
    void getLockState().then((s) => {
      if (!cancelled) setLockState(s);
    });
    const unwatch = watchVault(() => {
      void vault.list().then((list) => {
        if (!cancelled) setAccounts(list);
      });
      void vault.getPrefs().then((p) => {
        if (!cancelled) setPrefs(p);
      });
    });
    const off = onLockChange((s) => {
      if (!cancelled) setLockState(s);
    });
    return () => {
      cancelled = true;
      unwatch();
      off();
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
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [accounts]);

  const handleUnbind = async (account: Account, domain: string) => {
    await vault.update(account.id, {
      domains: account.domains.filter((d) => d !== domain),
    });
  };

  // M9：导入完成后由 TransferSection 调一次，重新拉 vault 状态。
  // 返回 Promise 是给 TransferSection 等 vault 写完后的 reload 真正完成
  // 再切到成功面板 —— 避免"显示成功但界面列表还没刷新"的中间态。
  const reloadFromVault = useCallback(async () => {
    const [list, p] = await Promise.all([vault.list(), vault.getPrefs()]);
    setAccounts(list);
    setPrefs(p);
  }, []);

  const updatePref = async <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    await vault.setPrefs({ [key]: value } as Partial<Prefs>);
  };

  const removeDisabledHost = async (host: string) => {
    await updatePref(
      'disabledHosts',
      prefs.disabledHosts.filter((h) => h !== host),
    );
  };

  const addDisabledHost = async (raw: string) => {
    const host = raw.trim().toLowerCase();
    if (!host) return;
    if (prefs.disabledHosts.includes(host)) return;
    await updatePref('disabledHosts', [...prefs.disabledHosts, host]);
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{t('optionsTitle')}</h1>

      {/* M7：浮层偏好 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t('optionsPanelTitle')}</h2>
        <p className={styles.subtitle}>{t('optionsPanelSubtitle')}</p>

        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={prefs.panelEnabled}
            onChange={(e) => void updatePref('panelEnabled', e.target.checked)}
          />
          <span>{t('optionsPanelEnabled')}</span>
        </label>

        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={prefs.broadDetection}
            onChange={(e) => void updatePref('broadDetection', e.target.checked)}
          />
          <span>{t('optionsBroadDetection')}</span>
        </label>

        <div className={styles.disabledList}>
          <div className={styles.disabledLabel}>{t('optionsDisabledHosts')}</div>
          {prefs.disabledHosts.length === 0 ? (
            <div className={styles.placeholder}>{t('optionsDisabledHostsEmpty')}</div>
          ) : (
            <ul className={styles.disabledHosts}>
              {prefs.disabledHosts.map((host) => (
                <li key={host} className={styles.disabledHost}>
                  <span>{host}</span>
                  <button
                    type="button"
                    onClick={() => void removeDisabledHost(host)}
                    className={styles.removeButton}
                    title={t('optionsBindingsRemove')}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <AddHostInput onAdd={(h) => void addDisabledHost(h)} />
        </div>
      </section>

      {/* M6：域名绑定管理 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t('optionsBindingsTitle')}</h2>
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
      </section>

      {/* M8：主密码加密与锁状态 */}
      <SecuritySection
        lockState={lockState}
        prefs={prefs}
        onLockNow={() => void doLock()}
        onPrefsChange={(patch) => void updatePref('lockMinutes', patch.lockMinutes ?? prefs.lockMinutes)}
      />

      {/* M9：JSON 导入导出 */}
      <TransferSection
        accounts={accounts}
        prefs={prefs}
        lockState={lockState}
        onChanged={reloadFromVault}
      />
    </div>
  );
}

function AddHostInput({ onAdd }: { onAdd: (host: string) => void }) {
  const [value, setValue] = useState('');
  const submit = () => {
    if (value.trim()) {
      onAdd(value);
      setValue('');
    }
  };
  return (
    <div className={styles.addHostRow}>
      <input
        className={styles.addHostInput}
        value={value}
        placeholder={t('optionsDisabledHostsPlaceholder')}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="button"
        className={styles.addHostButton}
        onClick={submit}
        disabled={!value.trim()}
      >
        {t('actionAdd')}
      </button>
    </div>
  );
}