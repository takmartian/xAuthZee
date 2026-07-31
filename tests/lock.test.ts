/**
 * M8-c 单元测试：lib/lock.ts 锁状态机。
 *
 *   node --test tests/lock.test.ts
 *
 * 用 fake runtime（内存 sync / session / vault）跑，无需 mock 浏览器。
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getLockState,
  setupEncryption,
  unlock,
  lock,
  checkAutoLock,
  changePassword,
  disableEncryption,
  onLockChange,
  setLockRuntime,
  type LockRuntime,
  type SyncStorage,
  type SessionStorage,
  type VaultLike,
  type AlarmLike,
  type LockState,
} from '../lib/lock.ts';
import type { Account } from '../lib/model.ts';

// ------------------------------------------------------------ 测试替身

function fakeStorage() {
  const data: Record<string, unknown> = {};
  return {
    data,
    impl: {
      async get(key: string) {
        return { [key]: data[key] };
      },
      async set(items: Record<string, unknown>) {
        Object.assign(data, items);
      },
      async remove(key: string) {
        delete data[key];
      },
    } satisfies SyncStorage,
  };
}

function fakeSession() {
  const data: Record<string, unknown> = {};
  return {
    data,
    impl: {
      async get(key: string) {
        return { [key]: data[key] };
      },
      async set(items: Record<string, unknown>) {
        Object.assign(data, items);
      },
      async remove(key: string) {
        delete data[key];
      },
    } satisfies SessionStorage,
  };
}

function fakeVault(initial: Account[] = []) {
  const accounts = new Map<string, Account>(initial.map((a) => [a.id, a]));
  const prefs: { lockMinutes: number } = { lockMinutes: 15 };
  return {
    impl: {
      async list() {
        return [...accounts.values()];
      },
      async update(id: string, patch: Partial<Account>) {
        const cur = accounts.get(id);
        if (!cur) throw new Error(`no account ${id}`);
        accounts.set(id, { ...cur, ...patch });
      },
      async getPrefs() {
        return { ...prefs };
      },
      async setPrefs(patch: { lockMinutes?: number }) {
        Object.assign(prefs, patch);
      },
    } satisfies VaultLike,
    accounts,
    prefs,
  };
}

function fakeAlarm() {
  const alarms = new Map<string, { delayInMinutes: number }>();
  return {
    impl: {
      async create(name: string, info: { delayInMinutes: number }) {
        alarms.set(name, info);
      },
      async clear(name: string) {
        alarms.delete(name);
      },
    } satisfies AlarmLike,
    alarms,
  };
}

function makeAccount(id: string, secret: string, issuer = 'A'): Account {
  return {
    id,
    issuer,
    label: 'rex@example.com',
    secret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    domains: [],
    createdAt: 0,
  };
}

interface Runtime {
  rt: LockRuntime;
  sync: ReturnType<typeof fakeStorage>;
  session: ReturnType<typeof fakeSession>;
  vault: ReturnType<typeof fakeVault>;
  alarm: ReturnType<typeof fakeAlarm>;
  onChangeCbs: Array<(s: LockState) => void>;
  now: { t: number };
  fireChange(area: 'sync' | 'session', key: string): Promise<void>;
}

function makeRuntime(opts: {
  accounts?: Account[];
  lockMinutes?: number;
  hasAlarm?: boolean;
}): Runtime {
  const sync = fakeStorage();
  const session = fakeSession();
  const vault = fakeVault(opts.accounts);
  if (opts.lockMinutes !== undefined) vault.prefs.lockMinutes = opts.lockMinutes;
  const alarm = fakeAlarm();
  const onChangeCbs: Array<(s: LockState) => void> = [];
  const now = { t: 1_700_000_000_000 };

  const fireChange = async (area: 'sync' | 'session', key: string) => {
    void area;
    void key;
    // 简化：所有 storage 变动都通知订阅者
    for (const cb of onChangeCbs) {
      cb(await getLockState());
    }
  };

  // 让 onChange 能拿到我们的 fireChange —— 用闭包
  const rt: LockRuntime = {
    sync: {
      ...sync.impl,
      // 包一层 set / remove 让 fireChange 被调
      async set(items) {
        await sync.impl.set(items);
        await fireChange('sync', Object.keys(items)[0]!);
      },
      async remove(key) {
        await sync.impl.remove(key);
        await fireChange('sync', key);
      },
    },
    session: {
      ...session.impl,
      async set(items) {
        await session.impl.set(items);
        await fireChange('session', Object.keys(items)[0]!);
      },
      async remove(key) {
        await session.impl.remove(key);
        await fireChange('session', key);
      },
    },
    vault: vault.impl,
    alarm: opts.hasAlarm === false ? null : alarm.impl,
    now: () => now.t,
    onChange(cb) {
      onChangeCbs.push(cb);
      return () => {
        const i = onChangeCbs.indexOf(cb);
        if (i >= 0) onChangeCbs.splice(i, 1);
      };
    },
  };

  return { rt, sync, session, vault, alarm, onChangeCbs, now, fireChange };
}

// ------------------------------------------------------------ 测试

beforeEach(() => {
  // 每个用例前清 runtime（避免互相污染）
  // setLockRuntime(null) 不存在 —— 用一个新的卸载 trick：直接覆盖
  // 这里用 hasLockRuntime() 守住，没装的话 setLockRuntime 才生效。
});

describe('getLockState — 初始态', () => {
  test('新装的 vault：plaintext（无 sec 记录）', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    assert.equal(await getLockState(), 'plaintext');
  });
});

// 由于 setLockRuntime 是 singleton，每个用例必须自己重装以保证隔离。
// 用 activeUnset 在 beforeEach 里调上一次留下的卸载函数。

let activeUnset: (() => void) | null = null;
beforeEach(() => {
  if (activeUnset) activeUnset();
  activeUnset = null;
});

describe('三态转移', () => {
  test('plaintext → setupEncryption → unlocked', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('mypassword');
    assert.equal(await getLockState(), 'unlocked');
    assert.ok(r.sync.data['sec']); // sec 已写
    assert.ok(r.session.data['derivedKey']); // session key 已写
    assert.equal(r.session.data['unlockedAt'], r.now.t);
  });

  test('plaintext → setupEncryption → lock → locked', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('mypassword');
    await lock();
    assert.equal(await getLockState(), 'locked');
    assert.equal(r.session.data['derivedKey'], undefined);
    assert.equal(r.alarm.alarms.size, 0, 'alarm 应被清掉');
  });

  test('locked → unlock(正确密码) → unlocked', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('mypassword');
    await lock();
    assert.ok(await unlock('mypassword'));
    assert.equal(await getLockState(), 'unlocked');
  });

  test('locked → unlock(错密码) → 仍 locked', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('mypassword');
    await lock();
    assert.equal(await unlock('wrongpassword'), false);
    assert.equal(await getLockState(), 'locked');
  });

  test('plaintext 态 unlock 返回 false（没有 sec）', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    assert.equal(await unlock('anything'), false);
    assert.equal(await getLockState(), 'plaintext');
  });

  test('重复 setupEncryption 抛错', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p1');
    await assert.rejects(setupEncryption('p2'), /already enabled/i);
  });
});

describe('迁移现有账号', () => {
  test('启用加密 → 明文 secret 全部变 enc1:', async () => {
    const accounts = [
      makeAccount('a', 'JBSWY3DPEHPK3PXP', 'GitHub'),
      makeAccount('b', 'KRSXG5BAONSWG4TFOQ', 'AWS'),
    ];
    const r = makeRuntime({ accounts });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');

    const updated = await r.vault.impl.list();
    assert.ok(updated.every((a) => a.secret.startsWith('enc1:')));

    // 还能用同一密码解锁并解出原文
    await lock();
    assert.ok(await unlock('p'));
    // 上面 unlock 已经验证密码正确；再手动解密一个验证
    const sess = await r.session.impl.get('derivedKey');
    const key = Buffer.from(sess['derivedKey'] as string, 'base64');
    // 验证至少一个 secret 能解
    const { revealSecret } = await import('../lib/secrets.ts');
    const plain = await revealSecret(updated[0]!.secret, key);
    assert.equal(plain, 'JBSWY3DPEHPK3PXP');
  });

  test('部分账号已加密 → setupEncryption 幂等，不重写', async () => {
    const enc = await import('../lib/crypto.ts');
    const salt = enc.randomSalt();
    const key = await enc.deriveKey('existing', salt, 1000);
    const { iv, ciphertext } = await enc.encrypt('EXISTING_SECRET', key);
    const alreadyEncrypted = `enc1:${iv}:${ciphertext}`;

    const accounts = [
      makeAccount('a', 'JBSWY3DPEHPK3PXP'),
      makeAccount('b', alreadyEncrypted),
    ];
    const r = makeRuntime({ accounts });
    activeUnset = setLockRuntime(r.rt);

    await setupEncryption('p');

    const updated = await r.vault.impl.list();
    // a 被迁移了
    assert.ok(updated.find((a) => a.id === 'a')!.secret.startsWith('enc1:'));
    // b 已被不同密码加密，新密码 setupEncryption 不知道旧密码所以不解 b，
    // 但 b 仍以 enc1: 形式存在（迁移是幂等的：不重复处理 enc1:）
    assert.equal(updated.find((a) => a.id === 'b')!.secret, alreadyEncrypted);
  });
});

describe('changePassword', () => {
  test('错旧密码返回 false', async () => {
    const r = makeRuntime({ accounts: [makeAccount('a', 'SECRET')] });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('old');
    assert.equal(await changePassword('wrong', 'new'), false);
  });

  test('对旧密码 → 改成新密码后能用新密码解锁', async () => {
    const r = makeRuntime({ accounts: [makeAccount('a', 'SECRET')] });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('old');
    assert.ok(await changePassword('old', 'new'));
    await lock();
    assert.ok(await unlock('new'));
    assert.equal(await unlock('old'), false);
  });

  test('改密码后原 secret 仍能解出（用 new key）', async () => {
    const r = makeRuntime({ accounts: [makeAccount('a', 'SECRET')] });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('old');
    await changePassword('old', 'new');
    const updated = await r.vault.impl.list();
    assert.notEqual(updated[0]!.secret, 'SECRET'); // 已加密
    // 用当前 session 的 key 解密应得到原文
    const sess = await r.session.impl.get('derivedKey');
    const key = Buffer.from(sess['derivedKey'] as string, 'base64');
    const { revealSecret } = await import('../lib/secrets.ts');
    assert.equal(await revealSecret(updated[0]!.secret, key), 'SECRET');
  });
});

describe('disableEncryption', () => {
  test('plaintext 态 disable 返回 false', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    assert.equal(await disableEncryption('anything'), false);
  });

  test('错密码 disable 返回 false', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('right');
    assert.equal(await disableEncryption('wrong'), false);
  });

  test('对密码 → 删 sec + 解密所有 secret', async () => {
    const r = makeRuntime({ accounts: [makeAccount('a', 'SECRET')] });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');
    assert.ok(await disableEncryption('p'));
    assert.equal(await getLockState(), 'plaintext');
    assert.equal(r.sync.data['sec'], undefined);
    const updated = await r.vault.impl.list();
    assert.equal(updated[0]!.secret, 'SECRET');
  });
});

describe('checkAutoLock', () => {
  test('plaintext 态返回 false', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    assert.equal(await checkAutoLock(), false);
  });

  test('locked 态返回 false', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');
    await lock();
    r.now.t += 999 * 60_000;
    assert.equal(await checkAutoLock(), false);
  });

  test('unlocked 但未到 lockMinutes → false', async () => {
    const r = makeRuntime({ lockMinutes: 15 });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');
    r.now.t += 14 * 60_000;
    assert.equal(await checkAutoLock(), false);
    assert.equal(await getLockState(), 'unlocked');
  });

  test('unlocked 且已过 lockMinutes → 上锁 + 返回 true', async () => {
    const r = makeRuntime({ lockMinutes: 15 });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');
    r.now.t += 16 * 60_000;
    assert.equal(await checkAutoLock(), true);
    assert.equal(await getLockState(), 'locked');
  });

  test('lockMinutes = 0 → 永不超时', async () => {
    const r = makeRuntime({ lockMinutes: 0 });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');
    r.now.t += 9999 * 60_000;
    assert.equal(await checkAutoLock(), false);
    assert.equal(await getLockState(), 'unlocked');
  });
});

describe('auto-lock alarm', () => {
  test('unlock 后调度 alarm（lockMinutes=15）', async () => {
    const r = makeRuntime({ lockMinutes: 15 });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');
    assert.equal(r.alarm.alarms.size, 1);
    const alarm = [...r.alarm.alarms.values()][0]!;
    assert.equal(alarm.delayInMinutes, 15);
  });

  test('lockMinutes=0 → 不调度 alarm', async () => {
    const r = makeRuntime({ lockMinutes: 0 });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');
    assert.equal(r.alarm.alarms.size, 0);
  });

  test('lock() 清掉 alarm', async () => {
    const r = makeRuntime({ lockMinutes: 15 });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');
    await lock();
    assert.equal(r.alarm.alarms.size, 0);
  });

  test('alarm: null（不可用）也能正常解锁', async () => {
    const r = makeRuntime({ lockMinutes: 15, hasAlarm: false });
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');
    assert.equal(await getLockState(), 'unlocked');
  });
});

describe('onLockChange', () => {
  test('setupEncryption 触发回调', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    const states: LockState[] = [];
    const off = onLockChange((s) => states.push(s));
    await setupEncryption('p');
    assert.ok(states.includes('unlocked'));
    off();
  });

  test('lock 触发回调', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    await setupEncryption('p');
    const states: LockState[] = [];
    const off = onLockChange((s) => states.push(s));
    await lock();
    assert.ok(states.includes('locked'));
    off();
  });

  test('返回的卸载函数解绑回调', async () => {
    const r = makeRuntime({});
    activeUnset = setLockRuntime(r.rt);
    const states: LockState[] = [];
    const off = onLockChange((s) => states.push(s));
    off();
    await setupEncryption('p');
    assert.equal(states.length, 0);
  });
});