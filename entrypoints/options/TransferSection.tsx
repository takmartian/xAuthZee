/**
 * M9 设置页 · 导入导出 section。
 *
 * 流程：
 *   - **导出**：点按钮 → 弹模式选择（明文 / 加密）→ 选「加密」再弹密码
 *     dialog（输两次）→ 构造 payload → 下载。`xauthzee-export-...json`
 *     或 `xauthzee-export-...-encrypted.json`。
 *   - **导入**：选 JSON 文件 → 解析（按 schema 自动分发）→ 明文走预览
 *     流程；密文先弹密码 dialog → 解密 → 再走预览流程。预览仍让用户
 *     选 merge/overwrite/skip。
 *
 * 锁定态下：导出禁用（secret 都被清掉，导出来是空壳）；导入禁用（导入
 * 文件本身的 secret 是明文，写入后无法解密）。
 */

import { useCallback, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { vault } from '@/lib/storage';
import { revealAccounts, stripSecrets } from '@/lib/secrets';
import { getDerivedKey } from '@/lib/lock-runtime';
import {
  buildExportPayload,
  buildEncryptedExport,
  downloadExport,
  downloadEncryptedExport,
  parseExport,
  decryptExportPayload,
  applyImport,
  type ImportMode,
  type ExportPayload,
  type EncryptedExportPayload,
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

type Mode =
  | 'idle'
  | 'export-mode'
  | 'export-password'
  | 'export-confirm'
  | 'import-password'
  | 'import-preview'
  | 'import-error'
  | 'busy';

export function TransferSection({ accounts, prefs, lockState, onChanged }: TransferSectionProps) {
  const [mode, setMode] = useState<Mode>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingPlain, setPendingPlain] = useState<ExportPayload | null>(null);
  const [pendingEncrypted, setPendingEncrypted] = useState<EncryptedExportPayload | null>(null);
  const [exportMode, setExportMode] = useState<'plain' | 'encrypted'>('plain');
  const [exportPw, setExportPw] = useState('');
  const [exportPwConfirm, setExportPwConfirm] = useState('');
  const [importPw, setImportPw] = useState('');
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => {
    setMode('idle');
    setError(null);
    setPendingPlain(null);
    setPendingEncrypted(null);
    setExportMode('plain');
    setExportPw('');
    setExportPwConfirm('');
    setImportPw('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // --- 导出

  // 第一步：构造明文 payload（unlocked 时先 reveal），进 export-mode 选择
  const startExport = useCallback(async () => {
    if (lockState === 'locked') return;
    setError(null);
    try {
      let exportAccounts: Account[];
      if (lockState === 'unlocked') {
        const key = await getDerivedKey();
        exportAccounts = key ? await revealAccounts(accounts, key) : stripSecrets(accounts);
      } else {
        exportAccounts = accounts;
      }
      const payload = buildExportPayload(exportAccounts, prefs);
      setPendingPlain(payload);
      setMode('export-mode');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [accounts, prefs, lockState]);

  // export-mode → 明文：直接下载；加密：进密码 dialog
  const onExportModeChosen = useCallback((m: 'plain' | 'encrypted') => {
    if (m === 'plain') {
      if (pendingPlain) downloadExport(pendingPlain);
      close();
    } else {
      setExportMode('encrypted');
      setMode('export-password');
    }
  }, [pendingPlain, close]);

  const confirmExportEncrypted = useCallback(async () => {
    if (!pendingPlain) return;
    if (exportPw.length < 4) {
      setError(t('optionsExportPasswordTooShort'));
      return;
    }
    if (exportPw !== exportPwConfirm) {
      setError(t('optionsPasswordMismatch'));
      return;
    }
    setError(null);
    try {
      const enc = await buildEncryptedExport(pendingPlain, exportPw);
      downloadEncryptedExport(enc);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [pendingPlain, exportPw, exportPwConfirm, close]);

  // --- 导入

  const handlePickFile = useCallback(() => {
    if (lockState === 'locked') return;
    fileInputRef.current?.click();
  }, [lockState]);

  const onFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setImportPw('');
    try {
      const text = await file.text();
      const r = parseExport(text);
      if (r.errors.length) {
        setError(r.errors.map((er) => `${er.code}: ${er.message}`).join('；'));
        setMode('import-error');
        return;
      }
      if (r.encrypted) {
        setPendingEncrypted(r.encrypted);
        setMode('import-password');
        return;
      }
      if (r.payload) {
        setPendingPlain(r.payload);
        setMode('import-preview');
        return;
      }
      setError('unknown');
      setMode('import-error');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode('import-error');
    }
  }, []);

  const confirmImportDecrypt = useCallback(async () => {
    if (!pendingEncrypted) return;
    if (!importPw) {
      setError(t('optionsImportPasswordEmpty'));
      return;
    }
    setError(null);
    const r = await decryptExportPayload(pendingEncrypted, importPw);
    if (!r.payload) {
      setError(t('optionsImportWrongPassword'));
      return;
    }
    setPendingPlain(r.payload);
    setPendingEncrypted(null);
    setImportPw('');
    setMode('import-preview');
  }, [pendingEncrypted, importPw]);

  const confirmImport = useCallback(async () => {
    if (!pendingPlain) return;
    setMode('busy');
    setError(null);
    try {
      const key = lockState === 'unlocked' ? await getDerivedKey() : null;
      const result = await applyImport(pendingPlain, importMode, {
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
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode('import-error');
    }
  }, [pendingPlain, importMode, accounts, prefs, lockState, onChanged, close]);

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
          onClick={() => void startExport()}
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

      {mode === 'export-mode' && (
        <div className={styles.transferPanel}>
          <p className={styles.transferSummary}>{t('optionsExportChooseMode')}</p>
          <fieldset className={styles.importModes}>
            <label>
              <input
                type="radio"
                name="exportMode"
                checked={exportMode === 'plain'}
                onChange={() => setExportMode('plain')}
              />
              <span>{t('optionsExportModePlain')}</span>
            </label>
            <label>
              <input
                type="radio"
                name="exportMode"
                checked={exportMode === 'encrypted'}
                onChange={() => setExportMode('encrypted')}
              />
              <span>{t('optionsExportModeEncrypted')}</span>
            </label>
          </fieldset>
          <div className={styles.formActions}>
            <button type="button" className={styles.secondaryButton} onClick={close}>
              {t('addDialogCancel')}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => onExportModeChosen(exportMode)}
            >
              {t('addDialogOk')}
            </button>
          </div>
        </div>
      )}

      {mode === 'export-password' && (
        <form
          className={styles.transferPanel}
          onSubmit={(e) => {
            e.preventDefault();
            void confirmExportEncrypted();
          }}
        >
          <p className={styles.transferSummary}>{t('optionsExportPasswordIntro')}</p>
          <input
            type="password"
            className={styles.addHostInput}
            placeholder={t('optionsExportPasswordLabel')}
            value={exportPw}
            onChange={(e) => setExportPw(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
          />
          <input
            type="password"
            className={styles.addHostInput}
            placeholder={t('optionsExportPasswordConfirmLabel')}
            value={exportPwConfirm}
            onChange={(e) => setExportPwConfirm(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
          />
          {error && <div className={styles.formError}>{error}</div>}
          <div className={styles.formActions}>
            <button type="button" className={styles.secondaryButton} onClick={close}>
              {t('addDialogCancel')}
            </button>
            <button type="submit" className={styles.primaryButton}>
              {t('optionsExportButton')}
            </button>
          </div>
        </form>
      )}

      {mode === 'import-password' && (
        <form
          className={styles.transferPanel}
          onSubmit={(e) => {
            e.preventDefault();
            void confirmImportDecrypt();
          }}
        >
          <p className={styles.transferSummary}>{t('optionsImportPasswordIntro')}</p>
          <input
            type="password"
            className={styles.addHostInput}
            placeholder={t('optionsImportPasswordLabel')}
            value={importPw}
            onChange={(e) => setImportPw(e.target.value)}
            autoComplete="current-password"
            spellCheck={false}
            autoFocus
          />
          {error && <div className={styles.formError}>{error}</div>}
          <div className={styles.formActions}>
            <button type="button" className={styles.secondaryButton} onClick={close}>
              {t('addDialogCancel')}
            </button>
            <button type="submit" className={styles.primaryButton}>
              {t('addDialogOk')}
            </button>
          </div>
        </form>
      )}

      {mode === 'import-preview' && pendingPlain && (
        <ImportPreview
          payload={pendingPlain}
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
