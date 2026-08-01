/**
 * 账号数据模型与校验。
 *
 * 这一层刻意不依赖任何浏览器 API，方便直接用 node --test 跑单元测试。
 */

export const ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const;
export type Algorithm = (typeof ALGORITHMS)[number];

/** RFC 6238 的默认参数，也是绝大多数服务实际使用的参数 */
export const DEFAULT_ALGORITHM: Algorithm = 'SHA1';
export const DEFAULT_DIGITS = 6;
export const DEFAULT_PERIOD = 30;

/** 单个账号最多绑定多少域名。上限存在的意义是防止 sync 单条超过 8KB */
export const MAX_DOMAINS = 16;

/**
 * 加密态密钥的前缀标记。
 *
 * Base32 字母表是 A-Z2-7，不含冒号，所以用带冒号的前缀区分明文与密文
 * 不会有歧义，也比多加一个布尔字段省存储空间（sync 配额很紧）。
 */
export const ENC_PREFIX = 'enc1:';

/**
 * 启用主密码加密时写入 storage.sync 的 `sec` 记录。
 *
 * - salt / iter 用于 PBKDF2 派生 key
 * - verifyIv / verifyCiphertext 是 verifier 明文加密后的密文；
 *   unlock 时尝试用派生 key 解密它，能解出 VERIFIER_PLAINTEXT 就算密码正确
 * - attempts / lastAttemptAt 是 M10 引入的「5 次错误自动 wipe」计数器：
 *   unlock 失败时 attempts+1、lastAttemptAt=now；超过 RESET_WINDOW_MS
 *   没再失败就视作归零。旧 sec 记录缺这两个字段，按 0 处理。
 */
export interface SecRecord {
  kdf: 'PBKDF2-SHA256';
  iter: number;
  /** base64 */
  salt: string;
  /** base64 */
  verifyIv: string;
  /** base64 */
  verifyCiphertext: string;
  /** 连续错误次数（兼容旧记录：缺省视为 0） */
  attempts?: number;
  /** 最后一次错误的时间戳（ms）。超 60 分钟视为归零 */
  lastAttemptAt?: number;
}

export interface Account {
  id: string;
  /** 服务方名称，如 GitHub。可能为空 */
  issuer: string;
  /** 账号标识，通常是邮箱或用户名 */
  label: string;
  /** 明文为 Base32；启用主密码后为 `enc1:<iv>:<密文>` */
  secret: string;
  algorithm: Algorithm;
  digits: number;
  period: number;
  /** 绑定的域名，小写、无端口。空数组表示未绑定 */
  domains: string[];
  createdAt: number;
}

/** 新增账号时的输入。id 与 createdAt 由 vault 生成 */
export type AccountDraft = Omit<Account, 'id' | 'createdAt' | 'domains'> &
  Partial<Pick<Account, 'domains'>>;

export interface Prefs {
  /** 聚焦 OTP 输入框时是否浮出候选面板 */
  panelEnabled: boolean;
  /** 是否启用宽松的输入框识别规则（见 lib/detect.ts） */
  broadDetection: boolean;
  /** 在这些域名上完全不显示浮层 */
  disabledHosts: string[];
  /** 主密码空闲多少分钟后自动上锁。0 表示不自动上锁 */
  lockMinutes: number;
}

export const DEFAULT_PREFS: Prefs = {
  panelEnabled: true,
  broadDetection: true,
  disabledHosts: [],
  lockMinutes: 15,
};

// ------------------------------------------------------------------ 校验

export type ValidationCode =
  | 'secret_empty'
  | 'secret_charset'
  | 'secret_too_short'
  | 'digits_range'
  | 'period_range'
  | 'algorithm_unknown'
  | 'label_empty';

export class ValidationError extends Error {
  // 显式声明字段而非用构造函数参数属性：Node 的类型擦除（node --test 直接跑
  // .ts 用得到）不支持 parameter property 语法
  readonly code: ValidationCode;

  constructor(code: ValidationCode) {
    super(code);
    this.name = 'ValidationError';
    this.code = code;
  }
}

/**
 * 归一化用户输入的 Base32 密钥。
 *
 * 各家服务展示密钥的方式五花八门：有的四位一组用空格分隔，有的用短横线，
 * 有的带 = 填充，有的是小写。全部抹平成规范形式，否则用户复制粘贴后
 * 会莫名其妙地算出错误的验证码。
 */
export function normalizeSecret(raw: string): string {
  const cleaned = raw
    .replace(/[\s\-_]/g, '')
    .replace(/=+$/, '')
    .toUpperCase();

  if (!cleaned) throw new ValidationError('secret_empty');
  if (!/^[A-Z2-7]+$/.test(cleaned)) throw new ValidationError('secret_charset');
  // 8 个 Base32 字符 = 40 bit。比这更短的密钥基本可以断定是输错了
  if (cleaned.length < 8) throw new ValidationError('secret_too_short');

  return cleaned;
}

/** 校验并补全一份账号草稿，失败抛 ValidationError */
export function normalizeDraft(draft: AccountDraft): AccountDraft {
  const secret = draft.secret.startsWith(ENC_PREFIX)
    ? draft.secret
    : normalizeSecret(draft.secret);

  if (!ALGORITHMS.includes(draft.algorithm)) {
    throw new ValidationError('algorithm_unknown');
  }
  if (!Number.isInteger(draft.digits) || draft.digits < 6 || draft.digits > 10) {
    throw new ValidationError('digits_range');
  }
  if (!Number.isInteger(draft.period) || draft.period < 10 || draft.period > 300) {
    throw new ValidationError('period_range');
  }

  const issuer = draft.issuer.trim();
  const label = draft.label.trim();
  // issuer 与 label 至少要有一个，否则列表里会出现一行完全没有标识的条目
  if (!issuer && !label) throw new ValidationError('label_empty');

  return {
    ...draft,
    issuer,
    label,
    secret,
    domains: dedupeDomains(draft.domains ?? []),
  };
}

/** 去重、去空、小写化，并截断到上限 */
export function dedupeDomains(domains: string[]): string[] {
  const seen = new Set<string>();
  for (const d of domains) {
    const clean = d.trim().toLowerCase();
    if (clean) seen.add(clean);
    if (seen.size >= MAX_DOMAINS) break;
  }
  return [...seen];
}

/** 列表中展示用的标题 */
export function displayName(account: Pick<Account, 'issuer' | 'label'>): string {
  if (account.issuer && account.label) return `${account.issuer} (${account.label})`;
  return account.issuer || account.label;
}

/**
 * 生成账号 id。
 *
 * 不用 crypto.randomUUID：那是 36 个字符，而每个账号的存储键是
 * `acct:<id>`，键名本身也计入 sync 配额。10 位 base36 约 51 bit 熵，
 * 在几百条数据的量级下碰撞概率可以忽略。
 */
export function newAccountId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(10, '0').slice(0, 10);
}
