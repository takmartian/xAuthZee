#!/usr/bin/env node
/**
 * 发布新版本到 Chrome Web Store。
 *
 *   npm run publish:chrome
 *
 * 官方流程（developer.chrome.com/docs/webstore/using-api）：
 *   1. 用 refresh token 换 access token
 *   2. upload —— POST /upload/v2/publishers/{publisherId}/items/{extId}:upload
 *      （ZIP 直接作为请求体；uploadState 为 IN_PROGRESS 时轮询 fetchStatus）
 *   3. publish —— POST /v2/publishers/{publisherId}/items/{extId}:publish
 *      （提交审核）
 *   4. fetchStatus —— 查审核状态
 *
 * 凭据从哪来（环境变量优先，其次钥匙串）：
 *   CHROME_CLIENT_ID       OAuth 客户端 ID（Web application 类型）
 *   CHROME_CLIENT_SECRET   OAuth 客户端密钥
 *   CHROME_REFRESH_TOKEN   OAuth Playground 换来的 refresh token
 *   CHROME_PUBLISHER_ID    开发者后台 Publisher > Settings 里的 Publisher ID
 *   CHROME_EXTENSION_ID    扩展 ID（默认小验子的那个）
 *   CHROME_PROXY           出网代理，默认 http://127.0.0.1:10890
 *
 * 密钥绝不落到仓库里：建议存进钥匙串
 *   security add-generic-password -a default -s chrome-webstore-publish \
 *     -w '<refresh_token>'
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://chromewebstore.googleapis.com';
const OAUTH = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const PROXY = process.env.CHROME_PROXY ?? 'http://127.0.0.1:10890';
const EXTENSION_ID = process.env.CHROME_EXTENSION_ID ?? 'ehldnhlefdildphjgilbfpflakochfif';

/** 环境变量 → 钥匙串 */
function credential(name, keychainAccount = 'default') {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const keychainService = 'chrome-webstore-publish';
  const res = spawnSync(
    'security',
    ['find-generic-password', '-a', keychainAccount, '-s', keychainService, '-w'],
    { encoding: 'utf8' },
  );
  const value = (res.stdout || '').trim();
  return value || null;
}

/** 跑一次 curl，返回 { status, body } */
function curl(args, { binary = false } = {}) {
  const full = ['-sS', '-x', PROXY, '--max-time', '180'];
  if (binary) full.push('-w', '\n%{http_code}');
  else full.push('-w', '\n%{http_code}');
  const res = spawnSync('curl', [...full, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (res.error) throw res.error;
  const out = res.stdout || '';
  const idx = out.lastIndexOf('\n');
  const body = out.slice(0, idx);
  const status = Number(out.slice(idx + 1).trim());
  return { status, body };
}

function fail(msg) {
  console.error('\n✗ ' + msg);
  process.exit(1);
}

// ------------------------------------------------------------------ 取凭据

const clientId = credential('CHROME_CLIENT_ID');
const clientSecret = credential('CHROME_CLIENT_SECRET');
const refreshToken = credential('CHROME_REFRESH_TOKEN');
const publisherId = credential('CHROME_PUBLISHER_ID');

const missing = [];
if (!clientId) missing.push('CHROME_CLIENT_ID');
if (!clientSecret) missing.push('CHROME_CLIENT_SECRET');
if (!refreshToken) missing.push('CHROME_REFRESH_TOKEN');
if (!publisherId) missing.push('CHROME_PUBLISHER_ID');
if (missing.length) {
  fail(
    '缺少凭据：' + missing.join(', ') + '\n' +
      '设置环境变量，或存进钥匙串：\n' +
      '  security add-generic-password -a default -s chrome-webstore-publish -w \'<refresh_token>\'',
  );
}

// ------------------------------------------------------------------ 1. 换 token

console.log('→ 换取 access token…');
const tokenRes = curl([
  '-X', 'POST',
  OAUTH,
  '-d', 'client_id=' + encodeURIComponent(clientId),
  '-d', 'client_secret=' + encodeURIComponent(clientSecret),
  '-d', 'refresh_token=' + encodeURIComponent(refreshToken),
  '-d', 'grant_type=refresh_token',
]);
if (tokenRes.status !== 200) fail('换取 access token 失败：' + tokenRes.body);
let tokenJson;
try {
  tokenJson = JSON.parse(tokenRes.body);
} catch {
  fail('access token 响应不是合法 JSON：' + tokenRes.body.slice(0, 200));
}
const accessToken = tokenJson.access_token;
if (!accessToken) fail('响应里没有 access_token：' + tokenRes.body.slice(0, 200));
console.log('  ✓ access_token 已获取（scope: ' + (tokenJson.scope || '?') + '）');

// ------------------------------------------------------------- 2. 定位 zip

const version = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
).version;
const zipPath = join(ROOT, '.output', 'xauthzee-' + version + '-chrome.zip');
if (!existsSync(zipPath)) {
  fail(
    '找不到发布包 ' + zipPath + '\n' +
      '先构建：npm run zip',
  );
}
console.log('→ 发布包：' + basename(zipPath) + '（version ' + version + '）');

const itemPath = 'publishers/' + publisherId + '/items/' + EXTENSION_ID;
const authHeader = 'Authorization: Bearer ' + accessToken;

// ---------------------------------------------------------------- 3. upload

console.log('→ 上传包…');
const uploadRes = curl([
  '-X', 'POST',
  '-H', authHeader,
  '-H', 'Content-Type: application/zip',
  '-T', zipPath,
  API + '/upload/v2/' + itemPath + ':upload',
]);
if (uploadRes.status !== 200) {
  fail('上传失败（HTTP ' + uploadRes.status + '）：\n' + uploadRes.body.slice(0, 800));
}
console.log('  ✓ 上传响应：' + uploadRes.body.trim().slice(0, 200));

// ------------------------------------------------------------ 4. 轮询状态

function fetchStatus() {
  const res = curl([
    '-X', 'GET',
    '-H', authHeader,
    API + '/v2/' + itemPath + ':fetchStatus',
  ]);
  if (res.status !== 200) return { error: res.body.slice(0, 300) };
  try {
    return JSON.parse(res.body);
  } catch {
    return { error: res.body.slice(0, 300) };
  }
}

let status = fetchStatus();
for (let i = 0; i < 20; i++) {
  const states = status.uploadState ?? status.reviewState ?? status.status;
  console.log('  · 状态：' + JSON.stringify(states).slice(0, 300));
  if (status.uploadState && status.uploadState !== 'IN_PROGRESS') break;
  if (!status.uploadState) break;
  // 上传中，稍等再查（这里用同步 sleep，脚本本来就是个一次性工具）
  spawnSync('sleep', ['3']);
  status = fetchStatus();
}

if (status.error) fail('查状态失败：' + status.error);

// ---------------------------------------------------------------- 5. publish

console.log('→ 提交审核…');
const publishRes = curl([
  '-X', 'POST',
  '-H', authHeader,
  API + '/v2/' + itemPath + ':publish',
]);
if (publishRes.status !== 200) {
  fail('提交审核失败（HTTP ' + publishRes.status + '）：\n' + publishRes.body.slice(0, 800));
}
console.log('  ✓ ' + publishRes.body.trim().slice(0, 300));

// -------------------------------------------------------------- 6. 最终状态

const final = fetchStatus();
console.log('\n最终状态：');
console.log(JSON.stringify(final, null, 2).slice(0, 1500));
console.log(
  '\n提交完成。审核通常 1-3 天，状态可查：\n' +
    '  curl -x ' + PROXY + ' -H "Authorization: Bearer $TOKEN" \\\n' +
    '    "' + API + '/v2/' + itemPath + ':fetchStatus"',
);
