/**
 * M8-a 单元测试：crypto.ts 加解密原语。
 *
 *   node --test tests/crypto.test.ts
 *
 * 用 Node 24 内置的 WebCrypto（globalThis.crypto）跑，不需要浏览器。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveKey,
  encrypt,
  decrypt,
  serializeEncrypted,
  parseEncrypted,
  isEncryptedSecret,
  randomBytes,
  randomSalt,
  PBKDF2_ITER,
  VERIFIER_PLAINTEXT,
} from '../lib/crypto.ts';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('randomBytes', () => {
  test('生成指定长度的字节', () => {
    const r = randomBytes(16);
    assert.ok(r instanceof Uint8Array);
    assert.equal(r.length, 16);
  });

  test('两次调用产出不同字节（伪随机性）', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    assert.notEqual(toHex(a), toHex(b));
  });
});

describe('randomSalt', () => {
  test('默认 16 字节（PBKDF2 推荐长度）', () => {
    assert.equal(randomSalt().length, 16);
  });
});

describe('deriveKey', () => {
  test('相同 (password, salt, iter) → 相同 key', async () => {
    const salt = randomSalt();
    const k1 = await deriveKey('hunter2', salt);
    const k2 = await deriveKey('hunter2', salt);
    assert.equal(toHex(k1), toHex(k2));
  });

  test('不同密码 → 不同 key', async () => {
    const salt = randomSalt();
    const k1 = await deriveKey('hunter2', salt);
    const k2 = await deriveKey('hunter3', salt);
    assert.notEqual(toHex(k1), toHex(k2));
  });

  test('不同 salt → 不同 key', async () => {
    const k1 = await deriveKey('hunter2', randomSalt());
    const k2 = await deriveKey('hunter2', randomSalt());
    assert.notEqual(toHex(k1), toHex(k2));
  });

  test('返回 32 字节（AES-256）', async () => {
    const k = await deriveKey('anything', randomSalt(), 1000);
    assert.equal(k.length, 32);
  });

  test('PBKDF2_ITER = 600_000 (OWASP 2023+ 推荐值)', () => {
    assert.equal(PBKDF2_ITER, 600_000);
  });
});

describe('encrypt + decrypt roundtrip', () => {
  test('encrypt → decrypt 还原明文', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const { iv, ciphertext } = await encrypt('JBSWY3DPEHPK3PXP', key);
    const back = await decrypt(iv, ciphertext, key);
    assert.equal(back, 'JBSWY3DPEHPK3PXP');
  });

  test('每次 encrypt 用不同 IV（GCM IV 重用是灾难）', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const a = await encrypt('hello', key);
    const b = await encrypt('hello', key);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  test('错 key 解密抛 OperationError', async () => {
    const key1 = await deriveKey('password1', randomSalt(), 1000);
    const key2 = await deriveKey('password2', randomSalt(), 1000);
    const { iv, ciphertext } = await encrypt('secret', key1);
    await assert.rejects(decrypt(iv, ciphertext, key2), /OperationError|decrypt/i);
  });

  test('IV 长度错误抛错', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    await assert.rejects(decrypt('short', 'aaaa', key), /OperationError|invalid/i);
  });

  test('空字符串加解密', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const { iv, ciphertext } = await encrypt('', key);
    assert.equal(await decrypt(iv, ciphertext, key), '');
  });

  test('长字符串（含中文）加解密', async () => {
    const key = await deriveKey('mypassword', randomSalt(), 1000);
    const long = '验证码：' + 'a'.repeat(1000);
    const { iv, ciphertext } = await encrypt(long, key);
    assert.equal(await decrypt(iv, ciphertext, key), long);
  });
});

describe('enc1 序列化', () => {
  test('serializeEncrypted 拼出 enc1:iv:ct', () => {
    assert.equal(serializeEncrypted('AAA', 'BBB'), 'enc1:AAA:BBB');
  });

  test('parseEncrypted 反向解析', () => {
    const parsed = parseEncrypted('enc1:AAA:BBB');
    assert.deepEqual(parsed, { iv: 'AAA', ciphertext: 'BBB' });
  });

  test('parseEncrypted 处理 base64 含特殊字符', async () => {
    const { iv, ciphertext } = await encrypt('x', await deriveKey('p', randomSalt(), 1000));
    const s = serializeEncrypted(iv, ciphertext);
    const parsed = parseEncrypted(s);
    assert.ok(parsed);
    assert.equal(parsed!.iv, iv);
    assert.equal(parsed!.ciphertext, ciphertext);
  });

  test('parseEncrypted 对非 enc1 字符串返回 null', () => {
    assert.equal(parseEncrypted('JBSWY3DPEHPK3PXP'), null);
    assert.equal(parseEncrypted(''), null);
    assert.equal(parseEncrypted('enc1:nocolon'), null);
  });

  test('parseEncrypted 对缺末尾 ciphertext 的返回 null', () => {
    assert.equal(parseEncrypted('enc1:AAA:'), null);
  });

  test('isEncryptedSecret 识别前缀', () => {
    assert.equal(isEncryptedSecret('enc1:foo:bar'), true);
    assert.equal(isEncryptedSecret('JBSWY3DPEHPK3PXP'), false);
    assert.equal(isEncryptedSecret(''), false);
  });
});

describe('VERIFIER_PLAINTEXT', () => {
  test('是非空常量字符串', () => {
    assert.ok(typeof VERIFIER_PLAINTEXT === 'string');
    assert.ok(VERIFIER_PLAINTEXT.length > 0);
  });

  test('加密 verifier 后能解回原值（端到端验证）', async () => {
    const key = await deriveKey('master', randomSalt(), 1000);
    const { iv, ciphertext } = await encrypt(VERIFIER_PLAINTEXT, key);
    assert.equal(await decrypt(iv, ciphertext, key), VERIFIER_PLAINTEXT);
  });
});