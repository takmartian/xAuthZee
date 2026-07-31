/**
 * M8-b 单元测试：secrets.ts Account.secret 转换。
 *
 *   node --test tests/secrets.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  migrateSecret,
  revealSecret,
  migrateAccounts,
  revealAccounts,
  stripSecrets,
  isEncryptedSecret,
} from '../lib/secrets.ts';
import { deriveKey, randomSalt } from '../lib/crypto.ts';
import type { Account } from '../lib/model.ts';

function makeAccount(secret: string, id = 'a'): Account {
  return {
    id,
    issuer: 'GitHub',
    label: 'rex@example.com',
    secret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    domains: [],
    createdAt: 0,
  };
}

describe('isEncryptedSecret', () => {
  test('enc1: 前缀 → true', () => {
    assert.equal(isEncryptedSecret('enc1:AAA:BBB'), true);
  });

  test('Base32 明文 → false', () => {
    assert.equal(isEncryptedSecret('JBSWY3DPEHPK3PXP'), false);
  });

  test('空串 → false', () => {
    assert.equal(isEncryptedSecret(''), false);
  });
});

describe('migrateSecret', () => {
  test('明文 Base32 → enc1: 密文', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const enc = await migrateSecret('JBSWY3DPEHPK3PXP', key);
    assert.equal(isEncryptedSecret(enc), true);
    assert.notEqual(enc, 'JBSWY3DPEHPK3PXP');
  });

  test('已是 enc1: → 保持不变（幂等）', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const first = await migrateSecret('JBSWY3DPEHPK3PXP', key);
    const second = await migrateSecret(first, key);
    assert.equal(second, first);
  });

  test('空明文加密后能解密回空串', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const enc = await migrateSecret('', key);
    assert.equal(isEncryptedSecret(enc), true);
    const back = await revealSecret(enc, key);
    assert.equal(back, '');
  });
});

describe('revealSecret', () => {
  test('明文输入直接返回', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const back = await revealSecret('JBSWY3DPEHPK3PXP', key);
    assert.equal(back, 'JBSWY3DPEHPK3PXP');
  });

  test('enc1: 加密串用正确 key 解密回原值', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const enc = await migrateSecret('JBSWY3DPEHPK3PXP', key);
    assert.equal(await revealSecret(enc, key), 'JBSWY3DPEHPK3PXP');
  });

  test('enc1: 加密串用错 key 抛 OperationError', async () => {
    const key1 = await deriveKey('right', randomSalt(), 1000);
    const key2 = await deriveKey('wrong', randomSalt(), 1000);
    const enc = await migrateSecret('JBSWY3DPEHPK3PXP', key1);
    await assert.rejects(revealSecret(enc, key2), /decrypt|OperationError/i);
  });

  test('enc1: 加密串但 key=null 抛错', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const enc = await migrateSecret('JBSWY3DPEHPK3PXP', key);
    await assert.rejects(revealSecret(enc, null), /cannot reveal/i);
  });

  test('错位的 enc1: 格式（缺末尾）抛错', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    await assert.rejects(revealSecret('enc1:onlyonepart', key), /malformed/i);
  });
});

describe('migrateAccounts', () => {
  test('整组账号全部加密', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const accounts = [
      makeAccount('JBSWY3DPEHPK3PXP', 'a'),
      makeAccount('KRSXG5BAONSWG4TFOQ', 'b'),
    ];
    const enc = await migrateAccounts(accounts, key);
    assert.equal(enc.length, 2);
    assert.ok(enc.every((a) => isEncryptedSecret(a.secret)));
    assert.notEqual(enc[0]!.id, enc[1]!.id);
    // 用 revealSecret 能还原
    const back = await revealAccounts(enc, key);
    assert.equal(back[0]!.secret, 'JBSWY3DPEHPK3PXP');
    assert.equal(back[1]!.secret, 'KRSXG5BAONSWG4TFOQ');
  });

  test('不影响非 secret 字段（id / issuer / label / domains）', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const accounts = [{ ...makeAccount('JBSWY3DPEHPK3PXP'), domains: ['github.com'] }];
    const enc = await migrateAccounts(accounts, key);
    assert.equal(enc[0]!.id, 'a');
    assert.equal(enc[0]!.issuer, 'GitHub');
    assert.equal(enc[0]!.label, 'rex@example.com');
    assert.deepEqual(enc[0]!.domains, ['github.com']);
  });

  test('部分账号已加密 → 保持不变', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const encrypted = await migrateSecret('SECOND', key);
    const accounts = [
      makeAccount('FIRST', 'a'),
      makeAccount(encrypted, 'b'),
    ];
    const out = await migrateAccounts(accounts, key);
    assert.equal(isEncryptedSecret(out[0]!.secret), true);
    assert.equal(out[1]!.secret, encrypted); // 完全不变
  });

  test('空数组返回空数组', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const out = await migrateAccounts([], key);
    assert.deepEqual(out, []);
  });
});

describe('revealAccounts', () => {
  test('解密全部加密账号', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const enc = await migrateAccounts(
      [makeAccount('JBSWY3DPEHPK3PXP', 'a'), makeAccount('SECRET', 'b')],
      key,
    );
    const back = await revealAccounts(enc, key);
    assert.equal(back[0]!.secret, 'JBSWY3DPEHPK3PXP');
    assert.equal(back[1]!.secret, 'SECRET');
  });

  test('明文账号保持不变', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const out = await revealAccounts([makeAccount('JBSWY3DPEHPK3PXP')], key);
    assert.equal(out[0]!.secret, 'JBSWY3DPEHPK3PXP');
  });
});

describe('stripSecrets', () => {
  test('所有 secret 清成空串', () => {
    const accounts = [makeAccount('FIRST', 'a'), makeAccount('SECOND', 'b')];
    const stripped = stripSecrets(accounts);
    assert.ok(stripped.every((a) => a.secret === ''));
    assert.equal(stripped.length, 2);
  });

  test('不修改入参（纯函数）', () => {
    const accounts = [makeAccount('JBSWY3DPEHPK3PXP')];
    const stripped = stripSecrets(accounts);
    assert.equal(accounts[0]!.secret, 'JBSWY3DPEHPK3PXP');
    assert.notEqual(stripped[0], accounts[0]);
  });

  test('其他字段保持', () => {
    const accounts = [{ ...makeAccount('x'), domains: ['github.com'] }];
    const stripped = stripSecrets(accounts);
    assert.deepEqual(stripped[0]!.domains, ['github.com']);
    assert.equal(stripped[0]!.issuer, 'GitHub');
  });

  test('空数组返回空数组', () => {
    assert.deepEqual(stripSecrets([]), []);
  });
});