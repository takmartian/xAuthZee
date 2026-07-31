/**
 * M9 设置页 · 导入导出 section。
 *
 * 两个动作：
 *   - **导出全部**：生成 `xauthzee-export-YYYYMMDD-HHmm.json`，含 accounts
 *     + prefs。unlocked 态下先把 secret 解密成明文再写。
 *   - **导入**：选 JSON 文件 → 校验 → 弹预览（merge/overwrite/skip 三选 +
 *     预计新增/更新/跳过数量）→ 确认后调 vault 写入。
 *
 * 锁定态下：导出禁用（secret 都被清掉，导出来是空壳）；导入禁用（导入文
 * 件本身是明文 secret，写入后无法解密）。
 */

import { useCallback, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { vault } from '@/lib/storage';
import { revealAccounts, stripSecrets } from '@/lib/secrets';
import { getDerivedKey } from '@/lib/lock-runtime';
import {
  buildExportPayload,
  downloadExport,
  parseExport,
  applyImport,
  type ImportMode,
  type ExportPayload,
} from '@/lib/transfer';
import type { Account, Prefs } from '@/lib/model';
import type { LockState } from '@/lib/lock';
import styles from './App.module.css';

interface TransferSectionProps {
  accounts: Account[];
  prefs: Prefs;
  lockState: LockState;
  onChanged: () => void;
}

type Mode = 'idle' | 'export-confirm' | 'import-preview' | 'import-error' | 'busy';

export function TransferSection({ accounts, prefs, lockState, onChanged }: TransferSectionProps) {
  const [mode, setMode] = useState<Mode>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingPayload, setPendingPayload] = useState<ExportPayload | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => {
    setMode('idle');
    setError(null);
    setPendingPayload(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // --- 导出

  const handleExport = useCallback(async () => {
    if (lockState === 'locked') return;
    setError(null);
    try {
      // unlocked 态下把 enc1: 还原成明文
      let exportAccounts: Account[];
      if (lockState === 'unlocked') {
        const key = await getDerivedKey();
        exportAccounts = key ? await revealAccounts(accounts, key) : stripSecrets(accounts);
      } else {
        exportAccounts = accounts;
      }
      const payload = buildExportPayload(exportAccounts, prefs);
      // 加密态下弹一个确认（明文 secret 文件风险大）
      if (lockState !== 'plaintext') {
        setPendingPayload(payload);
        setMode('export-confirm');
        return;
      }
      downloadExport(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [accounts, prefs, lockState]);

  const confirmExport = useCallback(() => {
    if (!pendingPayload) return;
    try {
      downloadExport(pendingPayload);
      setMode('idle');
      setPendingPayload(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [pendingPayload]);

  // --- 导入

  const handlePickFile = useCallback(() => {
    if (lockState === 'locked') return;
    fileInputRef.current?.click();
  }, [lockState]);

  const onFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const r = parseExport(text);
      if (!r.payload) {
        setError(r.errors.map((er) => `${er.code}: ${er.message}`).join('；'));
        setMode('import-error');
        return;
      }
      setPendingPayload(r.payload);
      setMode('import-preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode('import-error');
    }
  }, []);

  const confirmImport = useCallback(async () => {
    if (!pendingPayload) return;
    setMode('busy');
    setError(null);
    try {
      const key = lockState === 'unlocked' ? await getDerivedKey() : null;
      const result = await applyImport(pendingPayload, importMode, {
        currentAccounts: accounts,
        currentPrefs: prefs,
        lockState,
        derivedKey: key,
      });
      if (result.errors.length) {
        setError(
          `${t('optionsImportPartial')} ${result.errors
            .map((er) => `${er.id ?? '?'}: ${er.message}`)
            .join('；')}`,
        );
      }
      // importRecords 一把写入：已有 id 覆盖、不存在的追加到 index 末尾。
      // 只把"最终结果与当前有差异"的部分写回去（reduce 写量、避开 sync 配额）
      const changed = result.finalAccounts.filter((a) => {
        const cur = accounts.find((c) => c.id === a.id);
        if (!cur) return true;
        return (
          cur.issuer !== a.issuer ||
          cur.label !== a.label ||
          cur.secret !== a.secret ||
          cur.algorithm !== a.algorithm ||
          cur.digits !== a.digits ||
          cur.period !== a.period ||
          cur.domains.join('|') !== a.domains.join('|')
        );
      });
      if (changed.length > 0) {
        await vault.importRecords(changed);
      }
      if (result.prefsChanged) {
        await vault.setPrefs(result.finalPrefs);
      }
      onChanged();
      setMode('idle');
      setPendingPayload(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode('import-error');
    }
  }, [pendingPayload, importMode, accounts, prefs, lockState, onChanged]);

  const disabled = lockState === 'locked';

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{t('optionsTransferTitle')}</h2>
      <p className={styles.subtitle}>{t('optionsTransferSubtitle')}</p>

      {disabled && <p className={styles.formError}>{t('optionsTransferLocked')}</p>}

      <div className={styles.transferActions}>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => void handleExport()}
          disabled={disabled || accounts.length === 0}
        >
          {t('optionsExportButton')}
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={handlePickFile}
          disabled={disabled}
        >
          {t('optionsImportButton')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className={styles.hiddenFile}
          onChange={(e) => void onFileChange(e)}
        />
      </div>

      {mode === 'export-confirm' && (
        <div className={styles.transferPanel}>
          <p className={styles.transferWarn}>{t('optionsExportConfirmMsg')}</p>
          <div className={styles.formActions}>
            <button type="button" className={styles.secondaryButton} onClick={close}>
              {t('addDialogCancel')}
            </button>
            <button type="button" className={styles.primaryButton} onClick={confirmExport}>
              {t('optionsExportButton')}
            </button>
          </div>
        </div>
      )}

      {mode === 'import-preview' && pendingPayload && (
        <ImportPreview
          payload={pendingPayload}
          importMode={importMode}
          onModeChange={setImportMode}
          currentAccounts={accounts}
          onCancel={close}
          onConfirm={() => void confirmImport()}
        />
      )}

      {mode === 'busy' && <p className={styles.placeholder}>{t('optionsImportWorking')}</p>}

      {mode === 'import-error' && error && (
        <div className={styles.transferPanel}>
          <div className={styles.formError}>{error}</div>
          <div className={styles.formActions}>
            <button type="button" className={styles.secondaryButton} onClick={close}>
              {t('addDialogCancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ 预览面板

function ImportPreview({
  payload,
  importMode,
  onModeChange,
  currentAccounts,
  onCancel,
  onConfirm,
}: {
  payload: ExportPayload;
  importMode: ImportMode;
  onModeChange: (m: ImportMode) => void;
  currentAccounts: Account[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const existing = new Set(currentAccounts.map((a) => a.id));
  const newCount = payload.accounts.filter((a) => !existing.has(a.id)).length;
  const overlap = payload.accounts.filter((a) => existing.has(a.id)).length;

  const willAdd = newCount;
  const willUpdate = importMode === 'overwrite' ? overlap : 0;
  const willSkip = importMode === 'skip' ? overlap : 0;

  return (
    <div className={styles.transferPanel}>
      <p className={styles.transferSummary}>
        {t('optionsImportPreview', [
          String(payload.accounts.length),
          String(newCount),
          String(overlap),
        ])}
      </p>

      <fieldset className={styles.importModes}>
        <legend>{t('optionsImportModeLabel')}</legend>
        <label>
          <input
            type="radio"
            name="importMode"
            checked={importMode === 'merge'}
            onChange={() => onModeChange('merge')}
          />
          <span>{t('optionsImportModeMerge')}</span>
        </label>
        <label>
          <input
            type="radio"
            name="importMode"
            checked={importMode === 'overwrite'}
            onChange={() => onModeChange('overwrite')}
          />
          <span>{t('optionsImportModeOverwrite')}</span>
        </label>
        <label>
          <input
            type="radio"
            name="importMode"
            checked={importMode === 'skip'}
            onChange={() => onModeChange('skip')}
          />
          <span>{t('optionsImportModeSkip')}</span>
        </label>
      </fieldset>

      <p className={styles.transferSummary}>
        {t('optionsImportWill', [String(willAdd), String(willUpdate), String(willSkip)])}
      </p>

      <div className={styles.formActions}>
        <button type="button" className={styles.secondaryButton} onClick={onCancel}>
          {t('addDialogCancel')}
        </button>
        <button type="button" className={styles.primaryButton} onClick={onConfirm}>
          {t('optionsImportButton')}
        </button>
      </div>
    </div>
  );
}
