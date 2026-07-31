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
import { decodeImageData } from '@/lib/qr/decode';
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
import { parseGaMigrationUrl, GaMigrationError, type GaMigrationResult } from '@/lib/ga-migration';
import type { Account, Prefs } from '@/lib/model';
import type { LockState } from '@/lib/lock';
import styles from './App.module.css';

interface TransferSectionProps {
  accounts: Account[];
  prefs: Prefs;
  lockState: LockState;
  /** 写回 vault 后让父组件 reload；返回 Promise 让子组件等真正完成再切面板 */
  onChanged: () => Promise<void> | void;
}

type Mode =
  | 'idle'
  | 'export-mode'
  | 'export-password'
  | 'export-confirm'
  | 'import-password'
  | 'import-preview'
  | 'import-success'
  | 'import-error'
  | 'import-ga'
  | 'busy';

interface ImportResultInfo {
  added: number;
  updated: number;
  skipped: number;
  errors: Array<{ id?: string; message: string }>;
}

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
  const [importResult, setImportResult] = useState<ImportResultInfo | null>(null);
  const [gaUrl, setGaUrl] = useState('');
  const [gaInfo, setGaInfo] = useState<{ skipped: GaMigrationResult['skipped']; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const gaFileInputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => {
    setMode('idle');
    setError(null);
    setPendingPlain(null);
    setPendingEncrypted(null);
    setExportMode('plain');
    setExportPw('');
    setExportPwConfirm('');
    setImportPw('');
    setImportResult(null);
    setGaUrl('');
    setGaInfo(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (gaFileInputRef.current) gaFileInputRef.current.value = '';
  }, []);

  // --- Google Authenticator 迁移

  /**
   * 把 GA 解析结果转成 ExportPayload（带 prefs 默认值）。
   * GA 迁移没有 prefs，prefsChanged 由 UI 提示「不影响偏好」让用户决定。
   */
  const gaToExportPayload = useCallback(
    (ga: GaMigrationResult, currentPrefs: Prefs): ExportPayload => {
      // ExportPayload 必填 fields；prefs 留空让 applyImport 看到 prefsChanged
      // = false（payload.prefs === ctx.currentPrefs → 不写）
      return {
        version: 1,
        schema: 'xauthzee-accounts',
        exportedAt: new Date().toISOString(),
        app: { name: 'XAuthZee', version: '0.1.0' },
        accounts: ga.accounts,
        prefs: currentPrefs,
      };
    },
    [],
  );

  const handleGaUrlSubmit = useCallback(() => {
    const url = gaUrl.trim();
    if (!url) {
      setError(t('optionsGaEmpty'));
      return;
    }
    setMode('busy');
    let ga: GaMigrationResult;
    try {
      ga = parseGaMigrationUrl(url);
    } catch (e) {
      setError(e instanceof GaMigrationError ? e.message : (e instanceof Error ? e.message : String(e)));
      setMode('import-ga');
      return;
    }
    setPendingPlain(gaToExportPayload(ga, prefs));
    setGaInfo({ skipped: ga.skipped, total: ga.total });
    setMode('import-preview');
  }, [gaUrl, prefs, gaToExportPayload]);

  const handleGaFile = useCallback(async (file: File) => {
    setError(null);
    setMode('busy');
    try {
      const url = URL.createObjectURL(file);
      let text: string | null = null;
      try {
        const img = new Image();
        await new Promise<void>((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error('image load failed'));
          img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context unavailable');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        text = decodeImageData(data);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (!text) {
        setError(t('optionsGaQrNotFound'));
        setMode('import-ga');
        return;
      }
      let ga: GaMigrationResult;
      try {
        ga = parseGaMigrationUrl(text);
      } catch (e) {
        setError(e instanceof GaMigrationError ? e.message : (e instanceof Error ? e.message : String(e)));
        setMode('import-ga');
        return;
      }
      setPendingPlain(gaToExportPayload(ga, prefs));
      setGaInfo({ skipped: ga.skipped, total: ga.total });
      setMode('import-preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode('import-ga');
    }
  }, [prefs, gaToExportPayload]);

  const onGaFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void handleGaFile(file);
  }, [handleGaFile]);

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
    // 文件读取 + 解析（甚至加密分支还要再走 PBKDF2）这一整段都有用户感
    // 得到的等待时间。先把遮罩挂上，下面的 finally 决定最终落到哪个面板。
    setMode('busy');
    console.time('[XAuthZee] import:onFileChange');
    try {
      const text = await file.text();
      console.timeLog('[XAuthZee] import:onFileChange', 'read done');
      const r = parseExport(text);
      console.timeLog('[XAuthZee] import:onFileChange', 'parseExport done');
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
    } finally {
      console.timeEnd('[XAuthZee] import:onFileChange');
    }
  }, []);

  const confirmImportDecrypt = useCallback(async () => {
    if (!pendingEncrypted) return;
    if (!importPw) {
      setError(t('optionsImportPasswordEmpty'));
      return;
    }
    setError(null);
    // PBKDF2 600k iter 是有意为之（OWASP 推荐），crypto.subtle 第一次调用
    // 还有 JIT 预热成本。在 UI 上加遮罩让用户知道在跑、不是卡死。
    setMode('busy');
    console.time('[XAuthZee] import:decrypt');
    let payload: ExportPayload | null = null;
    let errors: { code: string; message: string }[] = [];
    try {
      const r = await decryptExportPayload(pendingEncrypted, importPw);
      payload = r.payload;
      errors = r.errors;
    } finally {
      console.timeEnd('[XAuthZee] import:decrypt');
    }
    if (!payload) {
      setError(errors[0]?.code === 'wrong_password' ? t('optionsImportWrongPassword') : (errors[0]?.message ?? t('optionsImportWrongPassword')));
      setMode('import-password');
      return;
    }
    setPendingPlain(payload);
    setPendingEncrypted(null);
    setImportPw('');
    setMode('import-preview');
  }, [pendingEncrypted, importPw]);

  const confirmImport = useCallback(async () => {
    if (!pendingPlain) return;
    setMode('busy');
    setError(null);
    console.time('[XAuthZee] import:confirm');
    try {
      const key = lockState === 'unlocked' ? await getDerivedKey() : null;
      const result = await applyImport(pendingPlain, importMode, {
        currentAccounts: accounts,
        currentPrefs: prefs,
        lockState,
        derivedKey: key,
      });
      console.timeLog('[XAuthZee] import:confirm', 'applyImport done');
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
      console.timeLog('[XAuthZee] import:confirm', `changed=${changed.length}`);
      if (changed.length > 0) {
        await vault.importRecords(changed);
        console.timeLog('[XAuthZee] import:confirm', 'importRecords done');
      }
      if (result.prefsChanged) {
        await vault.setPrefs(result.finalPrefs);
        console.timeLog('[XAuthZee] import:confirm', 'setPrefs done');
      }
      await onChanged();
      console.timeLog('[XAuthZee] import:confirm', 'onChanged reload done');
      // 全部成功 → 成功面板
      setImportResult({
        added: result.added.length,
        updated: result.updated.length,
        skipped: result.skipped.length,
        errors: result.errors,
      });
      setPendingPlain(null);
      setMode('import-success');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode('import-error');
    } finally {
      console.timeEnd('[XAuthZee] import:confirm');
    }
  }, [pendingPlain, importMode, accounts, prefs, lockState, onChanged]);

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
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => setMode('import-ga')}
          disabled={disabled}
        >
          {t('optionsGaButton')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className={styles.hiddenFile}
          onChange={(e) => void onFileChange(e)}
        />
        <input
          ref={gaFileInputRef}
          type="file"
          accept="image/*"
          className={styles.hiddenFile}
          onChange={onGaFileChange}
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

      {mode === 'import-ga' && (
        <div className={styles.transferPanel}>
          <p className={styles.transferSummary}>{t('optionsGaIntro')}</p>
          <textarea
            className={styles.gaTextarea}
            value={gaUrl}
            onChange={(e) => setGaUrl(e.target.value)}
            placeholder="otpauth-migration://offline?data=..."
            rows={4}
            spellCheck={false}
          />
          <div className={styles.formActions}>
            <button type="button" className={styles.secondaryButton} onClick={close}>
              {t('addDialogCancel')}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleGaUrlSubmit}
            >
              {t('optionsGaParseUrl')}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => gaFileInputRef.current?.click()}
            >
              {t('optionsGaUploadImage')}
            </button>
          </div>
          {error && <div className={styles.formError}>{error}</div>}
        </div>
      )}

      {mode === 'import-preview' && pendingPlain && (
        <ImportPreview
          payload={pendingPlain}
          importMode={importMode}
          onModeChange={setImportMode}
          currentAccounts={accounts}
          onCancel={close}
          onConfirm={() => void confirmImport()}
          gaInfo={gaInfo}
        />
      )}

      {mode === 'busy' && (
        <BusyOverlay label={t('optionsImportWorking')} />
      )}

      {mode === 'import-success' && importResult && (
        <div className={styles.transferPanel}>
          <p className={styles.transferSuccess}>
            ✓ {t('optionsImportSuccessTitle')}
          </p>
          <p className={styles.transferSummary}>
            {t('optionsImportSuccessSummary', [
              String(importResult.added),
              String(importResult.updated),
              String(importResult.skipped),
            ])}
          </p>
          {importResult.errors.length > 0 && (
            <div className={styles.formError}>
              {t('optionsImportPartial')}
              {importResult.errors.map((er) => `${er.id ?? '?'}: ${er.message}`).join('；')}
            </div>
          )}
          <div className={styles.formActions}>
            <button type="button" className={styles.primaryButton} onClick={close}>
              {t('addDialogOk')}
            </button>
          </div>
        </div>
      )}

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

// ------------------------------------------------------------ Busy 遮罩

function BusyOverlay({ label }: { label: string }) {
  return (
    <div className={styles.busyOverlay} role="status" aria-live="polite">
      <div className={styles.busyCard}>
        <div className={styles.busySpinner} />
        <div className={styles.busyLabel}>{label}</div>
      </div>
    </div>
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
  gaInfo,
}: {
  payload: ExportPayload;
  importMode: ImportMode;
  onModeChange: (m: ImportMode) => void;
  currentAccounts: Account[];
  onCancel: () => void;
  onConfirm: () => void;
  gaInfo?: { skipped: GaMigrationResult['skipped']; total: number } | null;
}) {
  const existing = new Set(currentAccounts.map((a) => a.id));
  const newCount = payload.accounts.filter((a) => !existing.has(a.id)).length;
  const overlap = payload.accounts.filter((a) => existing.has(a.id)).length;

  const willAdd = newCount;
  const willUpdate = importMode === 'overwrite' ? overlap : 0;
  const willSkip = importMode === 'skip' ? overlap : 0;

  return (
    <div className={styles.transferPanel}>
      {gaInfo && (
        <p className={styles.transferSummary}>
          {t('optionsGaFromGa', [String(payload.accounts.length), String(gaInfo.total)])}
          {gaInfo.skipped.length > 0 && (
            <> · {t('optionsGaSkipped', [String(gaInfo.skipped.length)])}</>
          )}
        </p>
      )}
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
