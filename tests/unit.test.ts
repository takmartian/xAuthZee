/**
 * M3 单元测试：数据模型、TOTP 计算、仓库读写。
 *
 *   node --test tests/unit.test.ts
 *
 * 直接跑 TypeScript，靠 Node 24 的类型擦除，不引入测试框架。
 * 被测的三个模块都不依赖浏览器 API —— vault 通过注入 StorageArea 解耦，
 * 这正是把它和 lib/storage.ts 拆开的原因。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Secret } from 'otpauth';

import {
  ValidationError,
  dedupeDomains,
  displayName,
  newAccountId,
  normalizeSecret,
  MAX_DOMAINS,
} from '../lib/model.ts';
import { generateCode, groupCode, parseOtpauthUri, OtpUriError } from '../lib/totp.ts';
import { createVault, SYNC_QUOTA, type StorageArea } from '../lib/vault.ts';

// ---------------------------------------------------------------- 测试替身

/** 内存版 StorageArea，并统计调用次数以验证写入合并 */
function fakeArea() {
  const data: Record<string, unknown> = {};
  const calls = { get: 0, set: 0, remove: 0 };

  const area: StorageArea = {
    async get() {
      calls.get++;
      return structuredClone(data);
    },
    async set(items) {
      calls.set++;
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      calls.remove++;
      for (const k of [keys].flat()) delete data[k];
    },
  };

  return { area, data, calls };
}

const draft = (over: Partial<Parameters<ReturnType<typeof createVault>['add']>[0]> = {}) => ({
  issuer: 'GitHub',
  label: 'rex@example.com',
  secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1' as const,
  digits: 6,
  period: 30,
  ...over,
});

// ------------------------------------------------------------------- 模型

describe('密钥归一化', () => {
  test('抹平大小写、空格、短横线与填充', () => {
    assert.equal(normalizeSecret('jbsw y3dp ehpk 3pxp'), 'JBSWY3DPEHPK3PXP');
    assert.equal(normalizeSecret('JBSW-Y3DP-EHPK-3PXP'), 'JBSWY3DPEHPK3PXP');
    assert.equal(normalizeSecret('JBSWY3DPEHPK3PXP===='), 'JBSWY3DPEHPK3PXP');
  });

  test('拒绝非法字符与过短输入，且错误码可区分', () => {
    // Base32 字母表是 A-Z2-7，0/1/8/9 都不合法，最常见的是把 O 打成 0
    assert.throws(() => normalizeSecret('JBSW0Y3DPEHPK'), (e: unknown) => (e as ValidationError).code === 'secret_charset');
    assert.throws(() => normalizeSecret('ABC'), (e: unknown) => (e as ValidationError).code === 'secret_too_short');
    assert.throws(() => normalizeSecret('   '), (e: unknown) => (e as ValidationError).code === 'secret_empty');
  });
});

describe('域名列表', () => {
  test('去重、小写化并截断到上限', () => {
    assert.deepEqual(dedupeDomains([' GitHub.com ', 'github.com', 'Gist.GitHub.com']), [
      'github.com',
      'gist.github.com',
    ]);
    assert.equal(dedupeDomains(Array.from({ length: 40 }, (_, i) => `d${i}.com`)).length, MAX_DOMAINS);
  });
});

test('账号 id 短且不重复', () => {
  const ids = new Set(Array.from({ length: 5000 }, newAccountId));
  assert.equal(ids.size, 5000);
  assert.equal([...ids][0]!.length, 10);
});

test('显示名兼顾只有其中一项的情况', () => {
  assert.equal(displayName({ issuer: 'GitHub', label: 'rex' }), 'GitHub (rex)');
  assert.equal(displayName({ issuer: '', label: 'rex' }), 'rex');
  assert.equal(displayName({ issuer: 'GitHub', label: '' }), 'GitHub');
});

// -------------------------------------------------------------------- TOTP

describe('RFC 6238 测试向量', () => {
  // RFC 6238 附录 B。种子是 ASCII "1234567890" 循环填充到各算法所需长度
  const seeds = {
    SHA1: Secret.fromUTF8('12345678901234567890').base32,
    SHA256: Secret.fromUTF8('12345678901234567890123456789012').base32,
    SHA512: Secret.fromUTF8(
      '1234567890123456789012345678901234567890123456789012345678901234',
    ).base32,
  };

  const VECTORS: Array<[number, string, string, string]> = [
    // 秒          SHA1        SHA256      SHA512
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];

  for (const [seconds, sha1, sha256, sha512] of VECTORS) {
    test(`T = ${seconds}`, () => {
      const at = seconds * 1000;
      const base = { digits: 8, period: 30 };
      assert.equal(generateCode({ ...base, algorithm: 'SHA1', secret: seeds.SHA1 }, at).code, sha1);
      assert.equal(
        generateCode({ ...base, algorithm: 'SHA256', secret: seeds.SHA256 }, at).code,
        sha256,
      );
      assert.equal(
        generateCode({ ...base, algorithm: 'SHA512', secret: seeds.SHA512 }, at).code,
        sha512,
      );
    });
  }
});

describe('倒计时', () => {
  const account = { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1' as const, digits: 6, period: 30 };

  test('周期起点剩余整个周期，末尾剩 1 秒', () => {
    assert.equal(generateCode(account, 1_700_000_010_000).secondsRemaining, 30);
    assert.equal(generateCode(account, 1_700_000_039_000).secondsRemaining, 1);
  });

  test('progress 单调递增且落在 [0,1)', () => {
    const start = 1_700_000_010_000;
    let previous = -1;
    for (let i = 0; i < 30; i++) {
      const { progress } = generateCode(account, start + i * 1000);
      assert.ok(progress >= 0 && progress < 1, `progress=${progress}`);
      assert.ok(progress > previous);
      previous = progress;
    }
  });

  test('同一周期内验证码不变，跨周期后改变', () => {
    const a = generateCode(account, 1_700_000_010_000).code;
    const b = generateCode(account, 1_700_000_039_999).code;
    const c = generateCode(account, 1_700_000_040_000).code;
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

test('验证码分组显示', () => {
  assert.equal(groupCode('492015'), '492 015');
  assert.equal(groupCode('12345678'), '1234 5678');
});

describe('otpauth:// 解析', () => {
  test('解析标准链接', () => {
    const d = parseOtpauthUri(
      'otpauth://totp/GitHub:rex@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30',
    );
    assert.equal(d.issuer, 'GitHub');
    assert.equal(d.label, 'rex@example.com');
    assert.equal(d.secret, 'JBSWY3DPEHPK3PXP');
    assert.equal(d.digits, 6);
    assert.equal(d.period, 30);
  });

  test('缺省参数回落到 RFC 默认值', () => {
    const d = parseOtpauthUri('otpauth://totp/Acme?secret=JBSWY3DPEHPK3PXP');
    assert.equal(d.algorithm, 'SHA1');
    assert.equal(d.digits, 6);
    assert.equal(d.period, 30);
  });

  test('几类无法处理的输入给出可区分的错误码', () => {
    // 用户扫到 Google Authenticator 的批量导出码是很常见的场景，
    // 必须和「这不是二维码」区分开，否则提示会误导人反复重扫
    assert.throws(
      () => parseOtpauthUri('otpauth-migration://offline?data=abc'),
      (e: unknown) => (e as OtpUriError).code === 'migration_unsupported',
    );
    assert.throws(
      () => parseOtpauthUri('otpauth://hotp/Acme?secret=JBSWY3DPEHPK3PXP&counter=1'),
      (e: unknown) => (e as OtpUriError).code === 'hotp_unsupported',
    );
    assert.throws(
      () => parseOtpauthUri('https://example.com'),
      (e: unknown) => (e as OtpUriError).code === 'not_otpauth',
    );
  });
});

// ------------------------------------------------------------------- 仓库

describe('仓库读写', () => {
  test('新增后可读出，且顺序与写入一致', async () => {
    const { area } = fakeArea();
    const vault = createVault(area, { debounceMs: 1 });

    const a = await vault.add(draft({ issuer: 'A' }));
    const b = await vault.add(draft({ issuer: 'B' }));
    await vault.flush();

    const list = await vault.list();
    assert.deepEqual(
      list.map((x) => x.issuer),
      ['A', 'B'],
    );
    assert.equal((await vault.get(a.id))?.issuer, 'A');
    assert.equal((await vault.get(b.id))?.issuer, 'B');
  });

  test('落盘前就能读到改动（乐观更新）', async () => {
    const { area, calls } = fakeArea();
    const vault = createVault(area, { debounceMs: 10_000 });

    await vault.add(draft({ issuer: 'Pending' }));
    const list = await vault.list();

    assert.equal(list.length, 1, '未落盘的新增也应出现在列表里');
    assert.equal(calls.set, 0, '此时确实还没有写过存储');
  });

  test('重排序只写 index 一条，不重写账号记录', async () => {
    const { area, data } = fakeArea();
    const vault = createVault(area, { debounceMs: 1 });

    const a = await vault.add(draft({ issuer: 'A' }));
    const b = await vault.add(draft({ issuer: 'B' }));
    const c = await vault.add(draft({ issuer: 'C' }));
    await vault.flush();

    const before = JSON.stringify(data[`acct:${a.id}`]);
    await vault.reorder([c.id, a.id, b.id]);
    await vault.flush();

    assert.deepEqual(
      (await vault.list()).map((x) => x.issuer),
      ['C', 'A', 'B'],
    );
    assert.equal(JSON.stringify(data[`acct:${a.id}`]), before, '账号记录不应被重排序改动');
  });

  test('删除同时清掉记录与索引', async () => {
    const { area, data } = fakeArea();
    const vault = createVault(area, { debounceMs: 1 });

    const a = await vault.add(draft({ issuer: 'A' }));
    const b = await vault.add(draft({ issuer: 'B' }));
    await vault.flush();

    await vault.remove(a.id);
    await vault.flush();

    assert.equal(Object.keys(data).filter((k) => k.startsWith('acct:')).length, 1);
    assert.deepEqual(data.index, [b.id]);
  });

  test('索引缺失时账号不会丢失', async () => {
    // 多设备同步或写入中断都可能造成索引与记录不一致，
    // 此时宁可顺序不对，也不能让用户的 2FA 账号凭空消失
    const { area, data } = fakeArea();
    const vault = createVault(area, { debounceMs: 1 });

    await vault.add(draft({ issuer: 'A' }));
    await vault.add(draft({ issuer: 'B' }));
    await vault.flush();
    delete data.index;

    assert.equal((await vault.list()).length, 2);
  });

  test('连续 50 次修改合并为极少数几次写入', async () => {
    const { area, calls } = fakeArea();
    const vault = createVault(area, { debounceMs: 50 });

    const account = await vault.add(draft());
    await vault.flush();
    const baseline = calls.set;

    for (let i = 0; i < 50; i++) {
      await vault.update(account.id, { issuer: `改名第 ${i} 次` });
    }
    await vault.flush();

    const writes = calls.set - baseline;
    assert.ok(writes <= 3, `50 次修改产生了 ${writes} 次写入，应当被合并`);
    assert.equal((await vault.list())[0]!.issuer, '改名第 49 次');
  });

  test('偏好设置有默认值且可局部覆盖', async () => {
    const { area } = fakeArea();
    const vault = createVault(area, { debounceMs: 1 });

    assert.equal((await vault.getPrefs()).panelEnabled, true);
    await vault.setPrefs({ lockMinutes: 5 });
    await vault.flush();

    const prefs = await vault.getPrefs();
    assert.equal(prefs.lockMinutes, 5);
    assert.equal(prefs.panelEnabled, true, '未提及的字段应保持默认值');
  });

  test('150 个账号仍在 sync 配额之内', async () => {
    const { area, data } = fakeArea();
    const vault = createVault(area, { debounceMs: 1 });

    for (let i = 0; i < 150; i++) {
      await vault.add(
        draft({
          issuer: `服务商名称示例 ${i}`,
          label: `user${i}@example.com`,
          domains: ['example.com', 'login.example.com'],
        }),
      );
    }
    await vault.flush();

    const report = await vault.usage();
    assert.equal((await vault.list()).length, 150);
    assert.ok(report.bytes < SYNC_QUOTA.totalBytes, `总量 ${report.bytes} 已超出 100KB 配额`);
    assert.ok(report.items < SYNC_QUOTA.maxItems, `条目数 ${report.items} 已超出 512 上限`);

    // 单条 8KB 上限同样致命：一旦某条超限，那个账号将永远存不进去
    for (const [key, value] of Object.entries(data)) {
      const size = key.length + JSON.stringify(value).length;
      assert.ok(size <= SYNC_QUOTA.bytesPerItem, `${key} 单条 ${size} 字节，超出 8KB 上限`);
    }
  });

  test('写入失败的改动会保留下来等待重试', async () => {
    // 直接丢弃会让用户以为已保存，重启后才发现丢了 —— 对 2FA 来说是灾难
    const { area } = fakeArea();
    let failNext = true;
    const flaky: StorageArea = {
      ...area,
      async set(items) {
        if (failNext) {
          failNext = false;
          throw new Error('QUOTA_BYTES quota exceeded');
        }
        return area.set(items);
      },
    };

    const vault = createVault(flaky, { debounceMs: 1 });
    await vault.add(draft({ issuer: '会先失败一次' }));
    await assert.rejects(() => vault.flush());

    await vault.flush();
    assert.equal((await vault.list())[0]?.issuer, '会先失败一次');
  });
});
