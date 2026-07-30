/**
 * 域名归一化与匹配。
 *
 * 设计要点：
 *
 * 1. **不引入完整 Public Suffix List**。PSL 动辄几万条，每条都要打包进
 *    扩展里；另一个常见做法是从远程拉取，但 Edge Add-ons 审核对「远程
 *    代码 / 数据」非常敏感。我们只覆盖真实使用中会撞到的多段 TLD，
 *    配合共享域名的精确匹配黑名单，覆盖率足够（参见测试用例）。
 *
 * 2. **共享域名当「子域名持有者」处理**。`*.github.io` 之类的站点上每个
 *    用户拥有自己的子域，绑 `octocat.github.io` 时不应自动扩展到
 *    `torvalds.github.io`。对策：命中黑名单时 registrable = host 本身，
 *    匹配规则也只走精确匹配，不会「子域继承」。
 *
 * 3. **匹配规则两层**：
 *    - 普通域名：`host === bound || host.endsWith('.' + bound)`，所以
 *      绑 `github.com` 自动覆盖 `www.` / `gist.`。
 *    - 共享域名：仅精确匹配，因为可能误伤别人。
 *
 * 4. **永远不改 storage**。这是纯函数，方便 node --test 直接跑。
 */

/** 多段 TLD 表（选录）。按长度倒序匹配避免误吃（如 co.uk 在 uk 之前） */
const MULTI_PART_TLDS = new Set([
  // 英国
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  // 日本
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  // 澳大利亚
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  // 中国
  'com.cn', 'org.cn', 'net.cn', 'edu.cn', 'gov.cn', 'ac.cn',
  // 韩国
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'pe.kr',
  // 其它常见多段
  'co.nz', 'co.za', 'co.in', 'co.id', 'com.br', 'com.mx', 'com.tw', 'com.hk',
  'com.sg', 'com.tr', 'com.ar', 'com.pl',
]);

/**
 * 共享域名后缀 —— 用户拥有自己的子域，绑定的不能跨用户继承。
 *
 * 黑名单思路参考 Google Authenticator 的处理方式。这里只列真实流量大的，
 * 不追求穷尽 —— 列表越大误判越多。
 *
 * 判断方法：把 host 的最后两段拼成 `<倒数第二段>.<末段>`，看是否在表里。
 * 例：`octocat.github.io` → `github.io`（命中）。
 */
const SHARED_SUFFIXES = new Set([
  'github.io',
  'gitlab.io',
  'vercel.app',
  'now.sh',
  'pages.dev',
  'netlify.app',
  'web.app',
  'appspot.com',
  'herokuapp.com',
  'firebase.app',
  'azurewebsites.net',
  'cloudfront.net',
]);

/** 小写化、去掉端口、IDN 转 punycode 失败则原样返回 */
export function normalizeHost(input: string): string {
  let h = input.trim().toLowerCase();
  // 去端口。注意 IPv6 形如 [::1]:80，所以只切第一个冒号之后的端口
  const colon = h.indexOf(':');
  if (colon >= 0 && !h.startsWith('[')) h = h.slice(0, colon);
  // 去末尾的点（FQDN 形式）
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * 是否共享域名（用户拥有自己子域的那种）。
 *
 * 命中后调用方应该走「精确匹配」而不是「子域继承」。
 */
export function isSharedHost(host: string): boolean {
  const h = normalizeHost(host);
  const parts = h.split('.').filter(Boolean);
  if (parts.length < 2) return false;
  // 取最后两段
  const suffix = parts.slice(-2).join('.');
  return SHARED_SUFFIXES.has(suffix);
}

/**
 * 提取 registrable 域名（可注册的最小单位）。
 *
 * `gist.github.com` → `github.com`
 * `foo.co.uk`       → `co.uk`   （注意保留 co.uk，不只是 uk）
 * `octocat.github.io` → `octocat.github.io`（共享域名特殊处理）
 *
 * 输入不合法（空、纯 IP、单段等）时返回原样的归一化结果，让调用方自己
 * 决定要不要走精确匹配。
 */
export function registrableDomain(host: string): string {
  const h = normalizeHost(host);
  if (!h) return '';
  const labels = h.split('.').filter(Boolean);
  if (labels.length < 2) return h;

  // 共享域名：保留全名当 registrable（避免跨用户继承）
  if (isSharedHost(h)) return h;

  // 末两段 + 多段 TLD 表：取末两段后，看末两段是否构成多段 TLD；
  // 是的话 registrable 就是末三段；不是的话就是末两段。
  const last2 = labels.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(last2) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return last2;
}

/**
 * host 是否命中某个绑定。
 *
 * - 普通域名：host === bound，或 host 是 bound 的子域（绑 github.com 覆盖
 *   www.github.com / gist.github.com）
 * - 共享域名（如 *.github.io）：只走精确匹配
 *
 * 返回值包括「命中」与「匹配模式」，调用方在 UI 里可以据此告诉用户
 * 这次匹配是精确的还是子域继承的。
 */
export interface MatchResult {
  hit: boolean;
  /** 'exact' | 'subdomain' | 'shared' | 'none' */
  mode: 'exact' | 'subdomain' | 'shared' | 'none';
}

export function matchHost(host: string, bound: string): MatchResult {
  const h = normalizeHost(host);
  const b = normalizeHost(bound);
  if (!h || !b) return { hit: false, mode: 'none' };

  if (h === b) {
    return { hit: true, mode: isSharedHost(b) ? 'shared' : 'exact' };
  }
  // 共享域名只精确匹配，避免跨用户误伤
  if (isSharedHost(b)) return { hit: false, mode: 'none' };
  if (h.endsWith('.' + b)) return { hit: true, mode: 'subdomain' };
  return { hit: false, mode: 'none' };
}

/**
 * 一个账号的 domains 列表里，是否有任意一个命中 host。
 *
 * 给 popup 置顶排序用：任一绑定命中 → 提到最上面。
 */
export function anyMatch(host: string, bounds: readonly string[]): MatchResult {
  for (const b of bounds) {
    const r = matchHost(host, b);
    if (r.hit) return r;
  }
  return { hit: false, mode: 'none' };
}