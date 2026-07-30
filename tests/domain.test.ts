/**
 * M6 单元测试：域名归一化、registrable 提取、匹配规则。
 *
 *   node --test tests/domain.test.ts
 *
 * lib/domain.ts 是纯函数，没有浏览器依赖，直接跑 TypeScript。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeHost,
  registrableDomain,
  matchHost,
  anyMatch,
  isSharedHost,
} from '../lib/domain.ts';

describe('normalizeHost', () => {
  test('lowercases', () => {
    assert.equal(normalizeHost('GitHub.COM'), 'github.com');
  });
  test('strips port', () => {
    assert.equal(normalizeHost('gist.github.com:8080'), 'gist.github.com');
    // IPv6 不切，避免把 ::1 误伤
    assert.equal(normalizeHost('[::1]:80'), '[::1]:80');
  });
  test('strips trailing dot', () => {
    assert.equal(normalizeHost('github.com.'), 'github.com');
  });
  test('trims whitespace', () => {
    assert.equal(normalizeHost('  github.com  '), 'github.com');
  });
});

describe('registrableDomain', () => {
  test('two-label host', () => {
    assert.equal(registrableDomain('github.com'), 'github.com');
  });
  test('three-label host collapses to registrable', () => {
    assert.equal(registrableDomain('gist.github.com'), 'github.com');
    assert.equal(registrableDomain('www.github.com'), 'github.com');
  });
  test('multi-part TLD co.uk preserved', () => {
    assert.equal(registrableDomain('foo.co.uk'), 'foo.co.uk');
    assert.equal(registrableDomain('a.b.foo.co.uk'), 'foo.co.uk');
  });
  test('multi-part TLD com.cn', () => {
    assert.equal(registrableDomain('example.com.cn'), 'example.com.cn');
  });
  test('shared domain github.io kept as-is', () => {
    assert.equal(registrableDomain('octocat.github.io'), 'octocat.github.io');
  });
  test('shared domain vercel.app', () => {
    assert.equal(registrableDomain('my-site.vercel.app'), 'my-site.vercel.app');
  });
  test('single label returned as-is', () => {
    assert.equal(registrableDomain('localhost'), 'localhost');
    assert.equal(registrableDomain(''), '');
  });
});

describe('isSharedHost', () => {
  test('github.io is shared', () => {
    assert.equal(isSharedHost('octocat.github.io'), true);
  });
  test('vercel.app is shared', () => {
    assert.equal(isSharedHost('foo.vercel.app'), true);
  });
  test('plain github.com is not shared', () => {
    assert.equal(isSharedHost('github.com'), false);
  });
});

describe('matchHost', () => {
  test('exact match', () => {
    assert.deepEqual(matchHost('github.com', 'github.com'), { hit: true, mode: 'exact' });
  });
  test('subdomain match via registrable', () => {
    assert.deepEqual(matchHost('gist.github.com', 'github.com'), { hit: true, mode: 'subdomain' });
    assert.deepEqual(matchHost('www.github.com', 'github.com'), { hit: true, mode: 'subdomain' });
  });
  test('subdomain does not cross registrable', () => {
    assert.deepEqual(matchHost('notgithub.com', 'github.com'), { hit: false, mode: 'none' });
    assert.deepEqual(matchHost('github.com.evil.com', 'github.com'), { hit: false, mode: 'none' });
  });
  test('shared domain only matches exactly', () => {
    assert.deepEqual(matchHost('octocat.github.io', 'octocat.github.io'), {
      hit: true,
      mode: 'shared',
    });
    // 绑 octocat.github.io 不能命中 torvalds.github.io
    assert.deepEqual(matchHost('torvalds.github.io', 'octocat.github.io'), { hit: false, mode: 'none' });
  });
  test('multi-part TLD matching', () => {
    assert.deepEqual(matchHost('a.foo.co.uk', 'foo.co.uk'), { hit: true, mode: 'subdomain' });
  });
  test('empty inputs', () => {
    assert.deepEqual(matchHost('', 'github.com'), { hit: false, mode: 'none' });
    assert.deepEqual(matchHost('github.com', ''), { hit: false, mode: 'none' });
  });
});

describe('anyMatch', () => {
  test('any of multiple bindings hits', () => {
    const bounds = ['google.com', 'github.com'];
    assert.equal(anyMatch('gist.github.com', bounds).hit, true);
  });
  test('none hits', () => {
    assert.equal(anyMatch('notgithub.com', ['google.com', 'github.com']).hit, false);
  });
  test('empty bounds', () => {
    assert.equal(anyMatch('github.com', []).hit, false);
  });
});