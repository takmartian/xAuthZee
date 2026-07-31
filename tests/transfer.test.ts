/**
 * M9 单元测试：lib/transfer.ts JSON 导入导出。
 *
 *   node --test tests/transfer.test.ts
 *
 * 覆盖：
 *   - buildExportPayload 深拷贝
 *   - serializeExport / parseExport roundtrip
 *   - parseExport 错误格式识别
 *   - applyImport × {merge, overwrite, skip} × {plaintext, unlocked, locked}
 *   - applyImport 在 unlocked 下重加密明文 secret
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deriveKey, PBKDF2_ITER, randomSalt } from '../lib/crypto.ts';
import {
  buildExportPayload,
  serializeExport,
  parseExport,
  applyImport,
  EXPORT_SCHEMA_VERSION,
  EXPORT_SCHEMA_NAME,
  type ExportPayload,
} from '../lib/transfer.ts';
import { DEFAULT_PREFS, type Account, type Prefs } from '../lib/model.ts';
import { isEncryptedSecret } from '../lib/secrets.ts';

const NOW_ISO = '2026-07-31T08:00:00.000Z';

function makeAccount(over: Partial<Account> = {}): Account {
  return {
    id: '0123456789',
    issuer: 'GitHub',
    label: 'octocat@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    domains: ['github.com'],
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

function makePrefs(over: Partial<Prefs> = {}): Prefs {
  return { ...DEFAULT_PREFS, ...over };
}

describe('buildExportPayload', () => {
  test('结构正确：version/schema/app/prefs', () => {
    const acc = [makeAccount()];
    const prefs = makePrefs();
    const payload = buildExportPayload(acc, prefs);
    assert.equal(payload.version, EXPORT_SCHEMA_VERSION);
    assert.equal(payload.schema, EXPORT_SCHEMA_NAME);
    assert.equal(payload.app.name, 'XAuthZee');
    assert.equal(typeof payload.app.version, 'string');
    assert.equal(payload.accounts.length, 1);
    assert.equal(payload.accounts[0]!.id, acc[0]!.id);
    assert.equal(payload.prefs.lockMinutes, prefs.lockMinutes);
  });

  test('domains / disabledHosts 深拷贝：外部修改不影响 payload', () => {
    const acc = [makeAccount({ domains: ['a.com', 'b.com'] })];
    const prefs = makePrefs({ disabledHosts: ['x.com'] });
    const payload = buildExportPayload(acc, prefs);
    acc[0]!.domains.push('c.com');
    prefs.disabledHosts.push('y.com');
    assert.deepEqual(payload.accounts[0]!.domains, ['a.com', 'b.com']);
    assert.deepEqual(payload.prefs.disabledHosts, ['x.com']);
  });

  test('exportedAt 是 ISO 字符串', () => {
    const p = buildExportPayload([], DEFAULT_PREFS);
    assert.equal(typeof p.exportedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(p.exportedAt)), 'exportedAt 必须可被 Date.parse 解析');
  });
});

describe('serializeExport / parseExport roundtrip', () => {
  test('序列化后 parseExport 还原', () => {
    const original: ExportPayload = {
      version: EXPORT_SCHEMA_VERSION,
      schema: EXPORT_SCHEMA_NAME,
      exportedAt: NOW_ISO,
      app: { name: 'XAuthZee', version: '0.1.0' },
      accounts: [
        makeAccount({ id: 'aaa', domains: ['a.com'] }),
        makeAccount({ id: 'bbb', issuer: 'Google', domains: [] }),
      ],
      prefs: makePrefs({ lockMinutes: 30, disabledHosts: ['evil.com'] }),
    };
    const text = serializeExport(original);
    const r = parseExport(text);
    assert.equal(r.errors.length, 0);
    assert.ok(r.payload);
    assert.deepEqual(r.payload!.accounts, original.accounts);
    assert.equal(r.payload!.prefs.lockMinutes, 30);
    assert.deepEqual(r.payload!.prefs.disabledHosts, ['evil.com']);
  });
});

describe('parseExport 错误识别', () => {
  test('非 JSON → not_json', () => {
    const r = parseExport('not json at all');
    assert.equal(r.payload, null);
    assert.equal(r.errors[0]!.code, 'not_json');
  });

  test('schema 错 → wrong_schema', () => {
    const r = parseExport(JSON.stringify({ schema: 'other', version: 1, exportedAt: NOW_ISO, app: { name: 'XAuthZee' }, accounts: [], prefs: DEFAULT_PREFS }));
    assert.equal(r.payload, null);
    assert.ok(r.errors.some((e) => e.code === 'wrong_schema'));
  });

  test('version 错 → wrong_version', () => {
    const r = parseExport(JSON.stringify({ schema: EXPORT_SCHEMA_NAME, version: 99, exportedAt: NOW_ISO, app: { name: 'XAuthZee' }, accounts: [], prefs: DEFAULT_PREFS }));
    assert.equal(r.payload, null);
    assert.ok(r.errors.some((e) => e.code === 'wrong_version'));
  });

  test('accounts 缺 → missing_field', () => {
    const r = parseExport(JSON.stringify({ schema: EXPORT_SCHEMA_NAME, version: 1, exportedAt: NOW_ISO, app: { name: 'XAuthZee' }, prefs: DEFAULT_PREFS }));
    assert.equal(r.payload, null);
  });

  test('account 字段错（digits 超界） → invalid_account', () => {
    const r = parseExport(JSON.stringify({
      schema: EXPORT_SCHEMA_NAME, version: 1, exportedAt: NOW_ISO,
      app: { name: 'XAuthZee' },
      accounts: [makeAccount({ digits: 99 })],
      prefs: DEFAULT_PREFS,
    }));
    assert.equal(r.payload, null);
    assert.ok(r.errors.some((e) => e.code === 'invalid_account'));
  });

  test('prefs 字段错（lockMinutes 负） → missing_field', () => {
    const r = parseExport(JSON.stringify({
      schema: EXPORT_SCHEMA_NAME, version: 1, exportedAt: NOW_ISO,
      app: { name: 'XAuthZee' },
      accounts: [],
      prefs: { ...DEFAULT_PREFS, lockMinutes: -1 },
    }));
    assert.equal(r.payload, null);
  });
});

describe('applyImport × 锁状态', () => {
  test('locked 态：拒绝导入，错误信息含"已锁定"', async () => {
    const payload = buildExportPayload([makeAccount({ id: 'newone' })], DEFAULT_PREFS);
    const r = await applyImport(payload, 'merge', {
      currentAccounts: [],
      currentPrefs: DEFAULT_PREFS,
      lockState: 'locked',
      derivedKey: null,
    });
    assert.equal(r.added.length, 0);
    assert.ok(r.errors[0]!.message.includes('已锁定'));
  });

  test('plaintext 态：secret 原样保留（仍是明文）', async () => {
    const acc = makeAccount({ id: 'p1', secret: 'JBSWY3DPEHPK3PXP' });
    const payload = buildExportPayload([acc], DEFAULT_PREFS);
    const r = await applyImport(payload, 'merge', {
      currentAccounts: [],
      currentPrefs: DEFAULT_PREFS,
      lockState: 'plaintext',
      derivedKey: null,
    });
    assert.equal(r.added.length, 1);
    assert.equal(r.finalAccounts[0]!.secret, 'JBSWY3DPEHPK3PXP');
    assert.equal(isEncryptedSecret(r.finalAccounts[0]!.secret), false);
  });

  test('unlocked 态：明文 secret 被重加密为 enc1:', async () => {
    const acc = makeAccount({ id: 'u1', secret: 'JBSWY3DPEHPK3PXP' });
    const payload = buildExportPayload([acc], DEFAULT_PREFS);
    const salt = randomSalt();
    const key = await deriveKey('mypassword', salt, PBKDF2_ITER);
    const r = await applyImport(payload, 'merge', {
      currentAccounts: [],
      currentPrefs: DEFAULT_PREFS,
      lockState: 'unlocked',
      derivedKey: key,
    });
    assert.equal(r.added.length, 1);
    assert.ok(isEncryptedSecret(r.finalAccounts[0]!.secret), 'secret 必须是 enc1: 形式');
  });
});

describe('applyImport × 模式', () => {
  const incoming1 = makeAccount({ id: 'shared', issuer: 'OldName' });
  const incoming2 = makeAccount({ id: 'fresh', issuer: 'NewOne' });
  const existing1 = makeAccount({ id: 'shared', issuer: 'ExistingName', domains: ['existing.com'] });
  const existing2 = makeAccount({ id: 'other', issuer: 'Untouched' });
  const payload: ExportPayload = buildExportPayload([incoming1, incoming2], DEFAULT_PREFS);

  test('merge：已有 id 不动；新 id 追加', async () => {
    const r = await applyImport(payload, 'merge', {
      currentAccounts: [existing1, existing2],
      currentPrefs: DEFAULT_PREFS,
      lockState: 'plaintext',
      derivedKey: null,
    });
    assert.equal(r.added.length, 1);
    assert.equal(r.added[0], 'fresh');
    assert.equal(r.updated.length, 0);
    assert.equal(r.skipped.length, 0);
    // shared 仍用 existing
    const shared = r.finalAccounts.find((a) => a.id === 'shared');
    assert.equal(shared!.issuer, 'ExistingName');
    // fresh 追加在末尾
    assert.equal(r.finalAccounts[r.finalAccounts.length - 1]!.id, 'fresh');
  });

  test('overwrite：已有 id 用导入数据替换；新 id 追加', async () => {
    const r = await applyImport(payload, 'overwrite', {
      currentAccounts: [existing1, existing2],
      currentPrefs: DEFAULT_PREFS,
      lockState: 'plaintext',
      derivedKey: null,
    });
    assert.equal(r.added.length, 1);
    assert.equal(r.added[0], 'fresh');
    assert.equal(r.updated.length, 1);
    assert.equal(r.updated[0], 'shared');
    // shared 换成 incoming
    const shared = r.finalAccounts.find((a) => a.id === 'shared');
    assert.equal(shared!.issuer, 'OldName');
  });

  test('skip：已有 id 进 skipped；新 id 追加', async () => {
    const r = await applyImport(payload, 'skip', {
      currentAccounts: [existing1, existing2],
      currentPrefs: DEFAULT_PREFS,
      lockState: 'plaintext',
      derivedKey: null,
    });
    assert.equal(r.added.length, 1);
    assert.equal(r.added[0], 'fresh');
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0], 'shared');
    // shared 仍用 existing
    const shared = r.finalAccounts.find((a) => a.id === 'shared');
    assert.equal(shared!.issuer, 'ExistingName');
  });
});

describe('applyImport × prefs', () => {
  test('prefs 变化时 prefsChanged=true', async () => {
    const payload = buildExportPayload([], makePrefs({ lockMinutes: 60 }));
    const r = await applyImport(payload, 'merge', {
      currentAccounts: [],
      currentPrefs: DEFAULT_PREFS,
      lockState: 'plaintext',
      derivedKey: null,
    });
    assert.equal(r.prefsChanged, true);
    assert.equal(r.finalPrefs.lockMinutes, 60);
  });

  test('prefs 一致时 prefsChanged=false', async () => {
    const payload = buildExportPayload([], DEFAULT_PREFS);
    const r = await applyImport(payload, 'merge', {
      currentAccounts: [],
      currentPrefs: DEFAULT_PREFS,
      lockState: 'plaintext',
      derivedKey: null,
    });
    assert.equal(r.prefsChanged, false);
  });
});

describe('applyImport × 错误账号', () => {
  test('账号字段畸形（issuer/label 都空） → 整条进 errors，valid 仍正常写', async () => {
    const good = makeAccount({ id: 'good' });
    const bad = { ...makeAccount({ id: 'bad' }), issuer: '', label: '' };
    const payload = buildExportPayload([good, bad] as Account[], DEFAULT_PREFS);
    const r = await applyImport(payload, 'merge', {
      currentAccounts: [],
      currentPrefs: DEFAULT_PREFS,
      lockState: 'plaintext',
      derivedKey: null,
    });
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]!.id, 'bad');
    assert.equal(r.added.length, 1);
    assert.equal(r.added[0], 'good');
  });
});
