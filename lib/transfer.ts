/**
 * M9：JSON 导入导出。
 *
 * 设计：
 *   - **明文导出**：secret 直接写在 JSON 里。用户用任何 TOTP 应用都能导入。
 *     加密态下，调用方在调用 exportAccounts 之前必须自己用 revealAccounts
 *     把 secret 解密成明文（这样把"明文 secret 出 vault"的责任放在调用方）。
 *   - **导入策略**：merge（按 id 去重，已有不动）/ overwrite（已有 id 用导入
 *     数据替换）/ skip（同 id 整条跳过）。三种策略对 vault 索引都要求按
 *     追加 / 替换模式写入。
 *   - **加密态导入**：当前 unlocked → 用 migrateSecret 把明文 secret 重加密
 *     成 enc1:...；plaintext → 原样写明文；locked → 拒绝（导入文件本身的
 *     secret 是明文，写入后无法解密）。
 *
 * 模块刻意不依赖 browser（除了最后落盘用的 Blob/URL）—— 这样可以在
 * node --test 里完整跑 schema 校验 / 策略合并逻辑。
 */

import { isEncryptedSecret, migrateSecret } from './secrets.ts';
import { normalizeDraft, type Account, type Prefs } from './model.ts';
import { deriveKey, encrypt, decrypt, PBKDF2_ITER, bytesToB64, b64ToBytes, randomSalt } from './crypto.ts';
import pkg from '../package.json' with { type: 'json' };

/** 导出文件 schema 版本。改了格式要 +1，让导入端做迁移。 */
export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_SCHEMA_NAME = 'xauthzee-accounts';
/** 加密导出的 schema。区分点是顶层 `schema` 字段。 */
export const EXPORT_SCHEMA_NAME_ENCRYPTED = 'xauthzee-encrypted-export';

export interface ExportPayload {
  version: 1;
  schema: typeof EXPORT_SCHEMA_NAME;
  exportedAt: string;
  app: { name: 'XAuthZee'; version: string };
  accounts: Account[];
  prefs: Prefs;
}

/**
 * 加密导出的外层结构。
 *
 * 设计选择：
 *   - **不嵌入明文 payload**——避免「加密文件也能当明文读」造成混淆。
 *   - KDF 参数（iter）每次可不同（未来调 iter 不破坏向后兼容）。
 *   - 整个 inner plain payload 是 `JSON.stringify(plain)`，按字节加密：
 *     解密后是字符串，再 `JSON.parse` 进 ExportPayload 走原路径。
 */
export interface EncryptedExportPayload {
  version: 1;
  schema: typeof EXPORT_SCHEMA_NAME_ENCRYPTED;
  exportedAt: string;
  app: { name: 'XAuthZee'; version: string };
  kdf: { name: 'PBKDF2-SHA256'; iter: number; salt: string };
  iv: string;
  ciphertext: string;
}

export type ImportMode = 'merge' | 'overwrite' | 'skip';

export interface ImportResult {
  /** mode=overwrite 时：被覆盖的 id 列表。 */
  updated: string[];
  /** mode=merge / overwrite / skip 时：新增的 id 列表。 */
  added: string[];
  /** mode=skip 时：被跳过的 id 列表。 */
  skipped: string[];
  /** 任何账号格式错就记录在这里，整批不会写入。 */
  errors: Array<{ id?: string; message: string }>;
}

export type TransferError =
  | 'not_json'
  | 'wrong_schema'
  | 'wrong_version'
  | 'missing_field'
  | 'wrong_type'
  | 'invalid_account'
  | 'wrong_password';

export interface ParseResult {
  /** 明文 schema 解析结果；密文 schema 或解析失败时为 null */
  payload: ExportPayload | null;
  /** 密文 schema 解析结果；明文 schema 或解析失败时为 null */
  encrypted: EncryptedExportPayload | null;
  errors: Array<{ code: TransferError; message: string }>;
}

// ------------------------------------------------------------ 导出

/**
 * 构造导出 payload。
 *
 * 调用方需自己保证 accounts 里的 secret 是明文（unlocked 态要先调
 * revealAccounts；locked 态不应触发导出——locked 态下没有 secret，导出
 * 出来也是空壳）。
 */
export function buildExportPayload(
  accounts: readonly Account[],
  prefs: Prefs,
): ExportPayload {
  return {
    version: EXPORT_SCHEMA_VERSION,
    schema: EXPORT_SCHEMA_NAME,
    exportedAt: new Date().toISOString(),
    app: { name: 'XAuthZee', version: pkg.version },
    // 防御性深拷贝：避免外部修改穿透到导出的对象
    accounts: accounts.map((a) => ({
      ...a,
      domains: [...a.domains],
    })),
    prefs: { ...prefs, disabledHosts: [...prefs.disabledHosts] },
  };
}

/**
 * 把 payload 序列化成 JSON 字符串。统一缩进 2 空格，方便用户肉眼看。
 */
export function serializeExport(payload: ExportPayload): string {
  return JSON.stringify(payload, null, 2);
}

/** 加密 payload 序列化：与明文用同样的缩进风格 */
export function serializeEncryptedExport(payload: EncryptedExportPayload): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * 触发浏览器下载。文件名前缀固定为 xauthzee-export-，后面跟本地时
 * 间戳到分钟：人类可读 + 按时间排序友好。
 *
 * 加密文件加 `-encrypted` 后缀，让用户一眼区分。下载用 application/json
 * 即可——内容是 base64 字段，不存在执行风险。
 */
export function downloadExport(payload: ExportPayload, filename?: string): void {
  downloadText(serializeExport(payload), filename ?? defaultExportFilename(false));
}

/** 加密导出下载。文件末尾追加 `-encrypted`。 */
export function downloadEncryptedExport(payload: EncryptedExportPayload, filename?: string): void {
  downloadText(serializeEncryptedExport(payload), filename ?? defaultExportFilename(true));
}

function downloadText(text: string, filename: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('downloadText requires a browser environment');
  }
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // 让浏览器有时间开始下载再释放（Chrome 一般几 ms 就开始抓 blob 了）
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function defaultExportFilename(encrypted: boolean): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return encrypted
    ? `xauthzee-export-${stamp}-encrypted.json`
    : `xauthzee-export-${stamp}.json`;
}

// ------------------------------------------------------------ 加密导出

/**
 * 把明文 payload 包成加密结构。
 *
 * 加密的是 `serializeExport(plain)` 的字符串本身，所以解密后直接
 * `JSON.parse` 就能回到原 ExportPayload（走 parseExport 一样的字段校验）。
 *
 * salt 每次随机——PBKDF2 推荐做法，避免两份文件用同样 salt 让攻击者
 * 同时字典攻击。
 */
export async function buildEncryptedExport(
  plain: ExportPayload,
  password: string,
): Promise<EncryptedExportPayload> {
  const salt = randomSalt();
  const key = await deriveKey(password, salt, PBKDF2_ITER);
  const { iv, ciphertext } = await encrypt(serializeExport(plain), key);
  return {
    version: EXPORT_SCHEMA_VERSION,
    schema: EXPORT_SCHEMA_NAME_ENCRYPTED,
    exportedAt: plain.exportedAt,
    app: { name: 'XAuthZee', version: pkg.version },
    kdf: { name: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: bytesToB64(salt) },
    iv,
    ciphertext,
  };
}

/**
 * 把加密 payload 用密码解出明文 payload。
 *
 * 错密码 / 篡改密文 / 字段错都通过 errors 数组返回，**不抛错**。AES-GCM
 * 自身会校验 auth tag，所以错密码直接抛 OperationError，我们翻译成
 * `wrong_password` 错误码。
 */
export async function decryptExportPayload(
  enc: EncryptedExportPayload,
  password: string,
): Promise<{ payload: ExportPayload | null; errors: ParseResult['errors'] }> {
  try {
    const salt = b64ToBytes(enc.kdf.salt);
    const key = await deriveKey(password, salt, enc.kdf.iter);
    const innerJson = await decrypt(enc.iv, enc.ciphertext, key);
    // 用 parseExport 一样的字段校验；这样内层 payload 字段错也能被抓到
    const inner = parseExport(innerJson);
    if (inner.errors.length || !inner.payload) {
      return { payload: null, errors: inner.errors };
    }
    return { payload: inner.payload, errors: [] };
  } catch (e) {
    // AES-GCM 错 key / 篡改 都抛 OperationError → "wrong_password" 是最贴切的解释
    return {
      payload: null,
      errors: [
        {
          code: 'wrong_password',
          message: e instanceof Error ? e.message : '解密失败',
        },
      ],
    };
  }
}

// ------------------------------------------------------------ 解析

const ALGOS = new Set(['SHA1', 'SHA256', 'SHA512']);

/**
 * 解析 JSON 文本，自动识别明文 / 密文 schema。
 *
 * 行为：
 *   - 顶层 `schema` 字段是 `xauthzee-accounts` → 校验明文字段、返回 plain payload
 *   - 顶层 `schema` 字段是 `xauthzee-encrypted-export` → 校验密文字段、返回 encrypted
 *   - 都不匹配 → 错误
 *   - 任何错误都进 `errors` 数组，不抛错
 *
 * 拿到 encrypted 后 UI 弹密码输入框再调 `decryptExportPayload`。
 */
export function parseExport(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      payload: null,
      encrypted: null,
      errors: [
        { code: 'not_json', message: e instanceof Error ? e.message : 'invalid JSON' },
      ],
    };
  }
  if (!isObject(raw)) {
    return {
      payload: null,
      encrypted: null,
      errors: [{ code: 'wrong_type', message: 'root must be object' }],
    };
  }
  const schema = raw['schema'];
  if (schema === EXPORT_SCHEMA_NAME) {
    return parsePlainExport(raw);
  }
  if (schema === EXPORT_SCHEMA_NAME_ENCRYPTED) {
    return parseEncryptedExportJson(raw);
  }
  return {
    payload: null,
    encrypted: null,
    errors: [
      {
        code: 'wrong_schema',
        message: `schema 必须是 ${EXPORT_SCHEMA_NAME} 或 ${EXPORT_SCHEMA_NAME_ENCRYPTED}`,
      },
    ],
  };
}

function parsePlainExport(raw: Record<string, unknown>): ParseResult {
  const errors: ParseResult['errors'] = [];
  if (raw['version'] !== EXPORT_SCHEMA_VERSION) {
    errors.push({ code: 'wrong_version', message: `version 必须是 ${EXPORT_SCHEMA_VERSION}` });
  }
  if (typeof raw['exportedAt'] !== 'string') {
    errors.push({ code: 'missing_field', message: 'exportedAt 必须是字符串' });
  }
  const app = raw['app'];
  if (!isObject(app) || app['name'] !== 'XAuthZee') {
    errors.push({ code: 'missing_field', message: 'app.name 必须是 XAuthZee' });
  }
  if (!Array.isArray(raw['accounts'])) {
    errors.push({ code: 'wrong_type', message: 'accounts 必须是数组' });
  }
  if (errors.length > 0) {
    return { payload: null, encrypted: null, errors };
  }

  const accountsRaw = raw['accounts'] as unknown[];
  const accounts: Account[] = [];
  for (const a of accountsRaw) {
    const parsed = parseAccount(a);
    if (typeof parsed === 'string') {
      errors.push({ code: 'invalid_account', message: parsed });
    } else {
      accounts.push(parsed);
    }
  }
  if (errors.length > 0) {
    return { payload: null, encrypted: null, errors };
  }
  const prefs = parsePrefs(raw['prefs']);
  if (typeof prefs === 'string') {
    return {
      payload: null,
      encrypted: null,
      errors: [{ code: 'missing_field', message: `prefs: ${prefs}` }],
    };
  }
  return {
    payload: {
      version: EXPORT_SCHEMA_VERSION,
      schema: EXPORT_SCHEMA_NAME,
      exportedAt: raw['exportedAt'] as string,
      app: { name: 'XAuthZee', version: (app as Record<string, unknown>)['version'] as string },
      accounts,
      prefs,
    },
    encrypted: null,
    errors: [],
  };
}

function parseEncryptedExportJson(raw: Record<string, unknown>): ParseResult {
  const errors: ParseResult['errors'] = [];
  if (raw['version'] !== EXPORT_SCHEMA_VERSION) {
    errors.push({ code: 'wrong_version', message: `version 必须是 ${EXPORT_SCHEMA_VERSION}` });
  }
  if (typeof raw['exportedAt'] !== 'string') {
    errors.push({ code: 'missing_field', message: 'exportedAt 必须是字符串' });
  }
  const app = raw['app'];
  if (!isObject(app) || app['name'] !== 'XAuthZee') {
    errors.push({ code: 'missing_field', message: 'app.name 必须是 XAuthZee' });
  }
  const kdf = raw['kdf'];
  if (!isObject(kdf) || kdf['name'] !== 'PBKDF2-SHA256') {
    errors.push({ code: 'missing_field', message: 'kdf.name 必须是 PBKDF2-SHA256' });
  }
  if (isObject(kdf) && typeof kdf['iter'] !== 'number') {
    errors.push({ code: 'missing_field', message: 'kdf.iter 必须是数字' });
  }
  if (isObject(kdf) && typeof kdf['salt'] !== 'string') {
    errors.push({ code: 'missing_field', message: 'kdf.salt 必须是字符串' });
  }
  if (typeof raw['iv'] !== 'string') {
    errors.push({ code: 'missing_field', message: 'iv 必须是字符串' });
  }
  if (typeof raw['ciphertext'] !== 'string') {
    errors.push({ code: 'missing_field', message: 'ciphertext 必须是字符串' });
  }
  if (errors.length > 0) {
    return { payload: null, encrypted: null, errors };
  }
  return {
    payload: null,
    encrypted: {
      version: EXPORT_SCHEMA_VERSION,
      schema: EXPORT_SCHEMA_NAME_ENCRYPTED,
      exportedAt: raw['exportedAt'] as string,
      app: { name: 'XAuthZee', version: (app as Record<string, unknown>)['version'] as string },
      kdf: {
        name: 'PBKDF2-SHA256',
        iter: (kdf as Record<string, unknown>)['iter'] as number,
        salt: (kdf as Record<string, unknown>)['salt'] as string,
      },
      iv: raw['iv'] as string,
      ciphertext: raw['ciphertext'] as string,
    },
    errors: [],
  };
}

function parseAccount(raw: unknown): Account | string {
  if (!isObject(raw)) return '账号必须是对象';
  const id = raw['id'];
  const issuer = raw['issuer'];
  const label = raw['label'];
  const secret = raw['secret'];
  const algorithm = raw['algorithm'];
  const digits = raw['digits'];
  const period = raw['period'];
  const domains = raw['domains'];
  const createdAt = raw['createdAt'];
  if (typeof id !== 'string' || !id) return 'id 必须是非空字符串';
  if (typeof issuer !== 'string') return 'issuer 必须是字符串';
  if (typeof label !== 'string') return 'label 必须是字符串';
  if (typeof secret !== 'string' || !secret) return 'secret 必须是非空字符串';
  if (typeof algorithm !== 'string' || !ALGOS.has(algorithm)) return 'algorithm 非法';
  if (typeof digits !== 'number' || digits < 6 || digits > 10) return 'digits 必须在 6..10';
  if (typeof period !== 'number' || period < 10 || period > 300) return 'period 必须在 10..300';
  if (!Array.isArray(domains) || domains.some((d) => typeof d !== 'string')) {
    return 'domains 必须是字符串数组';
  }
  if (typeof createdAt !== 'number') return 'createdAt 必须是数字';
  return {
    id,
    issuer,
    label,
    secret,
    algorithm: algorithm as Account['algorithm'],
    digits,
    period,
    domains: domains as string[],
    createdAt,
  };
}

function parsePrefs(raw: unknown): Prefs | string {
  if (!isObject(raw)) return '必须是对象';
  const panelEnabled = raw['panelEnabled'];
  const broadDetection = raw['broadDetection'];
  const disabledHosts = raw['disabledHosts'];
  const lockMinutes = raw['lockMinutes'];
  if (typeof panelEnabled !== 'boolean') return 'panelEnabled 必须是 boolean';
  if (typeof broadDetection !== 'boolean') return 'broadDetection 必须是 boolean';
  if (!Array.isArray(disabledHosts) || disabledHosts.some((h) => typeof h !== 'string')) {
    return 'disabledHosts 必须是字符串数组';
  }
  if (typeof lockMinutes !== 'number' || lockMinutes < 0) return 'lockMinutes 必须是非负数';
  return {
    panelEnabled,
    broadDetection,
    disabledHosts: disabledHosts as string[],
    lockMinutes,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ------------------------------------------------------------ 导入

export interface ImportContext {
  /** 当前 vault 里的账号（用来判 merge/overwrite） */
  currentAccounts: readonly Account[];
  /** 当前 vault 里的 prefs（用于判断是否需要写回） */
  currentPrefs: Prefs;
  /**
   * 锁状态：
   *   - plaintext：导入的明文 secret 原样写
   *   - unlocked：用 key 把明文 secret 重加密成 enc1:
   *   - locked：拒绝导入
   */
  lockState: 'plaintext' | 'unlocked' | 'locked';
  /** unlocked 时必传；plaintext/locked 时忽略 */
  derivedKey: Uint8Array | null;
}

export interface ImportOutcome extends ImportResult {
  /** 合并后应当写回 vault 的账号（按原顺序，去重）。调用方负责真正写。 */
  finalAccounts: Account[];
  /** prefs 是否需要更新（任意字段变化都算 true） */
  prefsChanged: boolean;
  /** 实际应用的 prefs */
  finalPrefs: Prefs;
}

/**
 * 把 payload 应用到当前 vault，返回最终结果。**不**直接写 vault——调用方
 * 拿到 finalAccounts / finalPrefs 后自己 update / add / setPrefs。
 */
export async function applyImport(
  payload: ExportPayload,
  mode: ImportMode,
  ctx: ImportContext,
): Promise<ImportOutcome> {
  const errors: ImportResult['errors'] = [];
  const updated: string[] = [];
  const added: string[] = [];
  const skipped: string[] = [];

  if (ctx.lockState === 'locked') {
    return {
      updated,
      added,
      skipped,
      errors: [{ message: '已锁定：解锁后再导入' }],
      finalAccounts: [...ctx.currentAccounts],
      prefsChanged: false,
      finalPrefs: ctx.currentPrefs,
    };
  }

  // 索引当前账号，方便 O(1) 查 id 是否存在
  const currentById = new Map(ctx.currentAccounts.map((a) => [a.id, a]));

  // 输出账号按「原有账号（按原顺序） + 追加的导入账号」合并
  const out: Account[] = [...ctx.currentAccounts];

  for (const incoming of payload.accounts) {
    const exists = currentById.has(incoming.id);
    if (exists) {
      if (mode === 'skip') {
        skipped.push(incoming.id);
        continue;
      }
      if (mode === 'merge') {
        // 已有 id 不动：merge 模式下"已存在的完全不动"
        continue;
      }
      // overwrite：用导入数据替换
      try {
        const next = await prepareForWrite(incoming, ctx);
        const idx = out.findIndex((a) => a.id === next.id);
        if (idx >= 0) out[idx] = next;
        updated.push(next.id);
      } catch (e) {
        errors.push({ id: incoming.id, message: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }
    // 新 id：三种模式都追加
    try {
      const next = await prepareForWrite(incoming, ctx);
      out.push(next);
      added.push(next.id);
    } catch (e) {
      errors.push({ id: incoming.id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  const prefsChanged = !prefsEqual(payload.prefs, ctx.currentPrefs);
  // 直接用 payload.prefs 覆盖（导入场景下用户期望 prefs 跟文件一致）
  return {
    updated,
    added,
    skipped,
    errors,
    finalAccounts: out,
    prefsChanged,
    finalPrefs: { ...payload.prefs, disabledHosts: [...payload.prefs.disabledHosts] },
  };
}

function prefsEqual(a: Prefs, b: Prefs): boolean {
  if (a.panelEnabled !== b.panelEnabled) return false;
  if (a.broadDetection !== b.broadDetection) return false;
  if (a.lockMinutes !== b.lockMinutes) return false;
  if (a.disabledHosts.length !== b.disabledHosts.length) return false;
  return a.disabledHosts.every((h, i) => h === b.disabledHosts[i]);
}

/**
 * 准备写入的账号：跑一遍 normalizeDraft 校验（拒绝畸形）+ 加密态下重加密。
 */
async function prepareForWrite(
  incoming: Account,
  ctx: ImportContext,
): Promise<Account> {
  // 走 normalizeDraft 校验（issuer/label trim、domains 去重等）
  const draft = normalizeDraft({
    issuer: incoming.issuer,
    label: incoming.label,
    secret: incoming.secret,
    algorithm: incoming.algorithm,
    digits: incoming.digits,
    period: incoming.period,
    domains: incoming.domains,
  });
  let secret = draft.secret!;
  if (ctx.lockState === 'unlocked' && ctx.derivedKey) {
    // 文件里是明文，vault 是密文 —— 走迁移
    if (!isEncryptedSecret(secret)) {
      secret = await migrateSecret(secret, ctx.derivedKey);
    }
    // 已是 enc1: 的奇怪情况（用户编辑过 JSON）保持原样
  }
  // plaintext：原样写
  return {
    ...incoming,
    issuer: draft.issuer!,
    label: draft.label!,
    secret,
    domains: draft.domains ?? [],
  };
}
